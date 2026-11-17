/**
 * Povraćaj novca (refundacija naplaćenog računa): delimično i ostatak, prava, granice, lager, blagajna,
 * fiskalni REFUND sa referencom na prodaju, štampa dva primerka, izveštaj.
 */
import { Ctx, auth, idem, pinLogin, productId, setupApp, teardown } from './setup';

let ctx: Ctx;
let waiter: string, cashier: string, manager: string;
const api = (p: string) => `/api/v1${p}`;
let espresso: string, kisela: string;

beforeAll(async () => {
  ctx = await setupApp();
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  manager = await pinLogin(ctx, '9999');
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
  await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
  espresso = await productId(ctx, waiter, 'K001'); // 180, bez zalihe (normativ)
  kisela = await productId(ctx, waiter, 'S003');   // 190, prati se zaliha
});
afterAll(() => teardown(ctx));

async function paidOrder(products: string[]) {
  const o = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: idem('o') }).expect(201)).body;
  for (const p of products) await ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(waiter)).send({ productId: p }).expect(201);
  await ctx.http().post(api(`/orders/${o.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CASH' }], idempotencyKey: idem('pay') }).expect(201);
  return (await ctx.http().get(api(`/orders/${o.id}`)).set(auth(manager)).expect(200)).body;
}
const stockOf = async (pid: string) => Number((await ctx.pool.query('SELECT coalesce(sum(quantity),0) AS q FROM stock_balances WHERE product_id = $1', [pid])).rows[0].q);

describe('Povraćaj novca', () => {
  let o: any;
  it('pravo: konobar i kasir ne mogu, menadžer može; nenaplaćen račun se ne refundira', async () => {
    o = await paidOrder([espresso, espresso, kisela]); // 180 + 180 + 190 = 550
    const body = { reason: 'Gost vratio', idempotencyKey: idem('rf') };
    await ctx.http().post(api(`/orders/${o.id}/refunds`)).set(auth(waiter)).send(body).expect(403);
    await ctx.http().post(api(`/orders/${o.id}/refunds`)).set(auth(cashier)).send(body).expect(403);
    const open = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: idem('o') }).expect(201)).body;
    await ctx.http().post(api(`/orders/${open.id}/items`)).set(auth(waiter)).send({ productId: espresso }).expect(201);
    expect((await ctx.http().post(api(`/orders/${open.id}/refunds`)).set(auth(manager)).send(body).expect(409)).body.error.code).toBe('ORDER_NOT_PAID');
  });

  it('delimičan povraćaj: jedna kafa; gotovina iz blagajne; fiskalni REFUND sa referencom na prodaju; ponovljen ključ ne vraća dvaput', async () => {
    const lines = (await ctx.http().get(api(`/orders/${o.id}/refunds`)).set(auth(manager)).expect(200)).body.items;
    const esp = lines.find((l: any) => l.name === 'Espresso');
    const key = idem('rf1');
    const r = (await ctx.http().post(api(`/orders/${o.id}/refunds`)).set(auth(manager))
      .send({ items: [{ itemId: esp.id, quantity: '1' }], reason: 'Hladna kafa', idempotencyKey: key }).expect(201)).body;
    expect(r).toMatchObject({ total: '180.00', method: 'CASH', idempotentReplay: false, number: expect.any(Number) });
    expect(r.fiscal).toMatchObject({ status: 'SIGNED', isTest: true });
    expect(r.fiscal.invoiceNumber).toMatch(new RegExp(`-R${r.number}$`));
    const fr = (await ctx.pool.query(`SELECT request FROM fiscal_receipts WHERE refund_id = $1`, [r.id])).rows[0].request;
    const sale = (await ctx.pool.query(`SELECT invoice_number FROM fiscal_receipts WHERE order_id = $1 AND transaction_type = 'SALE'`, [o.id])).rows[0];
    expect(fr).toMatchObject({ transactionType: 'REFUND', referentDocumentNumber: sale.invoice_number, total: '180.00' });
    const again = (await ctx.http().post(api(`/orders/${o.id}/refunds`)).set(auth(manager))
      .send({ items: [{ itemId: esp.id, quantity: '1' }], reason: 'Hladna kafa', idempotencyKey: key }).expect(201)).body;
    expect(again).toMatchObject({ id: r.id, idempotentReplay: true });
    const pay = (await ctx.pool.query(`SELECT count(*)::int AS n, sum(amount)::text AS a FROM cash_movements WHERE type = 'PAY_OUT' AND reason LIKE $1`, [`Povraćaj #${r.number} %`])).rows[0];
    expect(pay).toEqual({ n: 1, a: '180.00' });
  });

  it('ne može se vratiti više od prodatog; ostatak računa vraća robu na lager; posle toga nema šta da se vrati', async () => {
    const lines = (await ctx.http().get(api(`/orders/${o.id}/refunds`)).set(auth(manager)).expect(200)).body.items;
    const [esp1, esp2] = lines.filter((l: any) => l.name === 'Espresso'); // dve stavke po 1
    expect(esp1).toMatchObject({ refunded: '1.000', remaining: '0.000' });
    expect(esp2).toMatchObject({ refunded: '0.000', remaining: '1.000' });
    const tooMuch = await ctx.http().post(api(`/orders/${o.id}/refunds`)).set(auth(manager))
      .send({ items: [{ itemId: esp2.id, quantity: '2' }], reason: 'Previše', idempotencyKey: idem('rf') }).expect(422);
    expect(tooMuch.body.error.code).toBe('REFUND_EXCEEDS_SOLD');
    const before = await stockOf(kisela);
    const rest = (await ctx.http().post(api(`/orders/${o.id}/refunds`)).set(auth(manager))
      .send({ reason: 'Ceo ostatak', method: 'CARD', idempotencyKey: idem('rf') }).expect(201)).body;
    expect(rest).toMatchObject({ total: '370.00', method: 'CARD' }); // 180 + 190
    expect(await stockOf(kisela)).toBe(before + 1);
    const mv = (await ctx.pool.query(`SELECT source FROM stock_movements WHERE refund_id = $1`, [rest.id])).rows;
    expect(mv.every((m: any) => m.source === 'REFUND')).toBe(true);
    expect((await ctx.http().post(api(`/orders/${o.id}/refunds`)).set(auth(manager))
      .send({ reason: 'Još', idempotencyKey: idem('rf') }).expect(409)).body.error.code).toBe('NOTHING_TO_REFUND');
  });

  it('štampa: dva primerka (kupac i lokal sa potpisom); izveštaj prikazuje povraćaje i neto naplatu', async () => {
    const list = (await ctx.http().get(api(`/orders/${o.id}/refunds`)).set(auth(manager)).expect(200)).body.refunds;
    expect(list).toHaveLength(2);
    const p = (await ctx.http().post(api(`/refunds/${list[0].id}/print`)).set(auth(manager)).send({ idempotencyKey: idem('prf') }).expect(201)).body;
    expect(p.jobs).toHaveLength(2);
    expect(p.jobs[0].payload.fiscalLayout).toMatchObject({ transaction: 'ОБУКА РЕФУНДАЦИЈА', refund: true });
    expect(p.jobs[1].payload.fiscalLayout).toMatchObject({ transaction: 'КОПИЈА РЕФУНДАЦИЈА', signature: true });
    expect(p.jobs[0].payload.fiscalLayout.refNumber).toMatch(/^TEST-/);
    const day = (await ctx.http().get(api('/business-days/current')).set(auth(manager)).expect(200)).body.day;
    const rep = (await ctx.http().get(api(`/reports/sales?businessDayId=${day.id}`)).set(auth(manager)).expect(200)).body;
    expect(rep.refunds).toMatchObject({ count: 2, amount: '550.00' });
    expect(Number(rep.payments.net)).toBe(Number(rep.payments.total) - 550);
  });
});
