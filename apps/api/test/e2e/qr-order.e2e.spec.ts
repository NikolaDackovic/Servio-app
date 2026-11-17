/**
 * QR naručivanje: meni za sto bez prijave, porudžbina gosta ide u pripremu i na račun stola, konobar preuzima i naplaćuje.
 */
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown } from './setup';

let ctx: Ctx;
let admin: string, waiter: string, cashier: string;
const api = (p: string) => `/api/v1${p}`;
let tables: any[];

beforeAll(async () => {
  ctx = await setupApp();
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!', ctx.ids.posDevice);
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  tables = (await ctx.http().get(api('/tables')).set(auth(admin)).expect(200)).body;
});
afterAll(() => teardown(ctx));

const order = (token: string, items: any[], key = idem('qr')) => ctx.http().post(api(`/public/qr/${token}/order`)).send({ items, idempotencyKey: key });

describe('QR naručivanje', () => {
  it('svaki sto ima svoj token; meni bez prijave; nepostojeći token 404', async () => {
    expect(tables.every((t) => /^[0-9a-f]{20}$/.test(t.qrToken))).toBe(true);
    expect(new Set(tables.map((t) => t.qrToken)).size).toBe(tables.length);
    const m = (await ctx.http().get(api(`/public/qr/${tables[0].qrToken}`)).expect(200)).body;
    expect(m.table).toBe(tables[0].name);
    expect(m.products.length).toBeGreaterThan(5);
    expect(m.products[0]).toHaveProperty('price');
    expect(m.categories.length).toBeGreaterThan(0);
    await ctx.http().get(api('/public/qr/nepostoji12345')).expect(404);
  });

  it('dan nije otvoren: porudžbina se odbija sa jasnom porukom', async () => {
    const espresso = await productId(ctx, admin, 'K001');
    const r = await order(tables[0].qrToken, [{ productId: espresso, quantity: 1 }]).expect(409);
    expect(r.body.error.code).toBe('QR_CLOSED');
  });

  it('prazan sto: račun "Gost (QR)" sa poslatim stavkama; dupli klik ne duplira; konobar preuzima i naplaćuje', async () => {
    await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
    await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
    const espresso = await productId(ctx, admin, 'K001');
    const t = tables[1];
    const key = idem('qr');
    const r = (await order(t.qrToken, [{ productId: espresso, quantity: 2, note: 'bez šećera' }], key).expect(200)).body;
    expect(r).toMatchObject({ ok: true, items: 2 });
    await order(t.qrToken, [{ productId: espresso, quantity: 2 }], key).expect(200); // isti ključ
    const tt = (await ctx.http().get(api('/tables')).set(auth(admin)).expect(200)).body.find((x: any) => x.id === t.id);
    expect(tt.openOrders).toHaveLength(1);
    expect(tt.openOrders[0]).toMatchObject({ qrGuest: true, waiterName: 'Gost (QR)' });
    const o = (await ctx.http().get(api(`/orders/${tt.openOrders[0].id}`)).set(auth(admin)).expect(200)).body;
    expect(o.items).toHaveLength(1);
    expect(o.items[0]).toMatchObject({ quantity: '2.000', status: 'SENT', note: 'bez šećera' });
    // KDS/štampa: porudžbina je otišla u pripremu
    const tickets = (await ctx.pool.query('SELECT count(*)::int c FROM kds_tickets WHERE order_id = $1', [o.id])).rows[0].c
      + (await ctx.pool.query('SELECT count(*)::int c FROM print_jobs WHERE order_id = $1', [o.id])).rows[0].c;
    expect(tickets).toBeGreaterThan(0);
    // konobar (bez prava na tuđe račune) preuzima račun, pa naplata
    await ctx.http().post(api(`/orders/${o.id}/claim-qr`)).set(auth(waiter)).expect(200);
    await ctx.http().post(api(`/orders/${o.id}/claim-qr`)).set(auth(waiter)).expect(409);
    const mine = (await ctx.http().get(api(`/orders/${o.id}`)).set(auth(waiter)).expect(200)).body;
    expect(mine.waiterName).not.toBe('Gost (QR)');
    await ctx.http().post(api(`/orders/${o.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CASH' }], idempotencyKey: idem('pay') }).expect(201);
  });

  it('sto sa računom konobara: QR stavke se dodaju na njegov račun', async () => {
    const t = tables[2];
    const o = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ tableId: t.id, idempotencyKey: idem('o') }).expect(201)).body;
    const kola = await productId(ctx, admin, 'S001');
    await order(t.qrToken, [{ productId: kola, quantity: 1 }]).expect(200);
    const after = (await ctx.http().get(api(`/orders/${o.id}`)).set(auth(waiter)).expect(200)).body;
    expect(after.items.map((i: any) => i.productId)).toContain(kola);
  });

  it('gost ne može: nepostojeći artikal, sirovina, prevelika količina; isključeno u podešavanjima', async () => {
    const t = tables[3];
    await order(t.qrToken, [{ productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }]).expect(422);
    const espresso = await productId(ctx, admin, 'K001');
    await order(t.qrToken, [{ productId: espresso, quantity: 50 }]).expect(400);
    await order(t.qrToken, []).expect(400);
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ qrOrdering: false }).expect(200);
    expect((await ctx.http().get(api(`/public/qr/${t.qrToken}`)).expect(409)).body.error.code).toBe('QR_DISABLED');
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ qrOrdering: true }).expect(200);
    // sistemski korisnik se ne vidi u Korisnicima
    expect((await ctx.http().get(api('/users')).set(auth(admin)).expect(200)).body.some((u: any) => u.username === 'qr-gost')).toBe(false);
  });
});
