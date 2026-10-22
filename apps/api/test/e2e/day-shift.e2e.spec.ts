/**
 * Poslovni dan, smena konobara, prebacivanje računa, istorija računa, zaključak dana, kalendar.
 * Pravi PostgreSQL, pravi HTTP — bez mock-ova.
 */
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown, today } from './setup';

let ctx: Ctx;
let waiter: string;  // Marko (PIN 1111)
let cashier: string; // Ana (PIN 2222)
let manager: string; // Jelena (PIN 9999)
let ids: { marko: string; ana: string; jelena: string };
const api = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  ctx = await setupApp();
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  manager = await pinLogin(ctx, '9999');
  const { rows } = await ctx.pool.query(`SELECT id, full_name FROM users`);
  const byName = (n: string) => rows.find((r: any) => r.full_name.startsWith(n)).id;
  ids = { marko: byName('Marko'), ana: byName('Ana'), jelena: byName('Jelena') };
});
afterAll(() => teardown(ctx));

async function tableOrder(token: string, tableName: string, codes: string[]) {
  const tables = await ctx.http().get(api('/tables')).set(auth(token)).expect(200);
  const t = tables.body.find((x: any) => x.name === tableName);
  const o = await ctx.http().post(api('/orders')).set(auth(token)).send({ tableId: t.id }).expect(201);
  for (const c of codes) {
    await ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(token)).send({ productId: await productId(ctx, token, c) }).expect(201);
  }
  await ctx.http().post(api(`/orders/${o.body.id}/send`)).set(auth(token)).send({}).expect(200);
  return o.body.id as string;
}

let markoPaid: string, markoOpen: string, jelenaOwn: string, dayId: string;

describe('Poslovni dan i smena kase', () => {
  it('bez otvorenog dana ne može ni smena kase ni račun', async () => {
    expect((await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '1000.00' }).expect(409)).body.error.code).toBe('DAY_NOT_OPEN');
    expect((await ctx.http().post(api('/orders')).set(auth(waiter)).send({}).expect(409)).body.error.code).toBe('DAY_NOT_OPEN');
    const cur = await ctx.http().get(api('/business-days/current')).set(auth(waiter)).expect(200);
    expect(cur.body.day).toBeNull();
  });

  it('konobar ne može da otvori dan; kasir otvara; drugi otvoren dan nije moguć', async () => {
    await ctx.http().post(api('/business-days/open')).set(auth(waiter)).send({}).expect(403);
    const d = await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
    expect(d.body.date).toBe(today());
    dayId = d.body.id;
    expect((await ctx.http().post(api('/business-days/open')).set(auth(manager)).send({}).expect(409)).body.error.code).toBe('DAY_ALREADY_OPEN');
    await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '1000.00' }).expect(201);
  });
});

describe('Smena konobara: specifikacija pazara i prebacivanje stolova', () => {
  it('konobar radi: jedan sto naplaćen gotovinom, jedan ostaje otvoren', async () => {
    markoPaid = await tableOrder(waiter, 'Sto 1', ['K001', 'K002']); // 180 + 230 = 410
    await ctx.http().post(api(`/orders/${markoPaid}/payments`)).set(auth(waiter)).send({ method: 'CASH', idempotencyKey: idem() }).expect(201);
    markoOpen = await tableOrder(waiter, 'Sto 2', ['H002']); // 990, ostaje otvoren
    jelenaOwn = await tableOrder(manager, 'Sto 3', ['S001']); // 250, Jelenin
  });

  it('specifikacija pazara: naplaćeno po načinu plaćanja i otvoreni računi na konobaru', async () => {
    const r = await ctx.http().get(api('/staff-shifts/current')).set(auth(waiter)).expect(200);
    expect(r.body.shift.status).toBe('OPEN');
    expect(r.body.summary.collected.total).toBe('410.00');
    expect(r.body.summary.collected.cashToHandOver).toBe('410.00');
    expect(r.body.summary.closedReceipts).toEqual({ count: 1, amount: '410.00' });
    expect(r.body.summary.openOrders.map((o: any) => o.id)).toEqual([markoOpen]);
  });

  it('smena se ne može završiti dok konobar ima otvorene stolove', async () => {
    const r = await ctx.http().post(api('/staff-shifts/current/end')).set(auth(waiter)).expect(409);
    expect(r.body.error.code).toBe('STAFF_HAS_OPEN_ORDERS');
    expect(r.body.error.details.openOrders).toHaveLength(1);
  });

  it('konobar ne može da prebaci tuđi račun; prebacivanje je sve-ili-ništa', async () => {
    const r = await ctx.http().post(api('/orders/transfer')).set(auth(waiter))
      .send({ orderIds: [markoOpen, jelenaOwn], toUserId: ids.ana }).expect(409);
    expect(r.body.error.code).toBe('ORDER_NOT_YOURS');
    const { rows } = await ctx.pool.query(`SELECT waiter_id FROM orders WHERE id = $1`, [markoOpen]);
    expect(rows[0].waiter_id).toBe(ids.marko); // ništa nije prebačeno
  });

  it('konobar prebacuje svoj otvoren sto drugom konobaru; nova konobarica ga vidi i naplaćuje', async () => {
    const waiters = await ctx.http().get(api('/staff/waiters')).set(auth(waiter)).expect(200);
    expect(waiters.body.map((w: any) => w.fullName)).toEqual(expect.arrayContaining(['Ana Kasir', 'Jelena Menadžer', 'Marko Konobar']));
    const t = await ctx.http().post(api('/orders/transfer')).set(auth(waiter)).send({ orderIds: [markoOpen], toUserId: ids.jelena }).expect(200);
    expect(t.body.moved).toHaveLength(1);
    await ctx.http().get(api(`/orders/${markoOpen}`)).set(auth(waiter)).expect(404); // više nije njegov
    const o = await ctx.http().get(api(`/orders/${markoOpen}`)).set(auth(manager)).expect(200);
    expect(o.body.waiterName).toBe('Jelena Menadžer');
  });

  it('konobar završava smenu sa specifikacijom koja ostaje sačuvana', async () => {
    const r = await ctx.http().post(api('/staff-shifts/current/end')).set(auth(waiter)).expect(200);
    expect(r.body.summary.collected.total).toBe('410.00');
    expect(r.body.summary.openOrders).toHaveLength(0);
    const again = await ctx.http().get(api('/staff-shifts/current')).set(auth(waiter)).expect(200);
    expect(again.body.shift).toBeNull();
    const stored = await ctx.http().get(api(`/staff-shifts/${r.body.shift.id}`)).set(auth(manager)).expect(200);
    expect(stored.body.summary.collected.total).toBe('410.00');
  });

  it('istorija računa pokazuje ko je otvorio, dodavao, slao, prebacio', async () => {
    const h = await ctx.http().get(api(`/orders/${markoOpen}/history`)).set(auth(manager)).expect(200);
    const actions = h.body.map((x: any) => x.action);
    expect(actions).toEqual(['order.open', 'order.item.add', 'order.send', 'order.transfer']);
    expect(h.body[3]).toMatchObject({ userName: 'Marko Konobar', data: { toName: 'Jelena Menadžer' } });
  });
});

describe('Zaključak dana i kalendar', () => {
  it('dan se ne zaključuje dok ima otvorenih računa, pa ni dok je otvorena smena kase', async () => {
    let r = await ctx.http().post(api('/business-days/current/close')).set(auth(cashier)).expect(409);
    expect(r.body.error.code).toBe('DAY_HAS_OPEN_ORDERS');
    expect(r.body.error.details.openOrders).toHaveLength(2);
    for (const id of [markoOpen, jelenaOwn]) {
      await ctx.http().post(api(`/orders/${id}/payments`)).set(auth(manager)).send({ method: 'CARD', idempotencyKey: idem() }).expect(201);
    }
    r = await ctx.http().post(api('/business-days/current/close')).set(auth(cashier)).expect(409);
    expect(r.body.error.code).toBe('DAY_HAS_OPEN_CASH_SHIFTS');
    await ctx.http().post(api('/shifts/close')).set(auth(cashier)).send({ countedCash: '1410.00' }).expect(200);
  });

  it('zaključak dana: snimak obračuna, smene zaposlenih zatvorene', async () => {
    const r = await ctx.http().post(api('/business-days/current/close')).set(auth(cashier)).expect(200);
    expect(r.body.status).toBe('CLOSED');
    expect(r.body.summary.sales.sales).toEqual({ orders: 3, gross: '1650.00', averageOrder: '550.00' }); // 410 + 990 + 250
    expect(r.body.summary.sales.payments.total).toBe('1650.00');
    expect(r.body.summary.cashShifts[0].shift.difference).toBe('0.00');
    const { rows } = await ctx.pool.query(`SELECT count(*)::int c FROM staff_shifts WHERE status = 'OPEN'`);
    expect(rows[0].c).toBe(0);
    expect((await ctx.http().post(api('/orders')).set(auth(waiter)).send({}).expect(409)).body.error.code).toBe('DAY_NOT_OPEN');
  });

  it('kalendar i detalji dana', async () => {
    const month = today().slice(0, 7);
    const cal = await ctx.http().get(api(`/business-days?month=${month}`)).set(auth(manager)).expect(200);
    expect(cal.body).toHaveLength(1);
    expect(cal.body[0]).toMatchObject({ id: dayId, status: 'CLOSED', orders: 3, gross: '1650.00', collected: '1650.00', openOrders: 0, openedBy: 'Ana Kasir' });
    await ctx.http().get(api(`/business-days?month=${month}`)).set(auth(waiter)).expect(403);
    const d = await ctx.http().get(api(`/business-days/${dayId}`)).set(auth(manager)).expect(200);
    expect(d.body.cashShifts).toHaveLength(1);
    const staff = Object.fromEntries(d.body.staffShifts.map((s: any) => [s.fullName, s.collected.total]));
    expect(staff).toEqual({ 'Marko Konobar': '410.00', 'Jelena Menadžer': '1240.00' });
    const rec = await ctx.http().get(api(`/orders?status=PAID&businessDayId=${dayId}`)).set(auth(manager)).expect(200);
    expect(rec.body).toHaveLength(3);
  });

  it('promet posle ponoći pripada poslovnom danu, ne kalendarskom datumu', async () => {
    // Simulacija: jedan račun je zatvoren u 01:30 sledećeg kalendarskog dana.
    await ctx.pool.query(`UPDATE orders SET closed_at = (($1::date + 1) + time '01:30') AT TIME ZONE 'Europe/Belgrade' WHERE id = $2`, [today(), jelenaOwn]);
    const byDay = await ctx.http().get(api(`/reports/sales?businessDayId=${dayId}`)).set(auth(manager)).expect(200);
    expect(byDay.body.sales.gross).toBe('1650.00');
    const byDate = await ctx.http().get(api(`/reports/sales?from=${today()}&to=${today()}`)).set(auth(manager)).expect(200);
    expect(byDate.body.sales.gross).toBe('1400.00');
  });

  it('novi dan mora biti posle poslednjeg', async () => {
    const r = await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({ date: today() }).expect(422);
    expect(r.body.error.code).toBe('DAY_DATE_NOT_AFTER_LAST');
    const next = new Date(Date.parse(today() + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const d = await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({ date: next }).expect(201);
    expect(d.body.date).toBe(next);
  });
});
