/**
 * Faza 4: partneri, skladišta, robna dokumenta (nacrt → proknjižen → storniran), PPNC, kartica artikla,
 * normativi sa verzijama i automatski utrošak (idempotentno), popis, otpis, prenos, uvoz/izvoz CSV/XLSX.
 */
import ExcelJS from 'exceljs';
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown } from './setup';
import { consumeForOrder } from '../../src/modules/stock/engine';
import { DB, Db } from '../../src/db/db.module';

let ctx: Ctx;
let waiter: string, cashier: string, manager: string, admin: string;
const api = (p: string) => `/api/v1${p}`;
let kafa: string, mleko: string, meso: string, lepinja: string, espresso: string, kapucino: string, cola: string, pljeskavica: string, kisela: string;
let supplier: string;
let MAIN: string, BAR: string;

beforeAll(async () => {
  ctx = await setupApp();
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  manager = await pinLogin(ctx, '9999');
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!');
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
  await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
  [kafa, mleko, meso, lepinja, espresso, kapucino, cola, pljeskavica, kisela] = await Promise.all(
    ['R001', 'R002', 'R003', 'R004', 'K001', 'K002', 'S001', 'H002', 'S003'].map((c) => productId(ctx, manager, c)));
  supplier = (await ctx.http().get(api('/partners')).set(auth(manager)).expect(200)).body[0].id;
  MAIN = ctx.ids.warehouses.main; BAR = ctx.ids.warehouses.bar;
});
afterAll(() => teardown(ctx));

const bal = async (wh: string, pid: string) => {
  const r = await ctx.pool.query('SELECT quantity, avg_cost FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2', [wh, pid]);
  return r.rows[0] ?? { quantity: '0.0000', avg_cost: '0.0000' };
};
async function doc(kind: string, lines: any[], extra: any = {}, token = manager) {
  const d = (await ctx.http().post(api('/stock/documents')).set(auth(token)).send({ kind, warehouseId: MAIN, ...extra }).expect(201)).body;
  return (await ctx.http().put(api(`/stock/documents/${d.id}/lines`)).set(auth(token)).send({ lines }).expect(200)).body;
}
const post = (id: string, token = manager) => ctx.http().post(api(`/stock/documents/${id}/post`)).set(auth(token)).send({});
async function sell(products: string[], token = waiter) {
  const o = await ctx.http().post(api('/orders')).set(auth(token)).send({}).expect(201);
  for (const p of products) await ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(token)).send({ productId: p }).expect(201);
  await ctx.http().post(api(`/orders/${o.body.id}/send`)).set(auth(token)).send({}).expect(200);
  const r = await ctx.http().post(api(`/orders/${o.body.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CASH' }], idempotencyKey: idem('s') }).expect(201);
  return { id: o.body.id as string, settle: r.body };
}

describe('Prava, partneri, skladišta', () => {
  it('konobar i kasir nemaju pristup lageru', async () => {
    await ctx.http().get(api('/stock/balances')).set(auth(waiter)).expect(403);
    await ctx.http().post(api('/stock/documents')).set(auth(cashier)).send({ kind: 'RECEIPT', warehouseId: MAIN }).expect(403);
    await ctx.http().get(api('/stock/balances')).set(auth(manager)).expect(200);
  });

  it('partner: kontrola PIB-a, jedinstven PIB, izmena', async () => {
    const bad = await ctx.http().post(api('/partners')).set(auth(manager)).send({ name: 'Loš PIB', taxId: '100000025' }).expect(422);
    expect(bad.body.error.code).toBe('INVALID_PIB');
    await ctx.http().post(api('/partners')).set(auth(manager)).send({ name: 'Duplikat', taxId: '100000024' }).expect(409);
    const p = (await ctx.http().post(api('/partners')).set(auth(manager)).send({ name: 'Mlekara Novi Sad', city: 'Novi Sad', kind: 'SUPPLIER' }).expect(201)).body;
    const u = (await ctx.http().patch(api(`/partners/${p.id}`)).set(auth(manager)).send({ phone: '021 111 222' }).expect(200)).body;
    expect(u).toMatchObject({ name: 'Mlekara Novi Sad', phone: '021 111 222' });
    const list = (await ctx.http().get(api('/partners?search=mlekara')).set(auth(manager)).expect(200)).body;
    expect(list).toHaveLength(1);
  });

  it('skladišta: uvek tačno jedno podrazumevano', async () => {
    const ws = (await ctx.http().get(api('/warehouses')).set(auth(manager)).expect(200)).body;
    expect(ws.filter((w: any) => w.isDefault)).toHaveLength(1);
    const r = await ctx.http().patch(api(`/warehouses/${MAIN}`)).set(auth(manager)).send({ isDefault: false }).expect(422);
    expect(r.body.error.code).toBe('DEFAULT_REQUIRED');
    const extra = (await ctx.http().post(api('/warehouses')).set(auth(manager)).send({ name: 'Podrum' }).expect(201)).body;
    await ctx.http().patch(api(`/warehouses/${extra.id}`)).set(auth(manager)).send({ isDefault: true }).expect(200);
    expect((await ctx.http().get(api('/warehouses')).set(auth(manager))).body.filter((w: any) => w.isDefault).map((w: any) => w.id)).toEqual([extra.id]);
    await ctx.http().patch(api(`/warehouses/${MAIN}`)).set(auth(manager)).send({ isDefault: true }).expect(200);
    await expect(ctx.pool.query('UPDATE warehouses SET is_default = true WHERE id = $1', [extra.id])).rejects.toThrow(/warehouses_one_default_uq/);
  });
});

describe('Prijemnica i prosečna nabavna cena', () => {
  let first: any;
  it('validacija stavki: artikal bez zalihe, nedostaje cena, dupla stavka; knjiženje bez partnera odbijeno', async () => {
    const d = (await ctx.http().post(api('/stock/documents')).set(auth(manager)).send({ kind: 'RECEIPT', warehouseId: MAIN }).expect(201)).body;
    expect(d).toMatchObject({ status: 'DRAFT', number: null, displayNumber: null });
    let r = await ctx.http().put(api(`/stock/documents/${d.id}/lines`)).set(auth(manager)).send({ lines: [{ productId: espresso, quantity: '1', unitCost: '1' }] }).expect(422);
    expect(r.body.error.message).toMatch(/nema uključeno vođenje zalihe/);
    r = await ctx.http().put(api(`/stock/documents/${d.id}/lines`)).set(auth(manager)).send({ lines: [{ productId: kafa, quantity: '1' }] }).expect(422);
    expect(r.body.error.message).toMatch(/nabavna cena je obavezna/);
    r = await ctx.http().put(api(`/stock/documents/${d.id}/lines`)).set(auth(manager)).send({ lines: [{ productId: kafa, quantity: '1', unitCost: '1' }, { productId: kafa, quantity: '2', unitCost: '1' }] }).expect(422);
    expect(r.body.error.code).toBe('DUPLICATE_LINE');
    await ctx.http().put(api(`/stock/documents/${d.id}/lines`)).set(auth(manager)).send({ lines: [{ productId: kafa, quantity: '1', unitCost: '1' }] }).expect(200);
    r = await post(d.id).expect(422);
    expect(r.body.error.code).toBe('PARTNER_REQUIRED');
    await ctx.http().post(api(`/stock/documents/${d.id}/cancel`)).set(auth(manager)).send({ reason: 'Test nacrt' }).expect(200);
  });

  it('dve prijemnice: stanje i PPNC = (10×1000 + 5×1600) / 15 = 1200', async () => {
    first = await doc('RECEIPT', [{ productId: kafa, quantity: '10', unitCost: '1000' }, { productId: cola, quantity: '48', unitCost: '95,5' }], { partnerId: supplier, externalNumber: 'F-123/26' });
    const p1 = (await post(first.id).expect(200)).body;
    expect(p1).toMatchObject({ status: 'POSTED', number: 1, displayNumber: 'PRI-1', total: '14584.00', alreadyPosted: false });
    expect(await bal(MAIN, kafa)).toEqual({ quantity: '10.0000', avg_cost: '1000.0000' });
    const second = await doc('RECEIPT', [{ productId: kafa, quantity: '5', unitCost: '1600' }], { partnerId: supplier });
    expect((await post(second.id).expect(200)).body.displayNumber).toBe('PRI-2');
    expect(await bal(MAIN, kafa)).toEqual({ quantity: '15.0000', avg_cost: '1200.0000' });
    expect(await bal(MAIN, cola)).toEqual({ quantity: '48.0000', avg_cost: '95.5000' });
  });

  it('ponovno knjiženje je idempotentno; proknjižen dokument se ne menja', async () => {
    const again = (await post(first.id).expect(200)).body;
    expect(again.alreadyPosted).toBe(true);
    const n = (await ctx.pool.query('SELECT count(*)::int c FROM stock_movements WHERE document_id = $1', [first.id])).rows[0].c;
    expect(n).toBe(2);
    const r = await ctx.http().put(api(`/stock/documents/${first.id}/lines`)).set(auth(manager)).send({ lines: [] }).expect(409);
    expect(r.body.error.code).toBe('DOC_NOT_DRAFT');
  });

  it('kartica artikla: kretanja sa stanjem i cenom posle svakog', async () => {
    const c = (await ctx.http().get(api(`/stock/card?productId=${kafa}&warehouseId=${MAIN}`)).set(auth(manager)).expect(200)).body;
    expect(c.movements.map((m: any) => [m.in, m.balanceAfter, m.avgCostAfter])).toEqual([
      ['10.0000', '10.0000', '1000.0000'], ['5.0000', '15.0000', '1200.0000'],
    ]);
    expect(c.movements[0].description).toMatch(/Prijemnica.*PRI-1.*Demo dobavljač/);
    expect(c.closing).toEqual({ quantity: '15.0000', avgCost: '1200.0000' });
  });
});

describe('Izlazi: bez minusa za ručna dokumenta, atomsko knjiženje', () => {
  it('otpis više nego što ima → INSUFFICIENT_STOCK i ništa se ne knjiži (ni ispravna stavka)', async () => {
    const d = await doc('WRITE_OFF', [{ productId: cola, quantity: '2' }, { productId: kafa, quantity: '999' }]);
    const r = await post(d.id).expect(422);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(r.body.error.details).toMatchObject({ productId: kafa, available: '15.0000', required: '999.0000' });
    expect(await bal(MAIN, cola)).toEqual({ quantity: '48.0000', avg_cost: '95.5000' });
    expect((await ctx.http().get(api(`/stock/documents/${d.id}`)).set(auth(manager))).body.status).toBe('DRAFT');
    await ctx.http().post(api(`/stock/documents/${d.id}/cancel`)).set(auth(manager)).send({ reason: 'pogrešno' }).expect(200);
  });

  it('dva paralelna izlaza koja zajedno premašuju stanje → tačno jedan uspeva', async () => {
    const a = await doc('INTERNAL', [{ productId: cola, quantity: '30' }]);
    const b = await doc('INTERNAL', [{ productId: cola, quantity: '30' }]);
    const rs = await Promise.all([post(a.id), post(b.id)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 422]);
    expect((await bal(MAIN, cola)).quantity).toBe('18.0000');
    const failed = rs[0].status === 422 ? a : b;
    await ctx.http().post(api(`/stock/documents/${failed.id}/cancel`)).set(auth(manager)).send({ reason: 'test' }).expect(200);
  });

  it('prenos glavni → šank po PPNC; isto skladište odbijeno', async () => {
    const same = await ctx.http().post(api('/stock/documents')).set(auth(manager)).send({ kind: 'TRANSFER', warehouseId: MAIN, targetWarehouseId: MAIN }).expect(422);
    expect(same.body.error.code).toBe('SAME_WAREHOUSE');
    const t = await doc('TRANSFER', [{ productId: kafa, quantity: '3' }, { productId: cola, quantity: '12' }], { targetWarehouseId: BAR });
    expect((await post(t.id).expect(200)).body.displayNumber).toBe('MP-1');
    expect(await bal(MAIN, kafa)).toEqual({ quantity: '12.0000', avg_cost: '1200.0000' });
    expect(await bal(BAR, kafa)).toEqual({ quantity: '3.0000', avg_cost: '1200.0000' });
    expect(await bal(BAR, cola)).toEqual({ quantity: '12.0000', avg_cost: '95.5000' });
  });
});

describe('Normativi i automatski utrošak', () => {
  it('prodaja troši po normativu iz skladišta pozicije; artikal sa zalihom troši sebe; minus je dozvoljen pri prodaji', async () => {
    const { id } = await sell([espresso, espresso, kapucino, cola, pljeskavica]);
    const mv = (await ctx.pool.query(`SELECT m.quantity, m.warehouse_id, p.code FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE m.order_id = $1 ORDER BY p.code, m.quantity`, [id])).rows;
    // šank (pozicija Šank → skladište Šank): 2 espresso + kapućino kafa 3 × 0,008; mleko 0,12; cola 1
    expect(mv.map((m) => [m.code, m.quantity, m.warehouse_id === BAR ? 'BAR' : 'MAIN'])).toEqual([
      ['R001', '-0.0080', 'BAR'], ['R001', '-0.0080', 'BAR'], ['R001', '-0.0080', 'BAR'],
      ['R002', '-0.1200', 'BAR'], ['R003', '-0.2500', 'MAIN'], ['R004', '-1.0000', 'MAIN'], ['S001', '-1.0000', 'BAR'],
    ].sort() as any);
    expect(await bal(BAR, kafa)).toEqual({ quantity: '2.9760', avg_cost: '1200.0000' });
    expect(await bal(BAR, mleko)).toMatchObject({ quantity: '-0.1200' }); // nije bilo prijema — minus je vidljiv
    const b = (await ctx.http().get(api(`/stock/balances?warehouseId=${BAR}&search=mleko`)).set(auth(manager)).expect(200)).body;
    expect(b.data[0]).toMatchObject({ name: 'Mleko', quantity: '-0.1200', negative: true });
  });

  it('utrošak je idempotentan: ponovni poziv i ponovljena naplata ne troše ponovo; baza odbija duplikat', async () => {
    const { id, settle } = await sell([espresso]);
    const count = async () => (await ctx.pool.query('SELECT count(*)::int c FROM stock_movements WHERE order_id = $1', [id])).rows[0].c;
    expect(await count()).toBe(1);
    const db = ctx.app.get<Db>(DB);
    const userId = (await ctx.pool.query(`SELECT id FROM users WHERE full_name = 'Ana Kasir'`)).rows[0].id;
    await db.transaction((tx) => consumeForOrder(tx, id, userId));
    expect(await count()).toBe(1);
    void settle;
    const [m] = (await ctx.pool.query('SELECT * FROM stock_movements WHERE order_id = $1', [id])).rows;
    await expect(ctx.pool.query(
      `INSERT INTO stock_movements (location_id, warehouse_id, product_id, quantity, unit_cost, value, balance_after, avg_cost_after, source, order_id, order_item_id)
       VALUES ($1, $2, $3, -1, 0, 0, 0, 0, 'SALE', $4, $5)`, [m.location_id, m.warehouse_id, m.product_id, m.order_id, m.order_item_id],
    )).rejects.toThrow(/stock_movements_sale_uq/);
  });

  it('stornirana stavka se ne troši; artikal bez zalihe i bez normativa ne troši ništa', async () => {
    const o = await ctx.http().post(api('/orders')).set(auth(waiter)).send({}).expect(201);
    const a = (await ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(waiter)).send({ productId: espresso }).expect(201)).body.items[0];
    await ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(waiter)).send({ productId: await productId(ctx, waiter, 'P001') }).expect(201);
    await ctx.http().post(api(`/orders/${o.body.id}/send`)).set(auth(waiter)).send({}).expect(200);
    await ctx.http().post(api(`/orders/${o.body.id}/items/${a.id}/void`)).set(auth(manager)).send({ reason: 'greška' }).expect(200);
    await ctx.http().post(api(`/orders/${o.body.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CARD' }], idempotencyKey: idem('v') }).expect(201);
    expect((await ctx.pool.query('SELECT count(*)::int c FROM stock_movements WHERE order_id = $1', [o.body.id])).rows[0].c).toBe(0);
  });

  it('verzije normativa: nacrt ne utiče; aktivacija povlači prethodnu; prodaja beleži korišćenu verziju', async () => {
    const list = (await ctx.http().get(api(`/recipes?productId=${espresso}`)).set(auth(manager)).expect(200)).body;
    expect(list).toHaveLength(1);
    const v1 = list[0];
    expect(v1).toMatchObject({ version: 1, status: 'ACTIVE' });
    let r = await ctx.http().put(api(`/recipes/${v1.id}`)).set(auth(manager)).send({ lines: [{ componentId: kafa, quantity: '0.009' }] }).expect(409);
    expect(r.body.error.code).toBe('RECIPE_NOT_DRAFT');
    r = await ctx.http().post(api('/recipes')).set(auth(manager)).send({ productId: espresso, lines: [{ componentId: espresso, quantity: '1' }] }).expect(422);
    expect(r.body.error.code).toBe('SELF_COMPONENT');
    r = await ctx.http().post(api('/recipes')).set(auth(manager)).send({ productId: espresso, lines: [{ componentId: kapucino, quantity: '1' }] }).expect(422);
    expect(r.body.error.message).toMatch(/nema uključeno vođenje zalihe/);
    const v2 = (await ctx.http().post(api('/recipes')).set(auth(manager)).send({ productId: espresso, lines: [{ componentId: kafa, quantity: '0,009' }], note: 'dupli shot' }).expect(201)).body;
    expect(v2).toMatchObject({ version: 2, status: 'DRAFT' });
    let { id } = await sell([espresso]);
    expect((await ctx.pool.query('SELECT recipe_id, quantity FROM stock_movements WHERE order_id = $1', [id])).rows[0]).toEqual({ recipe_id: v1.id, quantity: '-0.0080' });
    await ctx.http().post(api(`/recipes/${v2.id}/activate`)).set(auth(manager)).send({}).expect(200);
    const after = (await ctx.http().get(api(`/recipes?productId=${espresso}`)).set(auth(manager))).body;
    expect(after.map((x: any) => [x.version, x.status])).toEqual([[2, 'ACTIVE'], [1, 'RETIRED']]);
    ({ id } = await sell([espresso]));
    expect((await ctx.pool.query('SELECT recipe_id, quantity FROM stock_movements WHERE order_id = $1', [id])).rows[0]).toEqual({ recipe_id: v2.id, quantity: '-0.0090' });
    await ctx.http().post(api(`/recipes/${v1.id}/activate`)).set(auth(manager)).send({}).expect(409);
  });
});

describe('Storno, popis, otpis', () => {
  it('storno prijemnice: suprotna kretanja po istoj ceni, PPNC se vraća; storno koji bi otišao u minus je odbijen', async () => {
    const before = await bal(MAIN, kafa);
    const d = await doc('RECEIPT', [{ productId: kafa, quantity: '6', unitCost: '1500' }], { partnerId: supplier });
    await post(d.id).expect(200);
    expect(await bal(MAIN, kafa)).toEqual({ quantity: '18.0000', avg_cost: '1300.0000' }); // (12×1200 + 6×1500)/18
    const c = (await ctx.http().post(api(`/stock/documents/${d.id}/cancel`)).set(auth(manager)).send({ reason: 'Pogrešna faktura' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'CANCELLED', cancelReason: 'Pogrešna faktura' });
    expect(await bal(MAIN, kafa)).toEqual(before);
    const card = (await ctx.http().get(api(`/stock/card?productId=${kafa}&warehouseId=${MAIN}`)).set(auth(manager))).body;
    expect(card.movements.slice(-1)[0]).toMatchObject({ source: 'REVERSAL', out: '6.0000', unitCost: '1500.0000' });
    await ctx.http().post(api(`/stock/documents/${d.id}/cancel`)).set(auth(manager)).send({ reason: 'opet' }).expect(409);

    // roba sa prijemnice je potrošena → storno bi doveo do minusa
    const d2 = await doc('RECEIPT', [{ productId: lepinja, quantity: '2', unitCost: '30' }], { partnerId: supplier });
    await post(d2.id).expect(200);
    const off = await doc('WRITE_OFF', [{ productId: lepinja, quantity: '1' }]);
    await post(off.id).expect(200);
    const r = await ctx.http().post(api(`/stock/documents/${d2.id}/cancel`)).set(auth(manager)).send({ reason: 'test' }).expect(422);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('popis: predlog iz knjižnog stanja, snimak knjižnog stanja, kretanja samo za razlike', async () => {
    const d = (await ctx.http().post(api('/stock/documents')).set(auth(manager)).send({ kind: 'STOCKTAKE', warehouseId: BAR }).expect(201)).body;
    const kafaBook = (await bal(BAR, kafa)).quantity;
    const filled = (await ctx.http().post(api(`/stock/documents/${d.id}/fill-stocktake`)).set(auth(manager)).send({}).expect(200)).body;
    const byCode = Object.fromEntries(filled.lines.map((l: any) => [l.code, l]));
    expect(byCode.R001.quantity).toBe(kafaBook); // predlog = knjižno stanje
    expect(byCode.R002.quantity).toBe('0.0000'); // knjižno je u minusu → predlog 0
    const lines = filled.lines.map((l: any) => ({ productId: l.productId, quantity: l.code === 'S001' ? '10' : l.quantity }));
    await ctx.http().put(api(`/stock/documents/${d.id}/lines`)).set(auth(manager)).send({ lines }).expect(200);
    const colaBefore = await bal(BAR, cola);
    const p = (await post(d.id).expect(200)).body;
    const colaLine = p.lines.find((l: any) => l.code === 'S001');
    expect(colaLine).toMatchObject({ quantity: '10.0000', bookQuantity: colaBefore.quantity });
    expect(colaLine.difference).toBe((10 - Number(colaBefore.quantity)).toFixed(4));
    expect((await bal(BAR, cola)).quantity).toBe('10.0000');
    expect((await bal(BAR, mleko)).quantity).toBe('0.0000'); // minus izjednačen popisom
    const moves = (await ctx.pool.query('SELECT count(*)::int c FROM stock_movements WHERE document_id = $1', [d.id])).rows[0].c;
    const diffs = p.lines.filter((l: any) => l.difference !== '0.0000').length;
    expect(moves).toBe(diffs);
  });

  it('kartica: period sa početnim stanjem', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const c = (await ctx.http().get(api(`/stock/card?productId=${kafa}&warehouseId=${MAIN}&from=${tomorrow}`)).set(auth(manager)).expect(200)).body;
    expect(c.movements).toHaveLength(0);
    expect(c.opening).toEqual(c.closing);
    expect(c.opening.quantity).toBe((await bal(MAIN, kafa)).quantity);
  });
});

describe('Kasa i sirovine', () => {
  it('kasa ne nudi sirovine i ne dozvoljava ih na računu', async () => {
    const sellable = (await ctx.http().get(api('/products?sellable=true&pageSize=500')).set(auth(waiter)).expect(200)).body.data;
    expect(sellable.map((p: any) => p.code)).not.toContain('R001');
    const rawOnly = (await ctx.http().get(api('/products?sellable=false&pageSize=500')).set(auth(waiter)).expect(200)).body.data;
    expect(rawOnly.map((p: any) => p.code).sort()).toEqual(['R001', 'R002', 'R003', 'R004']);
    const all = (await ctx.http().get(api('/products?includeInactive=false&pageSize=500')).set(auth(waiter)).expect(200)).body.data;
    expect(all.length).toBe(sellable.length + rawOnly.length);
    const o = await ctx.http().post(api('/orders')).set(auth(waiter)).send({}).expect(201);
    const r = await ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(waiter)).send({ productId: kafa }).expect(422);
    expect(r.body.error.code).toBe('PRODUCT_NOT_SELLABLE');
    void kisela; void meso;
  });
});

describe('Uvoz i izvoz', () => {
  const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

  it('pregled: greške po redovima (cena, kategorija, PDV, duplikat, da/ne); potvrda sa greškama se odbija u celosti', async () => {
    const csv = [
      'Šifra;Naziv;Kategorija;PDV oznaka;Cena;Jedinica mere;Lager;Prodaja',
      'N001;Limunada;Bezalkoholna pića;Đ;280,00;kom;ne;da',
      'N002;Ledeni čaj;Nepostojeća;Đ;250;kom;ne;da',
      'N003;Tonik;Bezalkoholna pića;X;1.250,50;kom;ne;da',
      'N001;Duplikat;Bezalkoholna pića;Đ;100;kom;ne;da',
      'N004;Sok od jabuke;Bezalkoholna pića;Đ;abc;kom;možda;da',
      'K001;Espresso (nova cena);Topli napici;Đ;190;kom;ne;da',
    ].join('\r\n');
    const p = (await ctx.http().post(api('/import/products/preview')).set(auth(manager)).send({ fileName: 'artikli.csv', content: b64(csv) }).expect(200)).body;
    expect(p).toMatchObject({ format: 'csv', total: 6, valid: 2, invalid: 4, creates: 1, updates: 1 });
    const byRow = Object.fromEntries(p.rows.map((r: any) => [r.row, r]));
    expect(byRow[2]).toMatchObject({ action: 'create', errors: [] });
    expect(byRow[3].errors[0]).toMatch(/Kategorija „Nepostojeća“ ne postoji/);
    expect(byRow[4].errors[0]).toMatch(/PDV oznaka „X“/);
    expect(byRow[5].errors[0]).toMatch(/ponavlja u fajlu \(prvi put u redu 2\)/);
    expect(byRow[6].errors).toEqual(expect.arrayContaining([expect.stringMatching(/Cena „abc“/), expect.stringMatching(/Lager: očekuje se da\/ne/)]));
    expect(byRow[7]).toMatchObject({ action: 'update', errors: [] });

    const fail = await ctx.http().post(api('/import/products/commit')).set(auth(manager)).send({ fileName: 'artikli.csv', content: b64(csv) }).expect(422);
    expect(fail.body.error.code).toBe('IMPORT_HAS_ERRORS');
    expect(fail.body.error.details.invalid.map((x: any) => x.row)).toEqual([3, 4, 5, 6]);
    expect((await ctx.pool.query(`SELECT count(*)::int c FROM products WHERE code = 'N001'`)).rows[0].c).toBe(0);

    const ok = (await ctx.http().post(api('/import/products/commit')).set(auth(manager)).send({ fileName: 'artikli.csv', content: b64(csv), skipInvalid: true }).expect(200)).body;
    expect(ok).toMatchObject({ total: 6, created: 1, updated: 1 });
    expect(ok.skipped.map((x: any) => x.row)).toEqual([3, 4, 5, 6]);
    const k = (await ctx.pool.query(`SELECT name, price FROM products WHERE code = 'K001'`)).rows[0];
    expect(k).toEqual({ name: 'Espresso (nova cena)', price: '190.00' });
    const hist = (await ctx.pool.query(`SELECT old_price, new_price FROM product_price_changes c JOIN products p ON p.id = c.product_id WHERE p.code = 'K001' ORDER BY changed_at`)).rows;
    expect(hist.slice(-1)[0]).toEqual({ old_price: '180.00', new_price: '190.00' });
  });

  it('nedostaju obavezne kolone → jasna greška; nepoznat format odbijen', async () => {
    const r = await ctx.http().post(api('/import/products/preview')).set(auth(manager)).send({ fileName: 'a.csv', content: b64('Naziv;Cena\nX;1') }).expect(422);
    expect(r.body.error.code).toBe('MISSING_COLUMNS');
    expect(r.body.error.message).toMatch(/Šifra.*Kategorija.*PDV oznaka/);
    await ctx.http().post(api('/import/products/preview')).set(auth(manager)).send({ fileName: 'a.pdf', content: b64('x') }).expect(422);
  });

  it('XLSX partneri: novi i izmena po PIB-u; neispravan PIB u izveštaju', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('p');
    ws.addRow(['Naziv', 'PIB', 'Mesto', 'Vrsta']);
    ws.addRow(['Demo dobavljač (izmenjen)', '100000024', 'Zemun', 'dobavljač']);
    ws.addRow(['Pekara Klas', '', 'Beograd', 'dobavljač']);
    ws.addRow(['Loš PIB d.o.o.', '123456789', '', 'kupac']);
    const content = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const p = (await ctx.http().post(api('/import/partners/preview')).set(auth(manager)).send({ fileName: 'partneri.xlsx', content }).expect(200)).body;
    expect(p).toMatchObject({ format: 'xlsx', valid: 2, invalid: 1, creates: 1, updates: 1 });
    expect(p.rows[2].errors[0]).toMatch(/PIB „123456789“ nije ispravan/);
    const ok = (await ctx.http().post(api('/import/partners/commit')).set(auth(manager)).send({ fileName: 'partneri.xlsx', content, skipInvalid: true }).expect(200)).body;
    expect(ok).toMatchObject({ created: 1, updated: 1, skipped: [{ row: 4 }] });
    expect((await ctx.pool.query(`SELECT name, city FROM partners WHERE tax_id = '100000024'`)).rows[0]).toEqual({ name: 'Demo dobavljač (izmenjen)', city: 'Zemun' });
  });

  it('uvoz stavki u nacrt prijemnice (CSV sa zarezom kao separatorom)', async () => {
    const d = (await ctx.http().post(api('/stock/documents')).set(auth(manager)).send({ kind: 'RECEIPT', warehouseId: MAIN, partnerId: supplier }).expect(201)).body;
    const csv = 'sifra,kolicina,cena\nR002,"12,5",110\nR004,40,"28,5"\nS999,1,1\n';
    const p = (await ctx.http().post(api('/import/document-lines/preview')).set(auth(manager)).send({ fileName: 'stavke.csv', content: b64(csv), documentId: d.id }).expect(200)).body;
    expect(p).toMatchObject({ valid: 2, invalid: 1 });
    expect(p.rows[2].errors[0]).toMatch(/šifrom „S999“ ne postoji/);
    await ctx.http().post(api('/import/document-lines/commit')).set(auth(manager)).send({ fileName: 'stavke.csv', content: b64(csv), documentId: d.id, skipInvalid: true }).expect(200);
    const full = (await ctx.http().get(api(`/stock/documents/${d.id}`)).set(auth(manager))).body;
    expect(full.lines.map((l: any) => [l.code, l.quantity, l.unitCost])).toEqual([['R002', '12.5000', '110.0000'], ['R004', '40.0000', '28.5000']]);
    expect(full.total).toBe('2515.00');
  });

  it('izvoz: CSV (BOM, ";", decimalni zarez) i XLSX; izvezeni XLSX se ponovo uvozi bez grešaka', async () => {
    const csv = await ctx.http().get(api('/export/products?format=csv')).set(auth(manager)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    const text = (csv.body as Buffer).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Šifra;Naziv;Kategorija;PDV oznaka;Cena');
    expect(text).toMatch(/K002;Kapućino;Topli napici;Đ;230;kom;;ne;da/);
    const x = await ctx.http().get(api('/export/products?format=xlsx')).set(auth(manager)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(x.headers['content-disposition']).toMatch(/attachment; filename="artikli-\d{4}-\d{2}-\d{2}\.xlsx"/);
    const p = (await ctx.http().post(api('/import/products/preview')).set(auth(manager)).send({ fileName: 'artikli.xlsx', content: (x.body as Buffer).toString('base64') }).expect(200)).body;
    expect(p.invalid).toBe(0);
    expect(p.updates).toBe(p.total);
    const st = await ctx.http().get(api('/export/stock-balances?format=csv')).set(auth(manager)).expect(200);
    expect(st.text).toContain('Skladište;Šifra;Naziv;Jedinica mere;Količina;Prosečna nabavna cena;Vrednost');
    await ctx.http().get(api('/export/products')).set(auth(waiter)).expect(403);
  });
});
