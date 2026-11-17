/**
 * Mapa stolova (ADMIN editor): izmena, raspored, brisanje stola; slike artikala za pločice na kasi.
 */
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown } from './setup';

let ctx: Ctx;
let waiter: string, cashier: string, admin: string;
const api = (p: string) => `/api/v1${p}`;
// 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeAll(async () => {
  ctx = await setupApp();
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!');
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
});
afterAll(() => teardown(ctx));

const tables = async (token = admin) => (await ctx.http().get(api('/tables')).set(auth(token)).expect(200)).body as any[];

describe('Mapa stolova', () => {
  it('stolovi imaju veličinu i oblik', async () => {
    const t = (await tables()).find((x) => x.name === 'Sto 5');
    expect(t).toMatchObject({ shape: 'ROUND', width: 110, height: 110 });
  });

  it('novi sto, izmena i raspored', async () => {
    const t = (await ctx.http().post(api('/tables')).set(auth(admin)).send({ name: 'Šank 1', area: 'Galerija', shape: 'ROUND', width: 80, height: 80 }).expect(201)).body;
    expect(t).toMatchObject({ area: 'Galerija', shape: 'ROUND' });
    await ctx.http().patch(api(`/tables/${t.id}`)).set(auth(admin)).send({ name: 'Šank 2', seats: 2 }).expect(200);
    await ctx.http().put(api('/tables/layout')).set(auth(admin)).send({ tables: [{ id: t.id, posX: 300, posY: 40, width: 90, height: 70 }] }).expect(200);
    expect((await tables()).find((x) => x.id === t.id)).toMatchObject({ name: 'Šank 2', seats: 2, posX: 300, posY: 40, width: 90, height: 70 });
  });

  it('naziv je jedinstven, veličina u granicama', async () => {
    const t = (await tables()).find((x) => x.name === 'Sto 1');
    const r = await ctx.http().patch(api(`/tables/${t.id}`)).set(auth(admin)).send({ name: 'Sto 2' }).expect(409);
    expect(r.body.error.code).toBe('TABLE_NAME_TAKEN');
    await ctx.http().put(api('/tables/layout')).set(auth(admin)).send({ tables: [{ id: t.id, posX: 0, posY: 0, width: 10, height: 70 }] }).expect(400);
  });

  it('konobar ne menja mapu', async () => {
    const t = (await tables(waiter))[0];
    await ctx.http().patch(api(`/tables/${t.id}`)).set(auth(waiter)).send({ seats: 3 }).expect(403);
    await ctx.http().put(api('/tables/layout')).set(auth(waiter)).send({ tables: [] }).expect(403);
  });

  it('sto sa otvorenim računom se ne briše; prazan se briše i vraća pod istim imenom', async () => {
    const t3 = (await tables()).find((x) => x.name === 'Sto 3');
    await ctx.http().post(api('/orders')).set(auth(waiter)).send({ tableId: t3.id, idempotencyKey: idem('open') }).expect(201);
    expect((await ctx.http().delete(api(`/tables/${t3.id}`)).set(auth(admin)).expect(409)).body.error.code).toBe('TABLE_HAS_OPEN_ORDERS');

    const t4 = (await tables()).find((x) => x.name === 'Sto 4');
    await ctx.http().delete(api(`/tables/${t4.id}`)).set(auth(admin)).expect(200);
    expect((await tables()).some((x) => x.id === t4.id)).toBe(false);
    const back = (await ctx.http().post(api('/tables')).set(auth(admin)).send({ name: 'Sto 4', area: 'Sala' }).expect(201)).body;
    expect(back.id).toBe(t4.id);
  });
});

describe('Kasa jednog lokala', () => {
  it('bez prijave vraća kasu lokala; PIN prijava na nju radi', async () => {
    const r = (await ctx.http().get(api('/auth/kasa')).expect(200)).body;
    expect(r.device).toMatchObject({ id: ctx.ids.posDevice });
    await ctx.http().post(api('/auth/pin')).send({ deviceId: r.device.id, pin: '1111' }).expect(200);
  });
});

describe('Opcije izmene artikla i štampa pazara', () => {
  it('opcije se čuvaju očišćene i vide se na kasi', async () => {
    const id = await productId(ctx, admin, 'S001');
    await ctx.http().patch(api(`/products/${id}`)).set(auth(admin)).send({ noteOptions: [' Bez leda', 'bez leda', 'Bez limuna', ''] }).expect(400);
    await ctx.http().patch(api(`/products/${id}`)).set(auth(admin)).send({ noteOptions: [' Bez leda', 'bez leda', 'Bez limuna'] }).expect(200);
    const p = (await ctx.http().get(api('/products?pageSize=500')).set(auth(waiter)).expect(200)).body.data.find((x: any) => x.id === id);
    expect(p.noteOptions).toEqual(['Bez leda', 'Bez limuna']);
  });

  it('štampa pazara pravi zadatak za štampač računa (idempotentno)', async () => {
    const t = (await tables(waiter)).find((x) => x.name === 'Sto 2');
    await ctx.http().post(api('/orders')).set(auth(waiter)).send({ tableId: t.id, idempotencyKey: idem('open') }).expect(201);
    const key = idem('shift');
    const a = (await ctx.http().post(api('/staff-shifts/current/print')).set(auth(waiter)).send({ idempotencyKey: key }).expect(201)).body;
    expect(a.job).toMatchObject({ kind: 'SHIFT_REPORT' });
    expect(a.job.payload.openOrders).toBeGreaterThan(0);
    const b = (await ctx.http().post(api('/staff-shifts/current/print')).set(auth(waiter)).send({ idempotencyKey: key }).expect(201)).body;
    expect(b.job.id).toBe(a.job.id);
  });
});

describe('Prebacivanje i prazni računi', () => {
  const open = async (tableName: string) => {
    const t = (await tables(waiter)).find((x) => x.name === tableName);
    return (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ tableId: t.id, idempotencyKey: idem('open') }).expect(201)).body;
  };
  const addItem = async (o: any, code: string) =>
    (await ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(waiter)).send({ productId: await productId(ctx, waiter, code), expectedVersion: o.version }).expect(201)).body;

  it('ceo račun prelazi na drugi sto', async () => {
    let o = await open('Sto 6');
    o = await addItem(o, 'K001');
    const t8 = (await tables(waiter)).find((x) => x.name === 'Sto 8');
    const moved = (await ctx.http().post(api(`/orders/${o.id}/move-table`)).set(auth(waiter)).send({ toTableId: t8.id, expectedVersion: o.version }).expect(200)).body;
    expect(moved).toMatchObject({ id: o.id, tableName: 'Sto 8' });
    const after = await tables(waiter);
    expect(after.find((x) => x.name === 'Sto 8').openOrders.map((x: any) => x.id)).toContain(o.id);
    expect(after.find((x) => x.name === 'Sto 6').openOrders).toHaveLength(0);
  });

  it('prebacivanje svih stavki zatvara izvorni račun; prazni računi se ne prikazuju u listi', async () => {
    let o = await open('Sto 7');
    o = await addItem(o, 'K001');
    const t5 = (await tables(waiter)).find((x) => x.name === 'Sto 5');
    const r = (await ctx.http().post(api(`/orders/${o.id}/move-items`)).set(auth(waiter)).send({ itemIds: o.items.map((i: any) => i.id), toTableId: t5.id }).expect(200)).body;
    expect(r.from.status).toBe('MERGED');
    const empty = await open('Sto 7');
    const list = (await ctx.http().get(api('/orders?nonEmpty=true&pageSize=200')).set(auth(waiter)).expect(200)).body;
    expect(list.some((x: any) => x.id === empty.id)).toBe(false);
    expect(list.some((x: any) => x.id === r.to.id)).toBe(true);
  });

  it('smena se ne zatvara dok postoji nenaplaćen sto; prazne zatvara sama', async () => {
    await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
    const res = await ctx.http().post(api('/shifts/close')).set(auth(cashier)).send({}).expect(409);
    expect(res.body.error.code).toBe('SHIFT_HAS_OPEN_ORDERS');
  });
});

describe('Delimično prebacivanje i storno, smena sa nazivom, podešavanja, kraj dana', () => {
  it('prebacuje se deo količine (2 od 5), storno dela količine (1 od 3)', async () => {
    const t1 = (await tables(waiter)).find((x) => x.name === 'Sto 1');
    let o = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ tableId: t1.id, idempotencyKey: idem('open') }).expect(201)).body;
    o = (await ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(waiter)).send({ productId: await productId(ctx, waiter, 'S003'), quantity: '5', expectedVersion: o.version }).expect(201)).body;
    await ctx.http().post(api(`/orders/${o.id}/send`)).set(auth(waiter)).send({}).expect(200);
    const t2 = (await tables(waiter)).find((x) => x.name === 'Sto 2');
    const r = (await ctx.http().post(api(`/orders/${o.id}/move-items`)).set(auth(waiter))
      .send({ itemIds: [o.items[0].id], quantities: ['2'], toTableId: t2.id }).expect(200)).body;
    expect(r.from.items.find((i: any) => i.status === 'SENT').quantity).toBe('3.000');
    expect(r.to.items[0]).toMatchObject({ quantity: '2.000', status: 'SENT' });
    await ctx.http().post(api(`/orders/${o.id}/move-items`)).set(auth(waiter)).send({ itemIds: [o.items[0].id], quantities: ['9'], toTableId: t2.id }).expect(422);

    const mgr = await pinLogin(ctx, '9999');
    const cur = (await ctx.http().get(api(`/orders/${o.id}`)).set(auth(mgr)).expect(200)).body;
    const v = (await ctx.http().post(api(`/orders/${o.id}/items/${cur.items[0].id}/void`)).set(auth(mgr))
      .send({ reason: 'Pogrešno uneto', quantity: '1', expectedVersion: cur.version }).expect(200)).body;
    expect(v.items.filter((i: any) => i.status === 'SENT')[0].quantity).toBe('2.000');
    expect(v.items.filter((i: any) => i.status === 'VOIDED')[0].quantity).toBe('1.000');
  });

  it('podešavanja kase: PIN za svaki sto je podrazumevano uključen; menja ga samo administrator', async () => {
    expect((await ctx.http().get(api('/settings/kasa')).set(auth(waiter)).expect(200)).body.pinPerTable).toBe(true);
    await ctx.http().put(api('/settings/kasa')).set(auth(waiter)).send({ pinPerTable: false }).expect(403);
    expect((await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ pinPerTable: false }).expect(200)).body.pinPerTable).toBe(false);
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ pinPerTable: true }).expect(200);
  });

  it('kraj dana: pazar svih zaposlenih i prodaja po pozicijama', async () => {
    const r = (await ctx.http().get(api('/business-days/current/end-of-day')).set(auth(cashier)).expect(200)).body;
    expect(Array.isArray(r.staff)).toBe(true);
    expect(Array.isArray(r.stations)).toBe(true);
    const p = (await ctx.http().post(api('/business-days/current/print-staff')).set(auth(cashier)).send({ idempotencyKey: idem('all') }).expect(201)).body;
    expect(p.jobs.length).toBe(r.staff.length);
  });

  it('naziv smene: predlog je dan u nedelji; isti naziv istog datuma nije dozvoljen', async () => {
    const next = (await ctx.http().get(api('/business-days/next')).set(auth(cashier)).expect(200)).body;
    expect(next.name).toMatch(/^(Ponedeljak|Utorak|Sreda|Četvrtak|Petak|Subota|Nedelja)\d*$/);
    const day = (await ctx.http().get(api('/business-days/current')).set(auth(cashier)).expect(200)).body.day;
    expect(day.name).toBeTruthy();
    expect(next.name).not.toBe(day.name);
  });
});

describe('Štampanje grupa, specifikacija pazara, pregled računa po datumu', () => {
  it('grupa sa svojim štampačem: porudžbina ide na štampač grupe', async () => {
    const pr = (await ctx.http().post(api('/printers')).set(auth(admin)).send({ name: 'GenericSank_40', connection: 'SIMULATED', paperWidth: 58 }).expect(201)).body;
    const cats = (await ctx.http().get(api('/categories')).set(auth(admin)).expect(200)).body;
    const kafa = cats.find((c: any) => c.name === 'Topli napici');
    await ctx.http().patch(api(`/categories/${kafa.id}`)).set(auth(admin)).send({ printerId: pr.id }).expect(200);
    const t = (await tables(waiter)).find((x) => x.name === 'Sto 3');
    let o = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ tableId: t.id, idempotencyKey: idem('open') }).expect(201)).body;
    o = (await ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(waiter)).send({ productId: await productId(ctx, waiter, 'K001'), expectedVersion: o.version }).expect(201)).body;
    await ctx.http().post(api(`/orders/${o.id}/send`)).set(auth(waiter)).send({}).expect(200);
    const jobs = await ctx.pool.query(`SELECT printer_id FROM print_jobs WHERE order_id = $1 AND kind = 'ORDER_TICKET'`, [o.id]);
    expect(jobs.rows.map((r: any) => r.printer_id)).toEqual([pr.id]);
    await ctx.http().patch(api(`/categories/${kafa.id}`)).set(auth(admin)).send({ printerId: null }).expect(200);
  });

  it('pregled računa po datumu sa načinom plaćanja; specifikacija pazara na štampač', async () => {
    const day = (await ctx.http().get(api('/business-days/current')).set(auth(admin)).expect(200)).body.day;
    const list = (await ctx.http().get(api(`/orders?date=${day.date}&nonEmpty=true&pageSize=200`)).set(auth(admin)).expect(200)).body;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty('methods');
    const pr = (await ctx.http().get(api('/printers')).set(auth(admin)).expect(200)).body[0];
    const r = (await ctx.http().post(api(`/business-days/${day.id}/print`)).set(auth(admin)).send({ printerId: pr.id, idempotencyKey: idem('spec') }).expect(201)).body;
    expect(r.job).toMatchObject({ kind: 'SHIFT_REPORT' });
    expect(r.job.payload.title).toBe('SPECIFIKACIJA PAZARA');
  });
});

describe('Slike artikala', () => {
  it('postavljanje, javno čitanje, uklanjanje', async () => {
    const id = await productId(ctx, admin, 'S001');
    await ctx.http().put(api(`/products/${id}/image`)).set(auth(admin)).send({ dataUrl: PNG }).expect(200);
    const list = (await ctx.http().get(api('/products?pageSize=500')).set(auth(waiter)).expect(200)).body.data;
    expect(list.find((p: any) => p.id === id).imageAt).toBeTruthy();
    const img = await ctx.http().get(api(`/products/${id}/image`)).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.body.length).toBeGreaterThan(10);

    await ctx.http().put(api(`/products/${id}/image`)).set(auth(waiter)).send({ dataUrl: PNG }).expect(403);
    expect((await ctx.http().put(api(`/products/${id}/image`)).set(auth(admin)).send({ dataUrl: 'data:image/gif;base64,AAAA' }).expect(422)).body.error.code).toBe('INVALID_IMAGE');

    await ctx.http().delete(api(`/products/${id}/image`)).set(auth(admin)).expect(200);
    await ctx.http().get(api(`/products/${id}/image`)).expect(404);
  });
});
