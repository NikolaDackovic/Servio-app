/**
 * ADMIN celine: cenovnik (kasa ga postavlja), happy hour, zalihe i stanje na dan, prodaja artikla,
 * spajanje i podela smene, izgled isečka, Excel za grupe.
 */
import ExcelJS from 'exceljs';
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown } from './setup';

let ctx: Ctx;
let admin: string, waiter: string, cashier: string;
const api = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  ctx = await setupApp();
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!', ctx.ids.posDevice);
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
  await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
});
afterAll(() => teardown(ctx));

const quickOrder = async (token: string) => (await ctx.http().post(api('/orders')).set(auth(token)).send({ idempotencyKey: idem('o') }).expect(201)).body;
const add = (o: any, pid: string, token = waiter) => ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(token)).send({ productId: pid, expectedVersion: o.version });

describe('Cenovnik i happy hour', () => {
  let listId: string, espresso: string, kapucino: string;
  it('cenovnik kopira cene; kasa ga postavlja; artikal van cenovnika nije dostupan', async () => {
    espresso = await productId(ctx, admin, 'K001'); kapucino = await productId(ctx, admin, 'K002');
    listId = (await ctx.http().post(api('/price-lists')).set(auth(admin)).send({ name: 'Nova godina' }).expect(201)).body.id;
    const l = (await ctx.http().get(api(`/price-lists/${listId}`)).set(auth(admin)).expect(200)).body;
    expect(l.items.find((i: any) => i.productId === espresso)).toMatchObject({ included: true, price: '180.00' });
    const items = l.items.filter((i: any) => i.productId !== kapucino).map((i: any) => ({ productId: i.productId, price: i.productId === espresso ? '250.00' : i.price }));
    await ctx.http().put(api(`/price-lists/${listId}/items`)).set(auth(admin)).send({ items }).expect(200);
    await ctx.http().put(api('/price-lists/kasa')).set(auth(cashier)).send({ priceListId: listId }).expect(200);
    const prices = (await ctx.http().get(api('/price-lists/kasa/prices')).set(auth(waiter)).expect(200)).body;
    expect(prices.priceList.name).toBe('Nova godina');
    expect(prices.prices[espresso]).toBe('250.00');
    expect(prices.hidden).toContain(kapucino);
    const o = await quickOrder(waiter);
    expect((await add(o, espresso).expect(201)).body.items[0].unitPrice).toBe('250.00');
    expect((await add(await quickOrder(waiter), kapucino).expect(409)).body.error.code).toBe('NOT_IN_PRICE_LIST');
    await ctx.http().put(api('/price-lists/kasa')).set(auth(cashier)).send({ priceListId: null }).expect(200);
  });

  it('happy hour: popust za grupu u zadatom vremenu', async () => {
    const cats = (await ctx.http().get(api('/categories')).set(auth(admin)).expect(200)).body;
    const kafa = cats.find((c: any) => c.name === 'Topli napici');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date());
    const h = (await ctx.http().post(api('/happy-hours')).set(auth(admin))
      .send({ name: 'Jutarnja kafa', dateFrom: today, dateTo: today, timeFrom: '00:00', timeTo: '23:59', categoryId: kafa.id, kind: 'PERCENT', value: '50' }).expect(201)).body;
    const o = await quickOrder(waiter);
    expect((await add(o, espresso).expect(201)).body.items[0].unitPrice).toBe('90.00');
    await ctx.http().delete(api(`/happy-hours/${h.id}`)).set(auth(admin)).expect(200);
    const bad = await ctx.http().post(api('/happy-hours')).set(auth(admin))
      .send({ name: 'X', dateFrom: today, dateTo: today, timeFrom: '10:00', timeTo: '11:00', categoryId: kafa.id, kind: 'PERCENT', value: '150' }).expect(422);
    expect(bad.body.error.code).toBe('HAPPY_PERCENT');
    expect((await add(await quickOrder(waiter), espresso).expect(201)).body.items[0].unitPrice).toBe('180.00');
  });
});

describe('Zalihe, stanje na dan, prodaja artikla', () => {
  it('zalihe sa minimalnom zalihom; stanje na dan; kartica prodaje', async () => {
    const kisela = await productId(ctx, admin, 'S003');
    await ctx.http().patch(api(`/products/${kisela}`)).set(auth(admin)).send({ minStock: '1000' }).expect(200);
    const levels = (await ctx.http().get(api('/stock/levels')).set(auth(admin)).expect(200)).body;
    expect(levels.find((x: any) => x.productId === kisela)).toMatchObject({ belowMin: true });
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    expect(Array.isArray((await ctx.http().get(api(`/stock/as-of?date=${tomorrow}`)).set(auth(admin)).expect(200)).body)).toBe(true);

    let o = await quickOrder(waiter);
    o = (await add(o, kisela).expect(201)).body;
    await ctx.http().post(api(`/orders/${o.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CASH' }], idempotencyKey: idem('p') }).expect(201);
    const day = (await ctx.http().get(api('/business-days/current')).set(auth(admin)).expect(200)).body.day;
    const s = (await ctx.http().get(api(`/reports/product-sales?productId=${kisela}&from=${day.date}&to=${day.date}`)).set(auth(admin)).expect(200)).body;
    expect(Number(s.totals.quantity)).toBeGreaterThanOrEqual(1);

    // Kartica proizvoda: artikal na zalihi ima kretanja sa stanjem; prodaja je dokument KS-<broj računa>
    const card = (await ctx.http().get(api(`/reports/product-card?productId=${kisela}&from=${day.date}&to=${day.date}`)).set(auth(admin)).expect(200)).body;
    expect(card.tracked).toBe(true);
    expect(card.rows.at(-1)).toMatchObject({ document: `KS-${o.number}`, out: '1.000' });
    expect(Number(card.closing)).toBe(Number(card.opening) - Number(card.totals.out) + Number(card.totals.in));
    // artikal koji se ne prati na zalihi: prodaja sa kase
    const esp = await productId(ctx, admin, 'K001');
    const card2 = (await ctx.http().get(api(`/reports/product-card?productId=${esp}&from=${day.date}&to=${day.date}`)).set(auth(admin)).expect(200)).body;
    expect(card2.tracked).toBe(false);
    expect(card2.rows.every((r: any) => r.document.startsWith('KS-'))).toBe(true);
  });
});

describe('Izgled isečka, Excel za grupe', () => {
  it('tekst na vrhu i dnu i logo idu u zadatak štampe računa', async () => {
    const logo = { width: 8, height: 2, data: Buffer.from([0xff, 0x81]).toString('base64') };
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ receiptHeader: 'PIB 100000024', receiptFooter: 'Hvala!', receiptLogo: logo, ticketLarge: false }).expect(200);
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ receiptLogo: { width: 7, height: 2, data: 'AA==' } }).expect(422);
    const o = (await ctx.http().get(api('/orders?status=PAID&pageSize=1')).set(auth(admin)).expect(200)).body[0];
    const r = (await ctx.http().post(api(`/orders/${o.id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: idem('r') }).expect(201)).body;
    expect(r.job.payload).toMatchObject({ header: 'PIB 100000024', footer: 'Hvala!', logo });
  });

  it('grupe: izvoz i uvoz iz Excel-a', async () => {
    const w = new ExcelJS.Workbook(); const s = w.addWorksheet('Grupe');
    s.addRow(['Grupa', 'Kategorija', 'Boja', 'Redosled']); s.addRow(['Kokteli', 'Šank', '#17181A', '9']);
    const r = (await ctx.http().post(api('/categories/import')).set(auth(admin)).send({ fileName: 'g.xlsx', contentBase64: Buffer.from(await w.xlsx.writeBuffer()).toString('base64') }).expect(200)).body;
    expect(r).toEqual({ created: 1, updated: 0 });
    const cats = (await ctx.http().get(api('/categories')).set(auth(admin)).expect(200)).body;
    expect(cats.find((c: any) => c.name === 'Kokteli')).toMatchObject({ color: '#17181A', sortOrder: 9 });
    await ctx.http().get(api('/categories/export?format=csv')).set(auth(admin)).expect(200);
  });
});

describe('Spajanje i podela smene', () => {
  it('podela otvorene smene u vreme preseka, pa spajanje dve zatvorene', async () => {
    const day = (await ctx.http().get(api('/business-days/current')).set(auth(admin)).expect(200)).body.day;
    const tomorrow = new Date(Date.parse(day.date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    // presek u budućnosti nije moguć za još otvorenu smenu bez zatvaranja: presek posle otvaranja, sada
    const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Belgrade', dateStyle: 'short', timeStyle: 'short' }).format(new Date(Date.now() + 60_000)).replace(' ', 'T');
    const sp = (await ctx.http().post(api(`/business-days/${day.id}/split`)).set(auth(admin)).send({ at: now }).expect(200)).body;
    expect(sp.after.status).toBe('OPEN');
    const cur = (await ctx.http().get(api('/business-days/current')).set(auth(admin)).expect(200)).body.day;
    expect(cur.id).toBe(sp.after.id);
    expect(tomorrow > day.date).toBe(true);
    // obe zatvorene → spajanje
    await ctx.pool.query(`UPDATE orders SET status = 'CANCELLED' WHERE status = 'OPEN'`);
    await ctx.http().post(api('/shifts/close')).set(auth(cashier)).send({}).expect(200);
    await ctx.http().post(api('/business-days/current/close')).set(auth(cashier)).expect(200);
    const m = (await ctx.http().post(api('/business-days/merge')).set(auth(admin)).send({ targetId: sp.after.id, sourceId: day.id }).expect(200)).body;
    expect(m.id).toBe(day.id); // ostaje početna smena i kad se izabere obrnuto
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM business_days WHERE id = $1', [sp.after.id]);
    expect(rows[0].n).toBe(0);
  });
});

// Posle ovoga u fajlu nema prijava PIN-om: kasa ostaje zaključana minut.
describe('Pogrešni PIN-ovi', () => {
  it('uspešne prijave nisu ograničene; posle 5 pogrešnih kasa se zaključava', async () => {
    for (let i = 0; i < 15; i++) await pinLogin(ctx, '1111');
    const pin = (p: string) => ctx.http().post(api('/auth/pin')).send({ deviceId: ctx.ids.posDevice, pin: p });
    for (let i = 0; i < 5; i++) await pin('80808080').expect(401);
    expect((await pin('1111').expect(429)).body.error.code).toBe('RATE_LIMITED');
  });
});

describe('Podešavanja po računaru', () => {
  it('kasa ima svoje skrivene grupe i funkcije; novi računar; zaštite', async () => {
    const list = (await ctx.http().get(api('/computers')).set(auth(admin)).expect(200)).body;
    const pos = list.find((d: any) => d.id === ctx.ids.posDevice);
    expect(pos.settings).toMatchObject({ hiddenGroups: [], hiddenFeatures: [], fiscal: { useVpfr: false, lpfrUrl: '' } });
    const cats = (await ctx.http().get(api('/categories')).set(auth(admin)).expect(200)).body;
    const hrana = cats.find((c: any) => c.name === 'Hrana').id;
    await ctx.http().patch(api(`/computers/${pos.id}`)).set(auth(admin)).send({ name: 'Kasa šank', settings: { hiddenGroups: [hrana], hiddenFeatures: ['storno', 'endOfDay'] } }).expect(200);
    const mine = (await ctx.http().get(api('/computers/me')).set(auth(waiter)).expect(200)).body;
    expect(mine).toMatchObject({ device: { name: 'Kasa šank' }, settings: { hiddenGroups: [hrana], hiddenFeatures: ['storno', 'endOfDay'] } });
    await ctx.http().patch(api(`/computers/${pos.id}`)).set(auth(admin)).send({ settings: { hiddenFeatures: ['nepostojeca'] } }).expect(400);
    await ctx.http().patch(api(`/computers/${pos.id}`)).set(auth(cashier)).send({ active: false }).expect(403);
    const k = (await ctx.http().post(api('/computers')).set(auth(admin)).send({ name: 'KDS Šank', kind: 'KDS' }).expect(201)).body;
    expect(k).toMatchObject({ kind: 'KDS', active: true });
    expect((await ctx.http().post(api('/computers')).set(auth(admin)).send({ name: 'KDS Šank', kind: 'KDS' }).expect(409)).body.error.code).toBe('DEVICE_NAME_TAKEN');
    await ctx.http().patch(api(`/computers/${pos.id}`)).set(auth(admin)).send({ settings: { hiddenGroups: [], hiddenFeatures: [] } }).expect(200);
  });
});

describe('Pregled proizvoda: nabavna cena, gde je u normativu, dnevnik promena', () => {
  it('nabavna cena artikla iz normativa; sirovina zna gde se troši; promene proizvoda su u dnevniku', async () => {
    const kafa = await productId(ctx, admin, 'R001');   // sirovina, kg
    const espresso = await productId(ctx, admin, 'K001'); // normativ: 0,008 kg kafe; PDV 20%
    const wh = (await ctx.pool.query('SELECT id FROM warehouses LIMIT 1')).rows[0].id;
    await ctx.pool.query(`INSERT INTO stock_balances (warehouse_id, product_id, quantity, avg_cost) VALUES ($1, $2, 10, 2000)
      ON CONFLICT (warehouse_id, product_id) DO UPDATE SET quantity = 10, avg_cost = 2000`, [wh, kafa]);
    const costs = (await ctx.http().get(api('/products/costs')).set(auth(admin)).expect(200)).body;
    expect(costs.find((c: any) => c.productId === espresso)).toMatchObject({ cost: '16.0000', costWithVat: '19.20' });
    const used = (await ctx.http().get(api(`/products/${kafa}/used-in`)).set(auth(admin)).expect(200)).body;
    expect(used.map((x: any) => x.code)).toContain('K001');
    await ctx.http().patch(api(`/products/${espresso}`)).set(auth(admin)).send({ price: '200.00' }).expect(200);
    const log = (await ctx.http().get(api(`/audit-logs?entity=product&entityId=${espresso}`)).set(auth(admin)).expect(200)).body;
    expect(log[0]).toMatchObject({ entity: 'product', user: expect.any(String) });
    expect(log.some((x: any) => x.action === 'product.price.change' && x.data.to === '200.00')).toBe(true);
    await ctx.http().get(api('/audit-logs')).set(auth(waiter)).expect(403);
    await ctx.http().patch(api(`/products/${espresso}`)).set(auth(admin)).send({ price: '180.00' }).expect(200);
  });
});
