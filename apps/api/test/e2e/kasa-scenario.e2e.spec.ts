/**
 * Ceo radni tok konobara na kasi, korak po korak, sa proverom zbira i vlasnika posle svakog koraka:
 * kucanje, delimično prebacivanje na drugi sto, ceo sto na prazan sto, drugom konobaru i nazad, sto pa konobar,
 * storno stavke, spajanje porudžbine sa drugim stolom, prazan sto na drugi sto, i svi načini naplate
 * (gotovina sa kusurom, kartica, miks, virman, reprezentacija, popust, kupac), povraćaj, pregled (F2).
 */
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown } from './setup';

let ctx: Ctx;
let admin: string, marko: string, mika: string, cashier: string, manager: string;
let markoId: string, mikaId: string;
let espresso: string, cola: string, pljeskavica: string;
let tables: any[];
const api = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  ctx = await setupApp();
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!', ctx.ids.posDevice);
  marko = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  manager = await pinLogin(ctx, '9999');
  const roles = (await ctx.http().get(api('/roles')).set(auth(admin)).expect(200)).body as any[];
  const waiterRole = roles.find((r) => r.code === 'WAITER');
  const m = (await ctx.http().post(api('/users')).set(auth(admin)).send({ firstName: 'Mika', lastName: 'Konobar', username: 'mika', roleId: waiterRole.id, pin: '4444' }).expect(201)).body;
  mikaId = m.id;
  mika = await pinLogin(ctx, '4444');
  markoId = (await ctx.http().get(api('/auth/me')).set(auth(marko)).expect(200)).body.user.userId;
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
  await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '1000.00' }).expect(201);
  [espresso, cola, pljeskavica] = await Promise.all(['K001', 'S001', 'H002'].map((c) => productId(ctx, admin, c)));
  tables = (await ctx.http().get(api('/tables')).set(auth(admin)).expect(200)).body;
});
afterAll(() => teardown(ctx));

const get = async (id: string, t = manager) => (await ctx.http().get(api(`/orders/${id}`)).set(auth(t)).expect(200)).body;
const open = async (t: string, tableId: string | null) => (await ctx.http().post(api('/orders')).set(auth(t)).send({ ...(tableId ? { tableId } : {}), idempotencyKey: idem('o') }).expect(201)).body;
const add = async (t: string, id: string, productId: string, n = 1) => { let o; for (let i = 0; i < n; i++) o = (await ctx.http().post(api(`/orders/${id}/items`)).set(auth(t)).send({ productId }).expect(201)).body; return o; };
const send = (t: string, id: string) => ctx.http().post(api(`/orders/${id}/send`)).set(auth(t)).send({}).expect(200);
const tableOrders = async (tableId: string) => (await ctx.http().get(api(`/orders?status=OPEN&tableId=${tableId}`)).set(auth(manager)).expect(200)).body as any[];
const sumItems = (o: any) => o.items.filter((i: any) => i.status !== 'VOIDED').reduce((a: number, i: any) => a + Number(i.quantity), 0);
const settle = (t: string, id: string, parts: any[]) => ctx.http().post(api(`/orders/${id}/settle`)).set(auth(t)).send({ parts, idempotencyKey: idem('p') });

describe('Prebacivanja', () => {
  it('delimično prebacivanje na drugi sto, pa ceo sto na prazan sto: zbir se ne gubi', async () => {
    const [t1, t2, t3] = [tables[0], tables[1], tables[2]];
    const o = await open(marko, t1.id);
    await add(marko, o.id, espresso, 3); await add(marko, o.id, cola, 2); await send(marko, o.id);
    const full = await get(o.id);
    const total = Number(full.total);
    const esp = full.items.find((i: any) => i.productId === espresso);
    // 1 od 3 espressa na sto 2
    await ctx.http().post(api(`/orders/${o.id}/move-items`)).set(auth(marko)).send({ itemIds: [esp.id], quantities: ['1'], toTableId: t2.id }).expect(200);
    const a = await get(o.id), [b] = await tableOrders(t2.id);
    expect(sumItems(a)).toBe(4);
    expect(sumItems(await get(b.id))).toBe(1);
    expect(Number(a.total) + Number(b.total)).toBeCloseTo(total);
    // ceo sto 2 na prazan sto 3
    await ctx.http().post(api(`/orders/${b.id}/move-table`)).set(auth(marko)).send({ toTableId: t3.id }).expect(200);
    expect(await tableOrders(t2.id)).toHaveLength(0);
    expect((await tableOrders(t3.id))[0].id).toBe(b.id);
  });

  it('drugom konobaru i nazad; sto pa konobar - vlasnik i zbir ostaju tačni', async () => {
    const [t4, t5] = [tables[3], tables[4]];
    const o = await open(marko, t4.id);
    await add(marko, o.id, pljeskavica, 2); await send(marko, o.id);
    await ctx.http().post(api('/orders/transfer')).set(auth(marko)).send({ orderIds: [o.id], toUserId: mikaId }).expect(200);
    expect((await get(o.id)).waiterId).toBe(mikaId);
    // Mika sada radi na stolu, Marko više ne može da ga menja kao svoj
    await add(mika, o.id, cola, 1);
    await ctx.http().post(api('/orders/transfer')).set(auth(mika)).send({ orderIds: [o.id], toUserId: markoId }).expect(200);
    const back = await get(o.id);
    expect(back.waiterId).toBe(markoId);
    expect(sumItems(back)).toBe(3);
    // na sto 5 pa Miki
    await ctx.http().post(api(`/orders/${o.id}/move-table`)).set(auth(marko)).send({ toTableId: t5.id }).expect(200);
    await ctx.http().post(api('/orders/transfer')).set(auth(marko)).send({ orderIds: [o.id], toUserId: mikaId }).expect(200);
    const fin = await get(o.id);
    expect(fin.tableId).toBe(t5.id);
    expect(fin.waiterId).toBe(mikaId);
    expect(Number(fin.total)).toBeCloseTo(back.total * 1);
  });

  it('prazan sto (ništa otkucano) se prebacuje na drugi sto', async () => {
    const o = await open(marko, tables[5].id);
    await ctx.http().post(api(`/orders/${o.id}/move-table`)).set(auth(marko)).send({ toTableId: tables[6].id }).expect(200);
    expect((await get(o.id)).tableId).toBe(tables[6].id);
  });

  it('storno stavke: konobar bez prava ne može; menadžer može; zbir se umanjuje', async () => {
    const o = await open(marko, tables[7].id);
    await add(marko, o.id, espresso, 2); await send(marko, o.id);
    const it = (await get(o.id)).items[0];
    await ctx.http().post(api(`/orders/${o.id}/items/${it.id}/void`)).set(auth(marko)).send({ reason: 'Pogrešno uneto', quantity: '1' }).expect(403);
    const after = (await ctx.http().post(api(`/orders/${o.id}/items/${it.id}/void`)).set(auth(manager)).send({ reason: 'Pogrešno uneto', quantity: '1' }).expect(200)).body;
    expect(sumItems(after)).toBe(1);
    expect(Number(after.total)).toBeCloseTo(Number(it.unitPrice));
  });

  it('spoji porudžbinu: tura sa jednog stola ide u račun drugog stola', async () => {
    const a = await open(marko, tables[tables.length - 1].id); await add(marko, a.id, cola, 1);
    const b = await open(marko, tables[tables.length - 2].id); await add(marko, b.id, espresso, 1);
    const before = Number((await get(a.id)).total) + Number((await get(b.id)).total);
    const merged = (await ctx.http().post(api(`/orders/${b.id}/merge`)).set(auth(marko)).send({ fromOrderIds: [a.id] }).expect(200)).body;
    expect(Number(merged.total)).toBeCloseTo(before);
    expect((await get(a.id)).status).toBe('MERGED');
    expect((await tableOrders(tables[tables.length - 1].id)).some((x) => x.id === a.id)).toBe(false);
  });
});

describe('Naplata - svi načini', () => {
  it('gotovina sa kusurom, kartica, miks, virman, reprezentacija, popust i kupac', async () => {
    // gotovina, dato više - kusur
    const c = await open(cashier, null); await add(cashier, c.id, espresso, 2);
    const total = Number((await get(c.id)).total);
    const r1 = (await settle(cashier, c.id, [{ method: 'CASH', tendered: (total + 100).toFixed(2) }]).expect(201)).body;
    expect(r1.order.status).toBe('PAID');
    expect(Number(r1.payments[0].change)).toBeCloseTo(100);
    // kartica
    const k = await open(cashier, null); await add(cashier, k.id, cola, 1);
    expect((await settle(cashier, k.id, [{ method: 'CARD' }]).expect(201)).body.order.status).toBe('PAID');
    // miks: deo kartica, ostatak gotovina
    const m = await open(cashier, null); await add(cashier, m.id, pljeskavica, 1);
    const mt = Number((await get(m.id)).total);
    const r3 = (await settle(cashier, m.id, [{ method: 'CARD', amount: '500.00' }, { method: 'CASH' }]).expect(201)).body;
    expect(r3.order.status).toBe('PAID');
    expect(r3.payments.reduce((a: number, p: any) => a + Number(p.amount), 0)).toBeCloseTo(mt);
    // virman sa kupcem (PIB)
    const v = await open(cashier, null); await add(cashier, v.id, cola, 1);
    await ctx.http().put(api(`/orders/${v.id}/buyer`)).set(auth(cashier)).send({ idType: '10', idValue: '101134702' }).expect(200);
    expect((await settle(cashier, v.id, [{ method: 'TRANSFER' }]).expect(201)).body.order.buyerId).toBe('101134702');
    // kupac se posle nalazi u pretrazi (stari kupac)
    const hits = (await ctx.http().get(api('/buyers/search?q=10113')).set(auth(cashier)).expect(200)).body as any[];
    expect(hits.some((h) => h.idValue === '101134702')).toBe(true);
    // popust 10%
    const d = await open(cashier, null); await add(cashier, d.id, pljeskavica, 1);
    const disc = (await ctx.http().get(api('/discounts')).set(auth(cashier)).expect(200)).body.find((x: any) => Number(x.percent) === 10);
    const dd = (await ctx.http().put(api(`/orders/${d.id}/discount`)).set(auth(cashier)).send({ discountId: disc.id }).expect(200)).body;
    expect(Number(dd.total)).toBeCloseTo(Number(dd.subtotal) * 0.9);
    expect((await settle(cashier, d.id, [{ method: 'CASH' }]).expect(201)).body.order.status).toBe('PAID');
    // reprezentacija
    const rp = await open(cashier, null); await add(cashier, rp.id, espresso, 1);
    expect((await settle(cashier, rp.id, [{ method: 'REPRESENTATION', note: 'Čast kuće' }]).expect(201)).body.order.status).toBe('PAID');
    // povraćaj gotovinskog računa i F2 pregled (isečak)
    await ctx.http().post(api(`/orders/${c.id}/refunds`)).set(auth(manager)).send({ reason: 'Reklamacija', idempotencyKey: idem('rf') }).expect(201);
    const prev = (await ctx.http().get(api(`/orders/${k.id}/receipt-preview`)).set(auth(cashier)).expect(200)).body.payload;
    expect(prev.payments[0].method).toBe('CARD');
    // dupli klik na naplatu (isti ključ) ne naplaćuje dvaput
    const z = await open(cashier, null); await add(cashier, z.id, cola, 1);
    const key = idem('dbl');
    await ctx.http().post(api(`/orders/${z.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CASH' }], idempotencyKey: key }).expect(201);
    await ctx.http().post(api(`/orders/${z.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CASH' }], idempotencyKey: key });
    expect((await get(z.id)).payments).toHaveLength(1);
  });
});
