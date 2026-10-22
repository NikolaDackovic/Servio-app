/**
 * Integracioni testovi nad PRAVOM PostgreSQL bazom (pos_test) kroz HTTP API.
 * Pokrivaju prvi vertikalni tok i kritična pravila: obračun, naplata, idempotentnost,
 * konkurentnost, storniranje, prava pristupa, smena i izveštaj.
 */
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown, today } from './setup';

let ctx: Ctx;
let admin: string; // admin, prijavljen na kasi
let waiter: string; // Marko (PIN 1111)
let cashier: string; // Ana (PIN 2222)
let manager: string; // Jelena (PIN 9999)

beforeAll(async () => {
  ctx = await setupApp();
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!', ctx.ids.posDevice);
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  manager = await pinLogin(ctx, '9999');
});
afterAll(() => teardown(ctx));

const api = (path: string) => `/api/v1${path}`;

describe('Autentifikacija i prava', () => {
  it('odbija pogrešan PIN, pogrešnu lozinku i zahtev bez tokena', async () => {
    await ctx.http().post(api('/auth/pin')).send({ deviceId: ctx.ids.posDevice, pin: '0000' }).expect(401);
    await ctx.http().post(api('/auth/login')).send({ email: 'admin@demo.local', password: 'pogresno' }).expect(401);
    const r = await ctx.http().get(api('/orders')).expect(401);
    expect(r.body.error.code).toBe('UNAUTHORIZED');
  });

  it('konobar ne može da menja katalog ni da čita izveštaje (provera na backendu)', async () => {
    const cats = await ctx.http().get(api('/categories')).set(auth(waiter)).expect(200);
    const tax = await ctx.http().get(api('/tax-rates')).set(auth(waiter)).expect(200);
    await ctx.http().post(api('/products')).set(auth(waiter))
      .send({ categoryId: cats.body[0].id, taxRateId: tax.body[0].id, code: 'X1', name: 'X', price: '1.00' }).expect(403);
    await ctx.http().get(api(`/reports/sales?from=${today()}&to=${today()}`)).set(auth(waiter)).expect(403);
  });

  it('deaktiviran nalog gubi pristup odmah, i sa važećim tokenom', async () => {
    const t = await pinLogin(ctx, '2222');
    await ctx.pool.query(`UPDATE users SET active=false WHERE full_name='Ana Kasir'`);
    await ctx.http().get(api('/orders')).set(auth(t)).expect(401);
    await ctx.pool.query(`UPDATE users SET active=true WHERE full_name='Ana Kasir'`);
    await ctx.http().get(api('/orders')).set(auth(t)).expect(200);
  });

  it('validacija: cena kao float broj i nepoznata polja se odbijaju', async () => {
    const cats = await ctx.http().get(api('/categories')).set(auth(admin)).expect(200);
    const tax = await ctx.http().get(api('/tax-rates')).set(auth(admin)).expect(200);
    const r = await ctx.http().post(api('/products')).set(auth(admin))
      .send({ categoryId: cats.body[0].id, taxRateId: tax.body[0].id, code: 'BAD', name: 'Loš', price: 1.5 }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    await ctx.http().post(api('/categories')).set(auth(admin)).send({ name: 'X', hacker: true }).expect(400);
  });
});

describe('Scenario A — prodaja u kafiću', () => {
  let orderId: string;
  let shiftOpened = false;

  it('administrator kreira kategoriju i proizvode sa poreskom stopom', async () => {
    const tax = await ctx.http().get(api('/tax-rates')).set(auth(admin)).expect(200);
    const vat20 = tax.body.find((t: any) => t.label === 'Đ');
    const cat = await ctx.http().post(api('/categories')).set(auth(admin)).send({ name: 'Test pića', color: '#112233' }).expect(201);
    await ctx.http().post(api('/products')).set(auth(admin))
      .send({ categoryId: cat.body.id, taxRateId: vat20.id, code: 'TA1', name: 'Test kafa', price: '200.00' }).expect(201);
    await ctx.http().post(api('/products')).set(auth(admin))
      .send({ categoryId: cat.body.id, taxRateId: vat20.id, code: 'TA2', name: 'Test sok', price: '250.50' }).expect(201);
    const dup = await ctx.http().post(api('/products')).set(auth(admin))
      .send({ categoryId: cat.body.id, taxRateId: vat20.id, code: 'TA2', name: 'Duplikat', price: '1.00' }).expect(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
  });

  it('naplata bez otvorene smene je odbijena', async () => {
    const o = await ctx.http().post(api('/orders')).set(auth(waiter)).send({}).expect(201);
    await ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(waiter)).send({ productId: await productId(ctx, waiter, 'TA1') }).expect(201);
    const r = await ctx.http().post(api(`/orders/${o.body.id}/payments`)).set(auth(waiter))
      .send({ method: 'CASH', idempotencyKey: idem() }).expect(409);
    expect(r.body.error.code).toBe('NO_OPEN_SHIFT');
    // počisti: neposlata stavka se uklanja, porudžbina se otkazuje
    await ctx.http().post(api(`/orders/${o.body.id}/cancel`)).set(auth(waiter)).send({ reason: 'test čišćenje' }).expect(200);
  });

  it('kasir otvara smenu sa početnom gotovinom; druga otvorena smena na istoj kasi nije moguća', async () => {
    await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '5000.00' }).expect(201);
    const r = await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '1.00' }).expect(409);
    expect(r.body.error.code).toBe('SHIFT_ALREADY_OPEN');
    shiftOpened = true;
  });

  it('konobar otvara sto, dodaje kafu i sok; porudžbina se čuva i ponovo učitava iz baze', async () => {
    expect(shiftOpened).toBe(true);
    const tables = await ctx.http().get(api('/tables')).set(auth(waiter)).expect(200);
    const sto1 = tables.body.find((t: any) => t.name === 'Sto 1');
    expect(sto1.status).toBe('FREE');

    const o = await ctx.http().post(api('/orders')).set(auth(waiter)).send({ tableId: sto1.id, guests: 2 }).expect(201);
    orderId = o.body.id;
    await ctx.http().post(api(`/orders/${orderId}/items`)).set(auth(waiter))
      .send({ productId: await productId(ctx, waiter, 'TA1'), quantity: '2' }).expect(201);
    await ctx.http().post(api(`/orders/${orderId}/items`)).set(auth(waiter))
      .send({ productId: await productId(ctx, waiter, 'TA2'), note: 'bez leda' }).expect(201);

    const reloaded = await ctx.http().get(api(`/orders/${orderId}`)).set(auth(waiter)).expect(200);
    expect(reloaded.body.total).toBe('650.50'); // 2×200.00 + 250.50
    expect(reloaded.body.items).toHaveLength(2);
    expect(reloaded.body.items[1].note).toBe('bez leda');
    expect(reloaded.body.taxSummary).toEqual([{ label: 'Đ', rate: '20.00', gross: '650.50', tax: '108.42', net: '542.08' }]);

    const after = await ctx.http().get(api('/tables')).set(auth(waiter)).expect(200);
    expect(after.body.find((t: any) => t.name === 'Sto 1').status).toBe('OCCUPIED');
  });

  it('slanje u pripremu: prva tura šalje obe stavke, naknadna samo novu stavku', async () => {
    const s1 = await ctx.http().post(api(`/orders/${orderId}/send`)).set(auth(waiter)).send({}).expect(200);
    expect(s1.body.batch).toBe(1);
    expect(s1.body.sentItems).toHaveLength(2);

    const again = await ctx.http().post(api(`/orders/${orderId}/send`)).set(auth(waiter)).send({}).expect(200);
    expect(again.body.batch).toBeNull(); // ponovno slanje ne duplira

    await ctx.http().post(api(`/orders/${orderId}/items`)).set(auth(waiter))
      .send({ productId: await productId(ctx, waiter, 'TA1') }).expect(201);
    const s2 = await ctx.http().post(api(`/orders/${orderId}/send`)).set(auth(waiter)).send({}).expect(200);
    expect(s2.body.batch).toBe(2);
    expect(s2.body.sentItems).toHaveLength(1);
    expect(s2.body.order.total).toBe('850.50');
  });

  it('poslata stavka ne može da se obriše; konobar bez prava ne može da je stornira', async () => {
    const o = await ctx.http().get(api(`/orders/${orderId}`)).set(auth(waiter)).expect(200);
    const sent = o.body.items[0];
    const del = await ctx.http().delete(api(`/orders/${orderId}/items/${sent.id}`)).set(auth(waiter)).expect(409);
    expect(del.body.error.code).toBe('ITEM_ALREADY_SENT');
    await ctx.http().post(api(`/orders/${orderId}/items/${sent.id}/void`)).set(auth(waiter)).send({ reason: 'greška' }).expect(403);
  });

  it('menadžer stornira poslatu stavku uz razlog; iznos se preračunava, istorija ostaje', async () => {
    const o = await ctx.http().get(api(`/orders/${orderId}`)).set(auth(manager)).expect(200);
    const last = o.body.items[2];
    const v = await ctx.http().post(api(`/orders/${orderId}/items/${last.id}/void`)).set(auth(manager))
      .send({ reason: 'Gost odustao' }).expect(200);
    expect(v.body.total).toBe('650.50');
    expect(v.body.items).toHaveLength(3);
    expect(v.body.items[2].status).toBe('VOIDED');
    const a = await ctx.pool.query(`SELECT action, data FROM audit_logs WHERE entity_id=$1 AND action='order.item.void'`, [orderId]);
    expect(a.rows[0].data.reason).toBe('Gost odustao');
  });

  it('naplata kombinacijom kartice i gotovine (sa kusurom) zatvara račun', async () => {
    const card = await ctx.http().post(api(`/orders/${orderId}/payments`)).set(auth(waiter))
      .send({ method: 'CARD', amount: '400.00', idempotencyKey: idem('card') }).expect(201);
    expect(card.body.order.status).toBe('OPEN');
    expect(card.body.order.remaining).toBe('250.50');
    expect(card.body.payment.mode).toBe('TEST');

    const over = await ctx.http().post(api(`/orders/${orderId}/payments`)).set(auth(waiter))
      .send({ method: 'CARD', amount: '300.00', idempotencyKey: idem() }).expect(422);
    expect(over.body.error.code).toBe('AMOUNT_EXCEEDS_REMAINING');

    const cash = await ctx.http().post(api(`/orders/${orderId}/payments`)).set(auth(waiter))
      .send({ method: 'CASH', tendered: '300.00', idempotencyKey: idem('cash') }).expect(201);
    expect(cash.body.payment.amount).toBe('250.50');
    expect(cash.body.payment.change).toBe('49.50');
    expect(cash.body.order.status).toBe('PAID');
    expect(cash.body.order.paidTotal).toBe('650.50');

    // zatvoren račun se više ne menja
    await ctx.http().post(api(`/orders/${orderId}/items`)).set(auth(waiter))
      .send({ productId: await productId(ctx, waiter, 'TA1') }).expect(409);
    const tables = await ctx.http().get(api('/tables')).set(auth(waiter)).expect(200);
    expect(tables.body.find((t: any) => t.name === 'Sto 1').status).toBe('FREE');
  });

  it('izveštaj prikazuje promet, porez i plaćanja dosledno', async () => {
    const r = await ctx.http().get(api(`/reports/sales?from=${today()}&to=${today()}`)).set(auth(manager)).expect(200);
    expect(r.body.sales).toEqual({ orders: 1, gross: '650.50', averageOrder: '650.50' });
    expect(r.body.payments.total).toBe('650.50');
    const byM = Object.fromEntries(r.body.payments.byMethod.map((m: any) => [m.method, m.amount]));
    expect(byM).toEqual({ CARD: '400.00', CASH: '250.50' });
    expect(r.body.payments.containsTestPayments).toBe(true);
    expect(r.body.taxes).toEqual([{ label: 'Đ', rate: '20.00', gross: '650.50', tax: '108.42', net: '542.08' }]);
    expect(r.body.voids).toEqual({ count: 1, amount: '200.00' });
    const kafa = r.body.byProduct.find((p: any) => p.name === 'Test kafa');
    expect(kafa).toMatchObject({ quantity: '2.000', gross: '400.00' }); // stornirana treća kafa nije uračunata
    expect(r.body.byWaiter[0]).toMatchObject({ name: 'Marko Konobar', orders: 1, gross: '650.50' });
  });

  it('zatvaranje smene: očekivana gotovina = početna + gotovina + uplate − isplate', async () => {
    await ctx.http().post(api('/shifts/current/cash-movements')).set(auth(cashier))
      .send({ type: 'PAY_OUT', amount: '100.00', reason: 'Nabavka leda' }).expect(201);
    const c = await ctx.http().post(api('/shifts/close')).set(auth(cashier)).send({ countedCash: '5140.00' }).expect(200);
    // 5000.00 + 250.50 − 100.00 = 5150.50; prebrojano 5140.00 → manjak 10.50
    expect(c.body.shift.expectedCash).toBe('5150.50');
    expect(c.body.shift.difference).toBe('-10.50');
    expect(c.body.shift.status).toBe('CLOSED');
  });
});

describe('Integritet, idempotentnost i konkurentnost', () => {
  let espresso: string;
  beforeAll(async () => {
    espresso = await productId(ctx, waiter, 'K001');
    await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
  });

  async function orderWith(items: number, token = waiter) {
    const o = await ctx.http().post(api('/orders')).set(auth(token)).send({}).expect(201);
    for (let i = 0; i < items; i++) {
      await ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(token)).send({ productId: espresso }).expect(201);
    }
    return o.body.id as string;
  }

  it('isti idempotency ključ ponovljen 2× i paralelno 5× pravi tačno jednu naplatu', async () => {
    const id = await orderWith(2); // 360.00
    const key = idem('same');
    const first = await ctx.http().post(api(`/orders/${id}/payments`)).set(auth(waiter)).send({ method: 'CARD', amount: '100.00', idempotencyKey: key }).expect(201);
    const second = await ctx.http().post(api(`/orders/${id}/payments`)).set(auth(waiter)).send({ method: 'CARD', amount: '100.00', idempotencyKey: key }).expect(201);
    expect(second.body.idempotentReplay).toBe(true);
    expect(second.body.payment.id).toBe(first.body.payment.id);

    const key2 = idem('par');
    const rs = await Promise.all(Array.from({ length: 5 }, () =>
      ctx.http().post(api(`/orders/${id}/payments`)).set(auth(waiter)).send({ method: 'CASH', amount: '50.00', idempotencyKey: key2 })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const { rows } = await ctx.pool.query('SELECT count(*)::int c, sum(amount)::text s FROM payments WHERE order_id=$1', [id]);
    expect(rows[0]).toEqual({ c: 2, s: '150.00' });
    const o = await ctx.http().get(api(`/orders/${id}`)).set(auth(waiter)).expect(200);
    expect(o.body.paidTotal).toBe('150.00');
  });

  it('10 paralelnih naplata celog iznosa (različiti ključevi) → tačno jedna uspeva, nema duple naplate', async () => {
    const id = await orderWith(3); // 540.00
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      ctx.http().post(api(`/orders/${id}/payments`)).set(auth(waiter)).send({ method: 'CARD', amount: '540.00', idempotencyKey: idem(`race${i}`) })));
    const ok = rs.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409 || r.status === 422)).toHaveLength(9);
    const { rows } = await ctx.pool.query(`SELECT o.status, o.paid_total::text p, (SELECT count(*)::int FROM payments WHERE order_id=o.id) n FROM orders o WHERE id=$1`, [id]);
    expect(rows[0]).toEqual({ status: 'PAID', p: '540.00', n: 1 });
  });

  it('20 paralelnih dodavanja stavki → ukupan iznos tačno odgovara zbiru stavki', async () => {
    const o = await ctx.http().post(api('/orders')).set(auth(waiter)).send({}).expect(201);
    const rs = await Promise.all(Array.from({ length: 20 }, () =>
      ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(waiter)).send({ productId: espresso })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const r = await ctx.http().get(api(`/orders/${o.body.id}`)).set(auth(waiter)).expect(200);
    expect(r.body.items).toHaveLength(20);
    expect(r.body.total).toBe('3600.00');
    expect(r.body.version).toBe(20);
  });

  it('zastarela verzija (optimistički konflikt) vraća 409 STALE_ORDER', async () => {
    const id = await orderWith(1);
    const r = await ctx.http().post(api(`/orders/${id}/items`)).set(auth(waiter)).send({ productId: espresso, expectedVersion: 0 }).expect(409);
    expect(r.body.error.code).toBe('STALE_ORDER');
  });

  it('decimalne količine se pravilno zaokružuju', async () => {
    const o = await ctx.http().post(api('/orders')).set(auth(waiter)).send({}).expect(201);
    const r = await ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(waiter)).send({ productId: espresso, quantity: '0.333' }).expect(201);
    expect(r.body.items[0].lineTotal).toBe('59.94'); // 180.00 × 0.333 = 59.94
    expect(r.body.total).toBe('59.94');
  });

  it('promena cene ne menja već dodate stavke (snimak cene) i ostaje u istoriji', async () => {
    const id = await orderWith(1);
    await ctx.http().patch(api(`/products/${espresso}`)).set(auth(admin)).send({ price: '200.00' }).expect(200);
    const r = await ctx.http().get(api(`/orders/${id}`)).set(auth(waiter)).expect(200);
    expect(r.body.items[0].unitPrice).toBe('180.00');
    expect(r.body.total).toBe('180.00');
    const h = await ctx.http().get(api(`/products/${espresso}/price-history`)).set(auth(admin)).expect(200);
    expect(h.body.map((x: any) => x.newPrice)).toEqual(['180.00', '200.00']);
    await ctx.http().patch(api(`/products/${espresso}`)).set(auth(admin)).send({ price: '180.00' }).expect(200);
  });

  it('nakon delimične naplate izmena ne sme da spusti račun ispod naplaćenog', async () => {
    const id = await orderWith(2); // 360.00, poslato
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    await ctx.http().post(api(`/orders/${id}/payments`)).set(auth(waiter)).send({ method: 'CARD', amount: '300.00', idempotencyKey: idem() }).expect(201);
    const o = await ctx.http().get(api(`/orders/${id}`)).set(auth(manager)).expect(200);
    const r = await ctx.http().post(api(`/orders/${id}/items/${o.body.items[0].id}/void`)).set(auth(manager)).send({ reason: 'test' }).expect(409);
    expect(r.body.error.code).toBe('TOTAL_BELOW_PAID');
    await ctx.http().post(api(`/orders/${id}/cancel`)).set(auth(manager)).send({ reason: 'test' }).expect(409);
  });

  it('baza sama odbija nedozvoljena stanja (CHECK ograničenja)', async () => {
    const id = await orderWith(1);
    await expect(ctx.pool.query(`UPDATE orders SET paid_total = total + 1 WHERE id=$1`, [id])).rejects.toThrow(/orders_paid_not_over_total/);
    await expect(ctx.pool.query(`UPDATE orders SET status='PAID' WHERE id=$1`, [id])).rejects.toThrow(/orders_paid_means_settled/);
    await expect(ctx.pool.query(`UPDATE order_items SET quantity = 0 WHERE order_id=$1`, [id])).rejects.toThrow(/order_items_qty_pos/);
  });

  it('konobar ne vidi tuđu porudžbinu; kasir sa pravom pregleda vidi sve', async () => {
    const id = await orderWith(1, manager);
    await ctx.http().get(api(`/orders/${id}`)).set(auth(waiter)).expect(404);
    await ctx.http().post(api(`/orders/${id}/items`)).set(auth(waiter)).send({ productId: espresso }).expect(409);
    await ctx.http().get(api(`/orders/${id}`)).set(auth(cashier)).expect(200);
  });

  it('idempotentno otvaranje porudžbine ne pravi duplikat', async () => {
    const key = idem('open');
    const a = await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: key }).expect(201);
    const b = await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: key }).expect(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.idempotentReplay).toBe(true);
  });
});
