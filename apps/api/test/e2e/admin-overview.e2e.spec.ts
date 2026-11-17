/**
 * Početna ADMIN-a (/admin/overview: promet dana, upozorenja, kontrolna lista) i predlog poslednje nabavne cene.
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
});
afterAll(() => teardown(ctx));

describe('Predlog narudžbine', () => {
  it('ispod minimuma: naručiti do minimuma, sa dobavljačem i cenom poslednje fakture', async () => {
    const kola = await productId(ctx, admin, 'S001');
    const supplier = (await ctx.http().get(api('/partners')).set(auth(admin)).expect(200)).body[0];
    const d = (await ctx.http().post(api('/stock/documents')).set(auth(manager)).send({ kind: 'RECEIPT', warehouseId: ctx.ids.warehouses.main, partnerId: supplier.id }).expect(201)).body;
    await ctx.http().put(api(`/stock/documents/${d.id}/lines`)).set(auth(manager)).send({ lines: [{ productId: kola, quantity: '5', unitCost: '80.00' }] }).expect(200);
    await ctx.http().post(api(`/stock/documents/${d.id}/post`)).set(auth(manager)).send({}).expect(200);
    const stock = Number((await ctx.pool.query('SELECT coalesce(sum(quantity),0) q FROM stock_balances WHERE product_id = $1', [kola])).rows[0].q);
    await ctx.http().patch(api(`/products/${kola}`)).set(auth(admin)).send({ minStock: String(stock + 10.4) }).expect(200);
    const r = (await ctx.http().get(api('/stock/reorder?days=14&cover=7')).set(auth(admin)).expect(200)).body;
    const it = r.items.find((x: any) => x.productId === kola);
    expect(it).toMatchObject({ suggest: '11', partnerId: supplier.id, partner: supplier.name });
    expect(Number(it.lastCost)).toBe(80);
    await ctx.http().get(api('/stock/reorder?days=0')).set(auth(admin)).expect(400);
  });
});

describe('Uvoz artikala iz drugog programa', () => {
  it('drugi nazivi kolona, PDV kao stopa, nove grupe samo uz izbor', async () => {
    const csv = 'Šifra artikla;Naziv artikla;Grupa artikala;Stopa PDV;MPC;JM\r\nX100;Limunada 0,3;Limunade;20%;290,00;kom\r\nX101;Ledeni čaj;Limunade;20;260;kom\r\n';
    const body = { fileName: 'stari-program.csv', content: Buffer.from(csv, 'utf8').toString('base64') };
    const p1 = (await ctx.http().post(api('/import/products/preview')).set(auth(admin)).send(body).expect(200)).body;
    expect(p1.invalid).toBe(2);
    expect(p1.rows[0].errors.join(' ')).toContain('Limunade');
    const p2 = (await ctx.http().post(api('/import/products/preview')).set(auth(admin)).send({ ...body, createCategories: true }).expect(200)).body;
    expect(p2).toMatchObject({ invalid: 0, creates: 2, newCategories: ['Limunade'] });
    const r = (await ctx.http().post(api('/import/products/commit')).set(auth(admin)).send({ ...body, createCategories: true }).expect(200)).body;
    expect(r).toMatchObject({ created: 2 });
    const cats = (await ctx.http().get(api('/categories')).set(auth(admin)).expect(200)).body;
    expect(cats.filter((c: any) => c.name === 'Limunade')).toHaveLength(1);
    const p = (await ctx.http().get(api('/products?search=Limunada')).set(auth(admin)).expect(200)).body.data[0];
    expect(p).toMatchObject({ code: 'X100', price: '290.00' });
  });
});

describe('Početna ADMIN-a', () => {
  it('bez otvorenog dana: nema prometa, kontrolna lista postoji', async () => {
    const o = (await ctx.http().get(api('/admin/overview')).set(auth(admin)).expect(200)).body;
    expect(o.day).toBeNull();
    expect(o.sales).toBeNull();
    expect(o.checklist.length).toBeGreaterThan(5);
    expect(o.checklist.find((c: any) => c.id === 'products')).toMatchObject({ done: true });
    expect(o.checklist.find((c: any) => c.label.startsWith('Fiskalizacija'))).toMatchObject({ done: false });
  });

  it('promet dana po načinu plaćanja, otvoreni računi, zaliha ispod minimuma', async () => {
    await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
    await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
    const espresso = await productId(ctx, admin, 'K001');
    const paid = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: idem('o') }).expect(201)).body;
    await ctx.http().post(api(`/orders/${paid.id}/items`)).set(auth(waiter)).send({ productId: espresso }).expect(201);
    await ctx.http().post(api(`/orders/${paid.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CARD' }], idempotencyKey: idem('p') }).expect(201);
    const open = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: idem('o') }).expect(201)).body;
    await ctx.http().post(api(`/orders/${open.id}/items`)).set(auth(waiter)).send({ productId: espresso }).expect(201);
    const kisela = await productId(ctx, admin, 'S003');
    await ctx.http().patch(api(`/products/${kisela}`)).set(auth(admin)).send({ minStock: '100000' }).expect(200);

    const o = (await ctx.http().get(api('/admin/overview')).set(auth(admin)).expect(200)).body;
    expect(o.day).not.toBeNull();
    expect(o.sales).toMatchObject({ paidCount: 1, openCount: 1 });
    expect(Number(o.sales.byMethod.CARD)).toBe(Number(o.sales.paidTotal));
    expect(o.lowStock.map((l: any) => l.name)).toContain('Kisela voda 0,33');
    await ctx.http().get(api('/admin/overview')).set(auth(waiter)).expect(403);
  });

  it('poslednja nabavna cena artikla (proknjižena ulazna faktura)', async () => {
    const kisela = await productId(ctx, admin, 'S003');
    const supplier = (await ctx.http().get(api('/partners')).set(auth(admin)).expect(200)).body[0];
    const d = (await ctx.http().post(api('/stock/documents')).set(auth(manager)).send({ kind: 'RECEIPT', warehouseId: ctx.ids.warehouses.main, partnerId: supplier.id }).expect(201)).body;
    await ctx.http().put(api(`/stock/documents/${d.id}/lines`)).set(auth(manager)).send({ lines: [{ productId: kisela, quantity: '10', unitCost: '61.50' }] }).expect(200);
    // nacrt se ne računa
    const before = (await ctx.http().get(api(`/products/${kisela}/last-cost`)).set(auth(admin)).expect(200)).body;
    expect(before?.unitCost === undefined || Number(before.unitCost) !== 61.5).toBe(true);
    await ctx.http().post(api(`/stock/documents/${d.id}/post`)).set(auth(manager)).send({}).expect(200);
    const last = (await ctx.http().get(api(`/products/${kisela}/last-cost`)).set(auth(admin)).expect(200)).body;
    expect(Number(last.unitCost)).toBe(61.5);
    expect(last.partner).toBe(supplier.name);
  });
});
