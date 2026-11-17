/**
 * Iteracija 3: popusti i PDV, kupac (PIB/JMBG), reprezentacija, mix naplata (atomski),
 * ture na stolu, prebacivanje stavki, spajanje tura, storno celog računa.
 */
import { Ctx, auth, idem, pinLogin, productId, setupApp, teardown } from './setup';
import { isValidJmbg, isValidPib } from '../../src/common/buyer';

let ctx: Ctx;
let waiter: string, cashier: string, manager: string;
const api = (p: string) => `/api/v1${p}`;
let espresso: string, pljeskavica: string, proja: string;
let d10: string, d40: string;

beforeAll(async () => {
  ctx = await setupApp();
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  manager = await pinLogin(ctx, '9999');
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
  await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
  espresso = await productId(ctx, waiter, 'K001');      // 180, 20%
  pljeskavica = await productId(ctx, waiter, 'H002');   // 990, 20%
  proja = await productId(ctx, waiter, 'H004');         // 200, 10%
  const ds = await ctx.http().get(api('/discounts')).set(auth(waiter)).expect(200);
  d10 = ds.body.find((d: any) => d.name === 'Popust 10%').id;
  d40 = ds.body.find((d: any) => d.name === 'Popust 40%').id;
});
afterAll(() => teardown(ctx));

async function order(token: string, products: string[], body: any = {}) {
  const o = await ctx.http().post(api('/orders')).set(auth(token)).send(body).expect(201);
  for (const p of products) await ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(token)).send({ productId: p }).expect(201);
  return o.body.id as string;
}
const get = async (id: string, token = manager) => (await ctx.http().get(api(`/orders/${id}`)).set(auth(token)).expect(200)).body;

describe('Popusti', () => {
  it('ADMIN definiše popust; konobar ne može da ga definiše; nevažeći procenat se odbija', async () => {
    await ctx.http().post(api('/discounts')).set(auth(waiter)).send({ name: 'X', percent: '5' }).expect(403);
    const r = await ctx.http().post(api('/discounts')).set(auth(manager)).send({ name: 'Previše', percent: '150' }).expect(422);
    expect(r.body.error.code).toBe('INVALID_PERCENT');
    const ok = await ctx.http().post(api('/discounts')).set(auth(manager)).send({ name: 'Srećni sat 25%', percent: '25' }).expect(201);
    expect(ok.body.percent).toBe('25.00');
  });

  it('popust se raspoređuje po stavkama; PDV rekapitulacija po stopama je tačna', async () => {
    const id = await order(waiter, [espresso, pljeskavica, proja]); // 180 + 990 (20%) + 200 (10%) = 1370
    const o = (await ctx.http().put(api(`/orders/${id}/discount`)).set(auth(waiter)).send({ discountId: d10 }).expect(200)).body;
    expect(o).toMatchObject({ subtotal: '1370.00', discountTotal: '137.00', total: '1233.00', discountPercent: '10.00' });
    // Đ: (180+990)×0.9 = 1053.00 → PDV 175.50; E: 200×0.9 = 180.00 → PDV 16.36
    expect(o.taxSummary).toEqual([
      { label: 'E', rate: '10.00', gross: '180.00', tax: '16.36', net: '163.64' },
      { label: 'Đ', rate: '20.00', gross: '1053.00', tax: '175.50', net: '877.50' },
    ].sort((a, b) => a.label.localeCompare(b.label)) as any);
    // nova stavka posle popusta dobija isti popust
    const after = (await ctx.http().post(api(`/orders/${id}/items`)).set(auth(waiter)).send({ productId: espresso }).expect(201)).body;
    expect(after).toMatchObject({ subtotal: '1550.00', discountTotal: '155.00', total: '1395.00' });
    // uklanjanje popusta
    const none = (await ctx.http().put(api(`/orders/${id}/discount`)).set(auth(waiter)).send({ discountId: null }).expect(200)).body;
    expect(none).toMatchObject({ discountTotal: '0.00', total: '1550.00' });
  });

  it('popust na grupu ili proizvod ide samo na te stavke; opseg bez ciljeva se odbija', async () => {
    const cats = (await ctx.http().get(api('/categories')).set(auth(manager)).expect(200)).body;
    const hrana = cats.find((c: any) => c.name === 'Hrana').id;
    expect((await ctx.http().post(api('/discounts')).set(auth(manager)).send({ name: 'Bez cilja', percent: '10', scope: 'GROUP', targetIds: [] }).expect(422)).body.error.code).toBe('DISCOUNT_TARGETS');
    const g = (await ctx.http().post(api('/discounts')).set(auth(manager)).send({ name: 'Hrana 50%', percent: '50', scope: 'GROUP', targetIds: [hrana] }).expect(201)).body;
    const id = await order(waiter, [espresso, pljeskavica]); // 180 (Topli napici) + 990 (Hrana)
    const o = (await ctx.http().put(api(`/orders/${id}/discount`)).set(auth(waiter)).send({ discountId: g.id }).expect(200)).body;
    expect(o).toMatchObject({ subtotal: '1170.00', discountTotal: '495.00', total: '675.00' });
    const p = (await ctx.http().post(api('/discounts')).set(auth(manager)).send({ name: 'Espresso 10%', percent: '10', scope: 'PRODUCT', targetIds: [espresso] }).expect(201)).body;
    const o2 = (await ctx.http().put(api(`/orders/${id}/discount`)).set(auth(waiter)).send({ discountId: p.id }).expect(200)).body;
    expect(o2).toMatchObject({ discountTotal: '18.00', total: '1152.00' });
    // izmena opsega na ceo račun
    await ctx.http().patch(api(`/discounts/${p.id}`)).set(auth(manager)).send({ scope: 'ALL' }).expect(200);
    await ctx.http().put(api(`/orders/${id}/discount`)).set(auth(waiter)).send({ discountId: null }).expect(200);
    expect((await ctx.http().put(api(`/orders/${id}/discount`)).set(auth(waiter)).send({ discountId: p.id }).expect(200)).body.discountTotal).toBe('117.00');
  });

  it('izveštaj računa promet i porez posle popusta i prikazuje ukupan popust', async () => {
    const id = await order(waiter, [pljeskavica]); // 990
    await ctx.http().put(api(`/orders/${id}/discount`)).set(auth(waiter)).send({ discountId: d40 }).expect(200); // 594
    await ctx.http().post(api(`/orders/${id}/payments`)).set(auth(waiter)).send({ method: 'CARD', idempotencyKey: idem() }).expect(201);
    const day = (await ctx.http().get(api('/business-days/current')).set(auth(manager)).expect(200)).body;
    const r = await ctx.http().get(api(`/reports/sales?businessDayId=${day.day.id}`)).set(auth(manager)).expect(200);
    expect(r.body.sales.gross).toBe('594.00');
    expect(r.body.discounts).toEqual({ count: 1, amount: '396.00' });
    expect(r.body.taxes[0].gross).toBe('594.00');
    expect(r.body.byProduct[0]).toMatchObject({ name: 'Pljeskavica', gross: '594.00' });
  });
});

describe('Kupac na računu', () => {
  it('validacija PIB i JMBG kontrolnih cifara', () => {
    expect(isValidPib('100000024')).toBe(true);
    expect(isValidPib('100000025')).toBe(false);
    expect(isValidPib('12345678')).toBe(false);
    expect(isValidJmbg('0101990710008')).toBe(true);
    expect(isValidJmbg('0101990710006')).toBe(false);
  });

  it('PIB za gotovinski račun firmi; pogrešan PIB i nepotpuno opciono polje se odbijaju', async () => {
    const id = await order(waiter, [espresso]);
    expect((await ctx.http().put(api(`/orders/${id}/buyer`)).set(auth(waiter)).send({ idType: '10', idValue: '100000025' }).expect(422)).body.error.code).toBe('INVALID_PIB');
    expect((await ctx.http().put(api(`/orders/${id}/buyer`)).set(auth(waiter)).send({ idType: '99', idValue: '123' }).expect(422)).body.error.code).toBe('INVALID_BUYER_TYPE');
    expect((await ctx.http().put(api(`/orders/${id}/buyer`)).set(auth(waiter)).send({ idType: '31', idValue: 'D-1234', optionalBasis: 'LNPDV - lice sa pravom na oslobođenje od PDV-a' }).expect(422)).body.error.code).toBe('INVALID_BUYER_OPTIONAL');
    const ok = (await ctx.http().put(api(`/orders/${id}/buyer`)).set(auth(waiter)).send({ idType: '10', idValue: '100000024' }).expect(200)).body;
    expect(ok).toMatchObject({ buyerIdType: '10', buyerId: '100000024', buyerIdLabel: 'PIB' });
    const dipl = (await ctx.http().put(api(`/orders/${id}/buyer`)).set(auth(waiter))
      .send({ idType: '31', idValue: 'D-1234', optionalBasis: 'LNPDV - lice sa pravom na oslobođenje od PDV-a', optionalValue: '777' }).expect(200)).body;
    expect(dipl).toMatchObject({ buyerIdType: '31', buyerOptionalValue: '777' });
    const cleared = (await ctx.http().put(api(`/orders/${id}/buyer`)).set(auth(waiter)).send({ idType: null }).expect(200)).body;
    expect(cleared.buyerIdType).toBeNull();
    const codes = await ctx.http().get(api('/fiscal/buyer-codes')).set(auth(waiter)).expect(200);
    expect(codes.body.idTypes.map((t: any) => t.code)).toEqual(expect.arrayContaining(['10', '11', '31', '40']));
  });
});

describe('Naplata: mix i reprezentacija', () => {
  it('mix (kartica + gotovina sa kusurom) u jednoj transakciji zatvara račun', async () => {
    const id = await order(waiter, [espresso, pljeskavica]); // 1170
    const key = idem('mix');
    const r = await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(waiter))
      .send({ parts: [{ method: 'CARD', amount: '700.00' }, { method: 'CASH', tendered: '500.00' }], idempotencyKey: key }).expect(201);
    expect(r.body.order.status).toBe('PAID');
    expect(r.body.payments.map((p: any) => [p.method, p.amount, p.change])).toEqual([['CARD', '700.00', '0.00'], ['CASH', '470.00', '30.00']]);
    const again = await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(waiter))
      .send({ parts: [{ method: 'CARD', amount: '700.00' }, { method: 'CASH', tendered: '500.00' }], idempotencyKey: key }).expect(201);
    expect(again.body.idempotentReplay).toBe(true);
    const { rows } = await ctx.pool.query('SELECT count(*)::int c FROM payments WHERE order_id = $1', [id]);
    expect(rows[0].c).toBe(2);
  });

  it('mix koji premašuje dug ne evidentira ništa (sve-ili-ništa)', async () => {
    const id = await order(waiter, [espresso]); // 180
    const r = await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(waiter))
      .send({ parts: [{ method: 'CARD', amount: '100.00' }, { method: 'CASH', amount: '100.00' }], idempotencyKey: idem() }).expect(422);
    expect(r.body.error.code).toBe('AMOUNT_EXCEEDS_REMAINING');
    const { rows } = await ctx.pool.query('SELECT count(*)::int c FROM payments WHERE order_id = $1', [id]);
    expect(rows[0].c).toBe(0);
  });

  it('reprezentacija: samo ceo račun; ulazi u pazar kao posebna stavka, ne u gotovinu za predaju', async () => {
    const id = await order(waiter, [espresso, espresso]); // 360
    expect((await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(waiter))
      .send({ parts: [{ method: 'REPRESENTATION', amount: '100.00' }], idempotencyKey: idem() }).expect(422)).body.error.code).toBe('REPRESENTATION_WHOLE_ONLY');
    const r = await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(waiter))
      .send({ parts: [{ method: 'REPRESENTATION' }], idempotencyKey: idem() }).expect(201);
    expect(r.body.order.status).toBe('PAID');
    const shift = (await ctx.http().get(api('/staff-shifts/current')).set(auth(waiter)).expect(200)).body.summary;
    expect(shift.collected.representation).toBe('360.00');
    expect(Number(shift.collected.total)).toBeGreaterThanOrEqual(360);
    expect(shift.collected.cashToHandOver).not.toBe(shift.collected.total);
    const day = (await ctx.http().get(api('/business-days/current')).set(auth(manager)).expect(200)).body;
    expect(day.sales.payments.representation).toBe('360.00');
    expect(day.sales.payments.byMethod.find((m: any) => m.method === 'REPRESENTATION').amount).toBe('360.00');
  });
});

describe('Ture na stolu, prebacivanje stavki, spajanje', () => {
  let tableId: string, pera: string, mika: string;

  it('isti sto, dve ture (Pera, Mika); sto ih prikazuje sa nazivima', async () => {
    const tables = (await ctx.http().get(api('/tables')).set(auth(waiter)).expect(200)).body;
    tableId = tables.find((t: any) => t.name === 'Sto 5').id;
    pera = await order(waiter, [espresso, espresso], { tableId, tabName: 'Pera' });
    mika = await order(waiter, [pljeskavica], { tableId, tabName: 'Mika' });
    const t = (await ctx.http().get(api('/tables')).set(auth(waiter)).expect(200)).body.find((x: any) => x.id === tableId);
    expect(t.openOrders.map((o: any) => o.tabName)).toEqual(['Pera', 'Mika']);
  });

  it('prebacivanje izabrane stavke na drugu turu (poslata stavka ostaje poslata)', async () => {
    await ctx.http().post(api(`/orders/${pera}/send`)).set(auth(waiter)).send({}).expect(200);
    const p = await get(pera);
    const r = await ctx.http().post(api(`/orders/${pera}/move-items`)).set(auth(waiter))
      .send({ itemIds: [p.items[0].id], toOrderId: mika }).expect(200);
    expect(r.body.from.total).toBe('180.00');
    expect(r.body.to.total).toBe('1170.00');
    expect(r.body.to.items.find((i: any) => i.id === p.items[0].id).status).toBe('SENT');
  });

  it('prebacivanje stavke na novu turu za drugi sto', async () => {
    const tables = (await ctx.http().get(api('/tables')).set(auth(waiter)).expect(200)).body;
    const sto6 = tables.find((t: any) => t.name === 'Sto 6').id;
    const p = await get(pera);
    const r = await ctx.http().post(api(`/orders/${pera}/move-items`)).set(auth(waiter))
      .send({ itemIds: [p.items[0].id], toTableId: sto6, toTabName: 'Šank gost' }).expect(200);
    expect(r.body.from.total).toBe('0.00');
    expect(r.body.from.status).toBe('MERGED'); // bez stavki → izvorni račun se sam zatvara (ne ostaje sto sa 0 RSD)
    expect(r.body.to).toMatchObject({ tableId: sto6, tabName: 'Šank gost', total: '180.00' });
  });

  it('spajanje tura: Žika plaća sve; izvorni računi postaju MERGED; tura sa naplatom se ne spaja', async () => {
    const zika = await order(waiter, [proja], { tableId, tabName: 'Žika' });
    const partial = await order(waiter, [espresso], { tableId, tabName: 'Delimično' });
    await ctx.http().post(api(`/orders/${partial}/payments`)).set(auth(waiter)).send({ method: 'CASH', amount: '50.00', idempotencyKey: idem() }).expect(201);
    expect((await ctx.http().post(api(`/orders/${zika}/merge`)).set(auth(waiter)).send({ fromOrderIds: [partial] }).expect(409)).body.error.code).toBe('ORDER_HAS_PAYMENTS');

    const merged = (await ctx.http().post(api(`/orders/${zika}/merge`)).set(auth(waiter)).send({ fromOrderIds: [mika] }).expect(200)).body;
    expect(merged.total).toBe('1370.00'); // 200 (proja) + 1170 (Mika: pljeskavica + espresso)
    const { rows } = await ctx.pool.query(`SELECT status, merged_into_id FROM orders WHERE id = ANY($1)`, [[mika]]);
    expect(rows.every((r: any) => r.status === 'MERGED' && r.merged_into_id === zika)).toBe(true);
    const paid = await ctx.http().post(api(`/orders/${zika}/payments`)).set(auth(waiter)).send({ method: 'CARD', idempotencyKey: idem() }).expect(201);
    expect(paid.body.order.status).toBe('PAID');
    const h = (await ctx.http().get(api(`/orders/${zika}/history`)).set(auth(manager)).expect(200)).body.map((x: any) => x.action);
    expect(h).toContain('order.merge');
  });

  it('ture se mogu preimenovati', async () => {
    const id = await order(waiter, [espresso], { tableId });
    const r = await ctx.http().patch(api(`/orders/${id}`)).set(auth(waiter)).send({ tabName: 'Druga tura' }).expect(200);
    expect(r.body.tabName).toBe('Druga tura');
  });
});

describe('Storno celog računa', () => {
  it('konobar bez prava ne može; menadžer stornira sve, neposlato se uklanja, račun otkazan', async () => {
    const id = await order(waiter, [espresso, pljeskavica]);
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    await ctx.http().post(api(`/orders/${id}/items`)).set(auth(waiter)).send({ productId: proja }).expect(201); // neposlata
    await ctx.http().post(api(`/orders/${id}/void-all`)).set(auth(waiter)).send({ reason: 'Gost otišao' }).expect(403);
    const r = (await ctx.http().post(api(`/orders/${id}/void-all`)).set(auth(manager)).send({ reason: 'Gost otišao' }).expect(200)).body;
    expect(r.status).toBe('CANCELLED');
    expect(r.items.map((i: any) => i.status)).toEqual(['VOIDED', 'VOIDED']);
    expect(r.total).toBe('0.00');
  });
});
