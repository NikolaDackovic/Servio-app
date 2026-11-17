/**
 * Ekrani po uzoru na Octopos: korekcija zalihe (+/-), zaglavlje dokumenta (datum valute, interna napomena, rabat),
 * specifikacija izdatih artikala, kartica sa komitentom i cenama, kraj računa (tekst, slika, period) i štampa po računaru.
 */
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown } from './setup';

let ctx: Ctx;
let admin: string, waiter: string, cashier: string, manager: string;
let kafa: string, mleko: string, espresso: string, supplier: string, MAIN: string;
const api = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  ctx = await setupApp();
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!', ctx.ids.posDevice);
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  manager = await pinLogin(ctx, '9999');
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
  await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
  [kafa, mleko, espresso] = await Promise.all(['R001', 'R002', 'K001'].map((c) => productId(ctx, manager, c)));
  supplier = (await ctx.http().get(api('/partners')).set(auth(manager)).expect(200)).body[0].id;
  MAIN = ctx.ids.warehouses.main;
});
afterAll(() => teardown(ctx));

const bal = async (pid: string) => Number((await ctx.pool.query('SELECT quantity FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2', [MAIN, pid])).rows[0]?.quantity ?? 0);
async function doc(kind: string, lines: any[], extra: any = {}, status = 200) {
  const d = (await ctx.http().post(api('/stock/documents')).set(auth(manager)).send({ kind, warehouseId: MAIN, ...extra }).expect(201)).body;
  return (await ctx.http().put(api(`/stock/documents/${d.id}/lines`)).set(auth(manager)).send({ lines }).expect(status)).body;
}
const sell = async (method: string) => {
  const o = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: idem('o') }).expect(201)).body;
  await ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(waiter)).send({ productId: espresso }).expect(201);
  return (await ctx.http().post(api(`/orders/${o.id}/settle`)).set(auth(cashier)).send({ parts: [{ method }], idempotencyKey: idem('p') }).expect(201)).body.order;
};

describe('Robna dokumenta', () => {
  it('ulazna faktura čuva datum valute, internu napomenu i rabat po stavci', async () => {
    const d = (await doc('RECEIPT', [{ productId: kafa, quantity: '10', unitCost: '90', discountPercent: '10' }, { productId: mleko, quantity: '5', unitCost: '50' }],
      { partnerId: supplier, dueDate: '2026-12-01', internalNote: 'platiti do 1.12.', externalNumber: 'F-77' }));
    expect(d.dueDate).toBe('2026-12-01');
    expect(d.internalNote).toBe('platiti do 1.12.');
    expect(d.lines.find((l: any) => l.productId === kafa).discountPercent).toBe('10.00');
    await ctx.http().post(api(`/stock/documents/${d.id}/post`)).set(auth(manager)).send({}).expect(200);
  });

  it('korekcija zalihe: -2 kafa, +3 mleko (npr. dat pogrešan artikal); minus ispod stanja i 0 se odbijaju', async () => {
    const k0 = await bal(kafa), m0 = await bal(mleko);
    const d = (await doc('CORRECTION', [{ productId: kafa, quantity: '-2' }, { productId: mleko, quantity: '3' }]));
    const p = (await ctx.http().post(api(`/stock/documents/${d.id}/post`)).set(auth(manager)).send({}).expect(200)).body;
    expect(p.displayNumber).toMatch(/^KOR-\d+$/);
    expect(await bal(kafa)).toBeCloseTo(k0 - 2);
    expect(await bal(mleko)).toBeCloseTo(m0 + 3);
    const big = (await doc('CORRECTION', [{ productId: kafa, quantity: '-9999' }]));
    await ctx.http().post(api(`/stock/documents/${big.id}/post`)).set(auth(manager)).send({}).expect(422);
    await doc('CORRECTION', [{ productId: kafa, quantity: '0' }], {}, 422);
    await doc('WRITE_OFF', [{ productId: kafa, quantity: '-1' }], {}, 422);
  });

  it('kartica proizvoda: komitent i nabavna cena kod ulaza', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date());
    const c = (await ctx.http().get(api(`/reports/product-card?productId=${kafa}&from=${today}&to=${today}`)).set(auth(manager)).expect(200)).body;
    const uf = c.rows.find((r: any) => r.document.startsWith('UF-'));
    expect(uf.partner).toBeTruthy();
    expect(Number(uf.unitCost)).toBeCloseTo(90);
    expect(c.rows.some((r: any) => r.document.startsWith('KOR-') && r.out === '2.000')).toBe(true);
  });
});

describe('Specifikacija izdatih artikala i pretraga računa', () => {
  it('prodato po artiklu, korisniku i vrsti računa; lista računa ima količinu i broj isečka', async () => {
    await sell('CASH'); await sell('CASH'); await sell('REPRESENTATION');
    const day = (await ctx.pool.query("SELECT id FROM business_days WHERE status = 'OPEN' LIMIT 1")).rows[0].id;
    const rows = (await ctx.http().get(api(`/reports/sold-items?dayIds=${day}`)).set(auth(manager)).expect(200)).body as any[];
    const esp = rows.filter((r) => r.productId === espresso);
    expect(esp.filter((r) => r.kind === 'regular').reduce((a, r) => a + Number(r.quantity), 0)).toBe(2);
    expect(esp.filter((r) => r.kind === 'representation').reduce((a, r) => a + Number(r.quantity), 0)).toBe(1);
    expect(esp[0].waiter).toBeTruthy();
    await ctx.http().get(api('/reports/sold-items?dayIds=xyz')).set(auth(manager)).expect(400);
    await ctx.http().get(api(`/reports/sold-items?dayIds=${day}&timeFrom=00:00&timeTo=23:59`)).set(auth(waiter)).expect(403);
    const list = (await ctx.http().get(api(`/orders?dayIds=${day}&pageSize=50`)).set(auth(manager)).expect(200)).body as any[];
    expect(Number(list.find((o) => o.status === 'PAID').itemQty)).toBe(1);
    expect('fiscalNumber' in list[0]).toBe(true);
  });
});

describe('Kraj računa i štampa po računaru', () => {
  it('tekst i slika na kraju računa samo u periodu; računar može isključiti logo', async () => {
    const img = { width: 8, height: 1, data: 'gA==' };
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ receiptFooter: 'Srećni praznici', receiptFooterImage: img, receiptLogo: img, receiptExtraFrom: '2000-01-01', receiptExtraTo: '2000-01-02' }).expect(200);
    const o = await sell('CASH');
    let p = (await ctx.http().post(api(`/orders/${o.id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: idem('r') }).expect(201)).body.job.payload;
    expect(p.footer).toBeNull();
    expect(p.footerImage).toBeNull();
    expect(p.logo).toEqual(img);
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ receiptExtraFrom: '', receiptExtraTo: '' }).expect(200);
    await ctx.http().patch(api(`/computers/${ctx.ids.posDevice}`)).set(auth(admin)).send({ settings: { print: { logoOnReceipt: false } } }).expect(200);
    p = (await ctx.http().post(api(`/orders/${o.id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: idem('r') }).expect(201)).body.job.payload;
    expect(p.footer).toBe('Srećni praznici');
    expect(p.footerImage).toEqual(img);
    expect(p.logo).toBeNull();
    const pc = (await ctx.http().get(api('/computers')).set(auth(admin)).expect(200)).body.find((d: any) => d.id === ctx.ids.posDevice);
    expect(pc.settings.print).toEqual({ logoOnReceipt: false, footerOnReceipt: true, autoReceipt: true });
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ receiptFooterImage: { width: 8, height: 2, data: 'gA==' } }).expect(422);
  });
});

describe('Pretraga računa, storno iz ADMIN-a, reprezentacija', () => {
  it('pregled isečka, vreme štampanja, povraćaj iz ADMIN-a (bez kase) i dva izgleda reprezentacije', async () => {
    const adminPin = (await ctx.http().post(api('/auth/admin-pin')).send({ pin: '0000' }).expect(200)).body.accessToken;
    const o = await sell('CASH');
    const prev = (await ctx.http().get(api(`/orders/${o.id}/receipt-preview`)).set(auth(adminPin)).expect(200)).body.payload;
    expect(prev.fiscalLayout).toBeTruthy();
    expect(prev.copy).toBe(false);
    // konobar vidi isečak svog računa (kasa F2), tuđi ne
    await ctx.http().get(api(`/orders/${o.id}/receipt-preview`)).set(auth(waiter)).expect(200);
    const other = (await ctx.http().post(api('/orders')).set(auth(manager)).send({ idempotencyKey: idem('o') }).expect(201)).body;
    await ctx.http().get(api(`/orders/${other.id}/receipt-preview`)).set(auth(waiter)).expect(404);
    await ctx.http().post(api(`/orders/${o.id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: idem('r') }).expect(201);
    const day = (await ctx.pool.query("SELECT id FROM business_days WHERE status = 'OPEN' LIMIT 1")).rows[0].id;
    const row = ((await ctx.http().get(api(`/orders?dayIds=${day}&pageSize=200`)).set(auth(manager)).expect(200)).body as any[]).find((x) => x.id === o.id);
    expect(row.printedAt).toBeTruthy();
    const rr = await ctx.http().post(api(`/orders/${o.id}/refunds`)).set(auth(adminPin)).send({ reason: 'Storno iz ADMIN-a', idempotencyKey: idem('rf') });
    if (rr.status !== 201) throw new Error(JSON.stringify(rr.body));
    const rf = rr.body;
    expect(rf.deviceId).toBe(ctx.ids.posDevice);
    const pc = (await ctx.http().get(api('/computers')).set(auth(admin)).expect(200)).body.find((d: any) => d.id === ctx.ids.posDevice);
    expect(pc.settings.print.autoReceipt).toBe(true);

    const rep = await sell('REPRESENTATION');
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ representationPrint: 'SLIP' }).expect(200);
    let p = (await ctx.http().post(api(`/orders/${rep.id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: idem('r') }).expect(201)).body.job.payload;
    expect(p.repStyle).toBe('SLIP');
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ representationPrint: 'FISCAL' }).expect(200);
    p = (await ctx.http().post(api(`/orders/${rep.id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: idem('r') }).expect(201)).body.job.payload;
    expect(p.fiscalLayout.representationNote).toMatch(/РЕПРЕЗЕНТАЦИЈА/);
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ representationPrint: 'X' }).expect(400);
  });
});

describe('Kasa bez šifre, popis za raniji dan, prodaja na kraju dana, redosled kategorija', () => {
  it('podrazumevani korisnik kase: prijava bez šifre; bez podešavanja 401', async () => {
    await ctx.http().post(api('/auth/default-login')).send({ deviceId: ctx.ids.posDevice }).expect(401);
    const users = (await ctx.http().get(api('/users')).set(auth(admin)).expect(200)).body as any[];
    const marko = users.find((x: any) => x.fullName === 'Marko Konobar');
    await ctx.http().patch(api(`/computers/${ctx.ids.posDevice}`)).set(auth(admin)).send({ settings: { defaultUserId: marko.id } }).expect(200);
    const r = (await ctx.http().post(api('/auth/default-login')).send({ deviceId: ctx.ids.posDevice }).expect(200)).body;
    expect(r.user.fullName).toBe('Marko Konobar');
    expect(r.deviceId).toBe(ctx.ids.posDevice);
    await ctx.http().patch(api(`/computers/${ctx.ids.posDevice}`)).set(auth(admin)).send({ settings: { defaultUserId: null } }).expect(200);
    await ctx.http().post(api('/auth/default-login')).send({ deviceId: ctx.ids.posDevice }).expect(401);
  });

  it('popis za raniji (zatvoren) dan se knjiži i dok je današnja smena otvorena; očekivano = stanje na kraju tog dana', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date());
    const y = new Date(`${today}T12:00:00Z`); y.setUTCDate(y.getUTCDate() - 1);
    const yesterday = y.toISOString().slice(0, 10);
    const now = await doc('STOCKTAKE', [{ productId: mleko, quantity: '1' }], { docDate: today });
    await ctx.http().post(api(`/stock/documents/${now.id}/post`)).set(auth(manager)).send({}).expect(409);
    const before = await bal(mleko);
    const past = await doc('STOCKTAKE', [{ productId: mleko, quantity: '5' }], { docDate: yesterday });
    const p = (await ctx.http().post(api(`/stock/documents/${past.id}/post`)).set(auth(manager)).send({}).expect(200)).body;
    expect(Number(p.lines[0].bookQuantity)).toBe(0); // juče mleka nije bilo (primljeno danas)
    expect(await bal(mleko)).toBeCloseTo(before + 5);
    const c = (await ctx.http().get(api(`/reports/product-card?productId=${mleko}&from=${today}&to=${today}`)).set(auth(manager)).expect(200)).body;
    expect(c.rows.some((r: any) => r.document.startsWith('PO-') && r.in === '5.000')).toBe(true);
  });

  it('kraj dana: prodaja na jednom isečku (ukupno, pa kategorije redom); redosled kategorija se menja', async () => {
    const st = (await ctx.http().get(api('/prep-stations')).set(auth(admin)).expect(200)).body as any[];
    const rev = [...st].reverse().map((s) => s.id);
    const after = (await ctx.http().put(api('/prep-stations/order')).set(auth(admin)).send({ ids: rev }).expect(200)).body as any[];
    expect(after.map((s) => s.id)).toEqual(rev);
    await sell('CASH');
    const job = (await ctx.http().post(api('/business-days/current/print-sales')).set(auth(cashier)).send({ idempotencyKey: idem('ps') }).expect(201)).body.job;
    expect(job.payload.mode).toBe('SALES');
    expect(Number(job.payload.total.quantity)).toBeGreaterThan(0);
    expect(job.payload.stations.length).toBeGreaterThan(0);
    await ctx.http().post(api('/business-days/current/print-sales')).set(auth(waiter)).send({ idempotencyKey: idem('ps') }).expect(403);
  });
});
