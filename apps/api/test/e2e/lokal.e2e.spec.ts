/**
 * Rad u lokalu: automatske šifre proizvoda, ulazna otpremnica (UO), hotelske sobe (dan se zatvara uz otvorenu sobu),
 * štampač priključen na određeni računar, fiskalna podešavanja po kasi, izbor kase, reprezentacija skida sa stanja,
 * lokalna registracija Print Bridge-a glavne kase.
 */
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown } from './setup';

let ctx: Ctx;
let admin: string, waiter: string, cashier: string, manager: string;
const api = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  ctx = await setupApp();
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!', ctx.ids.posDevice);
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  manager = await pinLogin(ctx, '9999');
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
  await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
});
afterAll(() => teardown(ctx));

const stockOf = async (pid: string) => Number((await ctx.pool.query('SELECT coalesce(sum(quantity),0) AS q FROM stock_balances WHERE product_id = $1', [pid])).rows[0].q);

describe('Proizvodi i dokumenta', () => {
  it('šifra se dodeljuje automatski (sledeći broj) kada nije uneta', async () => {
    const cats = (await ctx.http().get(api('/categories')).set(auth(admin)).expect(200)).body;
    const taxes = (await ctx.http().get(api('/tax-rates')).set(auth(admin)).expect(200)).body;
    const base = { name: 'Fanta 0,25', price: '250.00', categoryId: cats[0].id, taxRateId: taxes[0].id };
    const a = (await ctx.http().post(api('/products')).set(auth(admin)).send(base).expect(201)).body;
    const b = (await ctx.http().post(api('/products')).set(auth(admin)).send({ ...base, name: 'Sprite 0,25' }).expect(201)).body;
    expect(Number(b.code)).toBe(Number(a.code) + 1);
    expect((await ctx.http().post(api('/products')).set(auth(admin)).send({ ...base, name: 'Ručna', code: 'X-7' }).expect(201)).body.code).toBe('X-7');
  });

  it('ulazna otpremnica (UO) povećava stanje kao i ulazna faktura; prodaja bez stanja ide u minus', async () => {
    const kisela = await productId(ctx, admin, 'S003');
    const supplier = (await ctx.http().get(api('/partners')).set(auth(admin)).expect(200)).body[0].id;
    const before = await stockOf(kisela);
    const d = (await ctx.http().post(api('/stock/documents')).set(auth(manager)).send({ kind: 'RECEIPT_NOTE', warehouseId: ctx.ids.warehouses.main, partnerId: supplier }).expect(201)).body;
    await ctx.http().put(api(`/stock/documents/${d.id}/lines`)).set(auth(manager)).send({ lines: [{ productId: kisela, quantity: '24', unitCost: '60.00' }] }).expect(200);
    const p = (await ctx.http().post(api(`/stock/documents/${d.id}/post`)).set(auth(manager)).send({}).expect(200)).body;
    expect(p.displayNumber).toBe('UO-1');
    expect(await stockOf(kisela)).toBe(before + 24);
  });

  it('reprezentacija (čast kuće) skida robu sa stanja', async () => {
    const kisela = await productId(ctx, admin, 'S003');
    const before = await stockOf(kisela);
    const o = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: idem('o') }).expect(201)).body;
    await ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(waiter)).send({ productId: kisela }).expect(201);
    await ctx.http().post(api(`/orders/${o.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'REPRESENTATION', note: 'Osoblje' }], idempotencyKey: idem('rep') }).expect(201);
    expect(await stockOf(kisela)).toBe(before - 1);
    // račun: regularan po PU (reprezentacija = posebno plaćanje, razlog ostaje u evidenciji)
    const p = (await ctx.http().post(api(`/orders/${o.id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: idem('r') }).expect(201)).body.job.payload;
    expect(p.payments[0]).toMatchObject({ method: 'REPRESENTATION', note: 'Osoblje' });
    expect(p.fiscalLayout).toMatchObject({ representation: false, transaction: 'ОБУКА ПРОДАЈА' });
  });
});

describe('Hotel: sobe', () => {
  it('otvoren račun na sobi ne blokira zatvaranje smene ni dana; naplaćuje se u sledećem danu', async () => {
    const tables = (await ctx.http().get(api('/tables')).set(auth(admin)).expect(200)).body;
    const room = tables.find((t: any) => t.name === 'Sto 8');
    await ctx.http().patch(api(`/tables/${room.id}`)).set(auth(admin)).send({ isRoom: true }).expect(200);
    const espresso = await productId(ctx, admin, 'K001');
    const o = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ tableId: room.id, idempotencyKey: idem('room') }).expect(201)).body;
    await ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(waiter)).send({ productId: espresso }).expect(201);

    await ctx.http().post(api('/shifts/close')).set(auth(cashier)).send({}).expect(200);
    await ctx.http().post(api('/business-days/current/close')).set(auth(cashier)).expect(200);
    const still = (await ctx.http().get(api(`/orders/${o.id}`)).set(auth(manager)).expect(200)).body;
    expect(still.status).toBe('OPEN');

    const next = (await ctx.http().get(api('/business-days/next')).set(auth(cashier)).expect(200)).body;
    await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({ name: next.name }).expect(201);
    await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
    const day2 = (await ctx.http().get(api('/business-days/current')).set(auth(manager)).expect(200)).body.day;
    await ctx.http().post(api(`/orders/${o.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CASH' }], idempotencyKey: idem('checkout') }).expect(201);
    const paid = (await ctx.pool.query('SELECT status, business_day_id FROM orders WHERE id = $1', [o.id])).rows[0];
    expect(paid).toEqual({ status: 'PAID', business_day_id: day2.id });
  });
});

describe('Štampa i računari', () => {
  it('štampač priključen na računar štampa samo Print Bridge tog računara', async () => {
    const b2 = (await ctx.http().post(api('/print-bridges')).set(auth(admin)).send({ name: 'Štampa POS-PC2' }).expect(201)).body;
    const pr = (await ctx.http().post(api('/printers')).set(auth(admin))
      .send({ name: 'Bixolon PC2', connection: 'SIMULATED', paperWidth: 80, bridgeDeviceId: b2.id }).expect(201)).body;
    expect(pr.bridgeDeviceId).toBe(b2.id);
    await ctx.http().post(api(`/printers/${pr.id}/test`)).set(auth(admin)).send({}).expect(201);
    const claim = (key: string) => ctx.http().post(api('/bridge/jobs/claim')).set('X-Bridge-Key', key).send({ limit: 20 }).expect(200);
    const other = (await claim(ctx.ids.bridgeKey)).body.jobs;
    expect(other.some((j: any) => j.printer?.id === pr.id || j.printerId === pr.id)).toBe(false);
    const mine = (await claim(b2.apiKey)).body.jobs;
    expect(mine.length).toBeGreaterThan(0);
    await ctx.http().post(api('/printers')).set(auth(admin)).send({ name: 'Loš', connection: 'SIMULATED', bridgeDeviceId: ctx.ids.posDevice }).expect(422);
  });

  it('fiskalna podešavanja po kasi (LPFR/VPFR, PIN, JID); kasa ne vidi PIN', async () => {
    await ctx.http().patch(api(`/computers/${ctx.ids.posDevice}`)).set(auth(admin))
      .send({ settings: { fiscal: { useVpfr: false, lpfrUrl: 'localhost:5555', pin: '1234', jid: 'ABCD1234' } } }).expect(200);
    const list = (await ctx.http().get(api('/computers')).set(auth(admin)).expect(200)).body;
    expect(list.find((d: any) => d.id === ctx.ids.posDevice).settings.fiscal).toMatchObject({ lpfrUrl: 'localhost:5555', pin: '1234', jid: 'ABCD1234', useVpfr: false });
    const me = (await ctx.http().get(api('/computers/me')).set(auth(waiter)).expect(200)).body;
    expect(me.settings.fiscal).toBeUndefined();
    await ctx.http().patch(api(`/computers/${ctx.ids.posDevice}`)).set(auth(admin)).send({ settings: { fiscal: { lpfrUrl: 'nije adresa' } } }).expect(400);
  });

  it('više kasa u lokalu: spisak za izbor; lokalna registracija štampe samo sa tokenom', async () => {
    await ctx.http().post(api('/computers')).set(auth(admin)).send({ name: 'POS-PC2', kind: 'POS' }).expect(201);
    const k = (await ctx.http().get(api('/auth/kasa')).expect(200)).body;
    expect(k.devices.map((d: any) => d.name)).toEqual(expect.arrayContaining(['Kasa 1 - Šank', 'POS-PC2']));
    await ctx.http().post(api('/setup/local-bridge')).send({ name: 'X' }).expect(403);
    await ctx.http().post(api('/setup/local-bridge')).set('x-local-token', 'pogresan-token-pogresan-token-pogresan').send({ name: 'X' }).expect(403);
  });
});

describe('Podešavanja kase', () => {
  it('snimanje jednog polja ne briše ostala', async () => {
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ ticketLarge: false, pinPerTable: false, pib: '100000024' }).expect(200);
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ receiptFooter: 'Hvala!' }).expect(200);
    const s = (await ctx.http().get(api('/settings/kasa')).set(auth(admin)).expect(200)).body;
    expect(s).toMatchObject({ ticketLarge: false, pinPerTable: false, pib: '100000024', receiptFooter: 'Hvala!' });
  });
});
