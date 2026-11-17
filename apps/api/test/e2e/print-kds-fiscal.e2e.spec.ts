/**
 * Faza 3: rutiranje po pripremnim pozicijama, red štampe (print_jobs) i Print Bridge API,
 * KDS (statusi kartica i stavki), WebSocket događaji, fiskalni red sa TEST adapterom.
 */
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown } from './setup';
import { FiscalService, FiscalizationProvider, TestFiscalProvider } from '../../src/modules/fiscal/fiscal';

let ctx: Ctx;
let waiter: string, cashier: string, manager: string, kitchen: string, admin: string;
const api = (p: string) => `/api/v1${p}`;
let espresso: string, pljeskavica: string, salata: string, unrouted: string;
const B = (key = ctx.ids.bridgeKey) => ({ 'X-Bridge-Key': key });

beforeAll(async () => {
  ctx = await setupApp();
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  manager = await pinLogin(ctx, '9999');
  kitchen = await pinLogin(ctx, '3333', ctx.ids.kdsDevice);
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!');
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
  await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
  espresso = await productId(ctx, waiter, 'K001');
  pljeskavica = await productId(ctx, waiter, 'H002');
  salata = await productId(ctx, waiter, 'H003');
  // artikal u kategoriji bez pripremne pozicije
  const taxes = (await ctx.http().get(api('/tax-rates')).set(auth(admin)).expect(200)).body;
  const cat = (await ctx.http().post(api('/categories')).set(auth(admin)).send({ name: 'Ostalo (bez pozicije)' }).expect(201)).body;
  unrouted = (await ctx.http().post(api('/products')).set(auth(admin)).send({
    categoryId: cat.id, taxRateId: taxes[0].id, code: 'X001', name: 'Cigarete', price: '450.00',
  }).expect(201)).body.id;
}, 120_000);
afterAll(() => teardown(ctx));

async function order(token: string, products: string[], body: any = {}) {
  const o = await ctx.http().post(api('/orders')).set(auth(token)).send(body).expect(201);
  for (const p of products) await ctx.http().post(api(`/orders/${o.body.id}/items`)).set(auth(token)).send({ productId: p }).expect(201);
  return o.body.id as string;
}
const get = async (id: string, token = manager) => (await ctx.http().get(api(`/orders/${id}`)).set(auth(token)).expect(200)).body;
const jobsOf = async (orderId: string) =>
  (await ctx.pool.query('SELECT * FROM print_jobs WHERE order_id = $1 ORDER BY created_at', [orderId])).rows;
const ticketsOf = async (orderId: string) =>
  (await ctx.pool.query('SELECT * FROM kds_tickets WHERE order_id = $1 ORDER BY batch, station_id', [orderId])).rows;
/** Bridge preuzima sve što čeka i javlja SIMULATED - da ne bi ostalo u redu za sledeće testove. */
async function drainQueue() {
  for (;;) {
    const r = await ctx.http().post(api('/bridge/jobs/claim')).set(B()).send({ limit: 20 }).expect(200);
    if (!r.body.jobs.length) return;
    for (const j of r.body.jobs) await ctx.http().post(api(`/bridge/jobs/${j.id}/result`)).set(B()).send({ status: 'SIMULATED' }).expect(200);
  }
}

describe('Rutiranje i red štampe', () => {
  it('tura se deli po pozicijama: kartica + zadatak štampe po poziciji; artikal bez pozicije ostaje nerutiran', async () => {
    const id = await order(waiter, [espresso, pljeskavica, salata, unrouted]);
    const r = await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    expect(r.body.batch).toBe(1);
    const tickets = await ticketsOf(id);
    expect(tickets.map((t) => t.station_id).sort()).toEqual([ctx.ids.stations.bar, ctx.ids.stations.kitchen].sort());
    const jobs = await jobsOf(id);
    expect(jobs).toHaveLength(2);
    const kitchenJob = jobs.find((j) => j.station_id === ctx.ids.stations.kitchen);
    expect(kitchenJob.kind).toBe('ORDER_TICKET');
    expect(kitchenJob.status).toBe('PENDING');
    expect(kitchenJob.dedupe_key).toBe(`ticket:${id}:1:${ctx.ids.stations.kitchen}`);
    expect(kitchenJob.payload.lines.map((l: any) => l.name).sort()).toEqual(['Pljeskavica', 'Šopska salata']);
    expect(kitchenJob.payload).toMatchObject({ title: 'NARUDŽBINA', station: 'Kuhinja', batch: 1, waiter: 'Marko Konobar' });

    const o = await get(id);
    const byName = Object.fromEntries(o.items.map((i: any) => [i.name, i]));
    expect(byName['Espresso']).toMatchObject({ prepStationName: 'Šank', prepStatus: 'NEW' });
    expect(byName['Pljeskavica']).toMatchObject({ prepStationName: 'Kuhinja', prepStatus: 'NEW' });
    expect(byName['Cigarete']).toMatchObject({ prepStationId: null, kdsTicketId: null, prepStatus: null });
    expect(o.kdsTickets).toHaveLength(2);
  });

  it('nova tura pravi samo novu karticu/štampu; ponovljeno slanje bez novih stavki ne pravi ništa', async () => {
    const id = await order(waiter, [espresso]);
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    await ctx.http().post(api(`/orders/${id}/items`)).set(auth(waiter)).send({ productId: pljeskavica }).expect(201);
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    const again = await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    expect(again.body.batch).toBeNull();
    const jobs = await jobsOf(id);
    expect(jobs.map((j) => j.dedupe_key)).toEqual([
      `ticket:${id}:1:${ctx.ids.stations.bar}`, `ticket:${id}:2:${ctx.ids.stations.kitchen}`,
    ]);
    expect(jobs[1].payload.lines).toEqual([{ qty: '1.000', name: 'Pljeskavica', note: null }]);
  });

  it('5 paralelnih slanja iste porudžbine → jedna tura, jedna kartica i jedan zadatak po poziciji', async () => {
    const id = await order(waiter, [espresso, pljeskavica]);
    const rs = await Promise.all(Array.from({ length: 5 }, () => ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({})));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.batch === 1)).toHaveLength(1);
    expect(await ticketsOf(id)).toHaveLength(2);
    expect(await jobsOf(id)).toHaveLength(2);
  });

  it('baza sama odbija dupli zadatak štampe i duplu karticu (jedinstveni ključevi)', async () => {
    const id = await order(waiter, [pljeskavica]);
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    const [j] = await jobsOf(id);
    await expect(ctx.pool.query(
      `INSERT INTO print_jobs (location_id, printer_id, kind, dedupe_key, payload) VALUES ($1, $2, 'ORDER_TICKET', $3, '{}')`,
      [j.location_id, j.printer_id, j.dedupe_key])).rejects.toThrow(/print_jobs_dedupe_uq/);
    const [t] = await ticketsOf(id);
    await expect(ctx.pool.query(
      'INSERT INTO kds_tickets (location_id, order_id, station_id, batch) VALUES ($1, $2, $3, $4)',
      [t.location_id, t.order_id, t.station_id, t.batch])).rejects.toThrow(/kds_ticket_order_batch_station_uq/);
  });

  it('storno poslate stavke pravi STORNO tiket za njenu poziciju (jednom)', async () => {
    const id = await order(waiter, [pljeskavica, espresso]);
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    const o = await get(id);
    const item = o.items.find((i: any) => i.name === 'Pljeskavica');
    await ctx.http().post(api(`/orders/${id}/items/${item.id}/void`)).set(auth(manager)).send({ reason: 'Gost odustao' }).expect(200);
    await ctx.http().post(api(`/orders/${id}/items/${item.id}/void`)).set(auth(manager)).send({ reason: 'opet' }).expect(409);
    const voids = (await jobsOf(id)).filter((j) => j.kind === 'VOID_TICKET');
    expect(voids).toHaveLength(1);
    expect(voids[0]).toMatchObject({ station_id: ctx.ids.stations.kitchen, dedupe_key: `void:${item.id}` });
    expect(voids[0].payload).toMatchObject({ title: 'STORNO', reason: 'Gost odustao' });
  });

  it('pozicija bez štampača: kartica na KDS-u postoji, štampe nema', async () => {
    await ctx.http().patch(api(`/prep-stations/${ctx.ids.stations.kitchen}`)).set(auth(manager)).send({ printerId: null }).expect(200);
    try {
      const id = await order(waiter, [salata]);
      await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
      expect(await ticketsOf(id)).toHaveLength(1);
      expect(await jobsOf(id)).toHaveLength(0);
    } finally {
      const printers = (await ctx.http().get(api('/printers')).set(auth(manager)).expect(200)).body;
      const pk = printers.find((p: any) => p.name === 'Kuhinja - simulacija');
      await ctx.http().patch(api(`/prep-stations/${ctx.ids.stations.kitchen}`)).set(auth(manager)).send({ printerId: pk.id }).expect(200);
    }
  });
});

describe('Print Bridge API', () => {
  beforeAll(drainQueue);

  it('bez ključa ili sa pogrešnim ključem → 401; bridge ne može da se prijavi PIN-om', async () => {
    await ctx.http().post(api('/bridge/jobs/claim')).send({}).expect(401);
    await ctx.http().post(api('/bridge/jobs/claim')).set(B('pb_pogresan')).send({}).expect(401);
    const hello = await ctx.http().post(api('/bridge/hello')).set(B()).send({}).expect(200);
    expect(hello.body.printers.length).toBeGreaterThanOrEqual(3);
    await ctx.http().post(api('/auth/pin')).send({ deviceId: hello.body.bridge.id, pin: '2222' }).expect(401);
  });

  it('preuzimanje je atomsko: dva paralelna preuzimanja nikad ne dobiju isti zadatak', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await order(waiter, [espresso, pljeskavica]);
      await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    }
    const [a, b] = await Promise.all([
      ctx.http().post(api('/bridge/jobs/claim')).set(B()).send({ limit: 4 }),
      ctx.http().post(api('/bridge/jobs/claim')).set(B()).send({ limit: 4 }),
    ]);
    const ids = [...a.body.jobs, ...b.body.jobs].map((j: any) => j.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    const j = a.body.jobs[0] ?? b.body.jobs[0];
    expect(j.printer).toMatchObject({ connection: 'SIMULATED' });
    for (const id of ids) {
      const r = await ctx.http().post(api(`/bridge/jobs/${id}/result`)).set(B()).send({ status: 'SIMULATED' }).expect(200);
      expect(r.body.status).toBe('SIMULATED');
    }
    // ponovljen isti rezultat je idempotentan
    await ctx.http().post(api(`/bridge/jobs/${ids[0]}/result`)).set(B()).send({ status: 'SIMULATED' }).expect(200);
  });

  it('greška: ponovni pokušaj sa odlaganjem; trajna greška → FAILED; ručno ponavljanje iz ADMIN-a', async () => {
    const id = await order(waiter, [pljeskavica]);
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    let c = await ctx.http().post(api('/bridge/jobs/claim')).set(B()).send({}).expect(200);
    const jobId = c.body.jobs[0].id;
    const r1 = await ctx.http().post(api(`/bridge/jobs/${jobId}/result`)).set(B()).send({ status: 'FAILED', error: 'ECONNREFUSED 192.168.1.50:9100' }).expect(200);
    expect(r1.body).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'ECONNREFUSED 192.168.1.50:9100' });
    expect(new Date(r1.body.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    // pre isteka odlaganja se ne preuzima ponovo
    c = await ctx.http().post(api('/bridge/jobs/claim')).set(B()).send({}).expect(200);
    expect(c.body.jobs.map((j: any) => j.id)).not.toContain(jobId);
    await ctx.pool.query('UPDATE print_jobs SET next_attempt_at = now() WHERE id = $1', [jobId]);
    c = await ctx.http().post(api('/bridge/jobs/claim')).set(B()).send({}).expect(200);
    expect(c.body.jobs[0]).toMatchObject({ id: jobId, attempts: 2 });
    const r2 = await ctx.http().post(api(`/bridge/jobs/${jobId}/result`)).set(B()).send({ status: 'FAILED', error: 'Štampač ne postoji', retryable: false }).expect(200);
    expect(r2.body.status).toBe('FAILED');

    await ctx.http().post(api(`/print-jobs/${jobId}/retry`)).set(auth(waiter)).send({}).expect(403);
    const rr = await ctx.http().post(api(`/print-jobs/${jobId}/retry`)).set(auth(manager)).send({}).expect(200);
    expect(rr.body.status).toBe('PENDING');
    await ctx.http().post(api(`/print-jobs/${jobId}/retry`)).set(auth(manager)).send({}).expect(409);
    await drainQueue();
  });

  it('zadatak "zaglavljen" kod bridge-a koji je pao vraća se u red posle isteka zakupa; drugi bridge ne može da javi rezultat tuđeg zadatka', async () => {
    const second = (await ctx.http().post(api('/print-bridges')).set(auth(manager)).send({ name: 'Bridge 2' }).expect(201)).body;
    expect(second.apiKey).toMatch(/^pb_/);
    const id = await order(waiter, [espresso]);
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    const c = await ctx.http().post(api('/bridge/jobs/claim')).set(B()).send({}).expect(200);
    const jobId = c.body.jobs[0].id;
    const foreign = await ctx.http().post(api(`/bridge/jobs/${jobId}/result`)).set(B(second.apiKey)).send({ status: 'PRINTED' }).expect(409);
    expect(foreign.body.error.code).toBe('JOB_NOT_CLAIMED');
    // drugi bridge ga ne dobija dok zakup traje
    expect((await ctx.http().post(api('/bridge/jobs/claim')).set(B(second.apiKey)).send({}).expect(200)).body.jobs).toHaveLength(0);
    await ctx.pool.query(`UPDATE print_jobs SET claimed_at = now() - interval '2 minutes' WHERE id = $1`, [jobId]);
    const c2 = await ctx.http().post(api('/bridge/jobs/claim')).set(B(second.apiKey)).send({}).expect(200);
    expect(c2.body.jobs[0].id).toBe(jobId);
    await ctx.http().post(api(`/bridge/jobs/${jobId}/result`)).set(B()).send({ status: 'PRINTED' }).expect(409); // prvi je izgubio zakup
    await ctx.http().post(api(`/bridge/jobs/${jobId}/result`)).set(B(second.apiKey)).send({ status: 'PRINTED' }).expect(200);
    // novi ključ poništava stari
    const rot = (await ctx.http().post(api(`/print-bridges/${second.id}/rotate-key`)).set(auth(manager)).send({}).expect(200)).body;
    await ctx.http().post(api('/bridge/hello')).set(B(second.apiKey)).send({}).expect(401);
    await ctx.http().post(api('/bridge/hello')).set(B(rot.apiKey)).send({}).expect(200);
    const devs = (await ctx.http().get(api('/devices')).set(auth(manager)).expect(200)).body;
    expect(JSON.stringify(devs)).not.toContain('api_key_hash');
    expect(devs.find((d: any) => d.id === second.id)).not.toHaveProperty('apiKeyHash');
  });
});

describe('Podešavanje štampe (ADMIN)', () => {
  it('validacija štampača i prava', async () => {
    await ctx.http().post(api('/printers')).set(auth(waiter)).send({ name: 'X', connection: 'SIMULATED' }).expect(403);
    const bad = await ctx.http().post(api('/printers')).set(auth(manager)).send({ name: 'Mrežni', connection: 'NETWORK_ESCPOS' }).expect(422);
    expect(bad.body.error.code).toBe('PRINTER_CONFIG');
    const p = (await ctx.http().post(api('/printers')).set(auth(manager)).send({ name: 'Mrežni', connection: 'NETWORK_ESCPOS', host: '192.168.1.50', port: 9100, paperWidth: 58 }).expect(201)).body;
    expect(p).toMatchObject({ host: '192.168.1.50', port: 9100, paperWidth: 58 });
    const nh = await ctx.http().patch(api(`/printers/${p.id}`)).set(auth(manager)).send({ host: null }).expect(422);
    expect(nh.body.error.code).toBe('PRINTER_CONFIG');
    const t = (await ctx.http().post(api(`/printers/${p.id}/test`)).set(auth(manager)).send({}).expect(201)).body;
    expect(t).toMatchObject({ kind: 'TEST_PAGE', status: 'PENDING' });
    await drainQueue();
  });

  it('artikal može da ima svoju poziciju (ima prednost nad kategorijom)', async () => {
    await ctx.http().patch(api(`/products/${salata}`)).set(auth(manager)).send({ prepStationId: ctx.ids.stations.bar }).expect(200);
    const id = await order(waiter, [salata]);
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    expect((await ticketsOf(id))[0].station_id).toBe(ctx.ids.stations.bar);
    await ctx.http().patch(api(`/products/${salata}`)).set(auth(manager)).send({ prepStationId: null }).expect(200);
    await ctx.http().patch(api(`/products/${salata}`)).set(auth(manager)).send({ prepStationId: '00000000-0000-4000-8000-000000000000' }).expect(422);
    await drainQueue();
  });
});

describe('KDS', () => {
  it('konobar nema pristup KDS-u; kuhinja vidi samo kartice svoje pozicije', async () => {
    await ctx.http().get(api('/kds/tickets')).set(auth(waiter)).expect(403);
    const st = (await ctx.http().get(api('/kds/stations')).set(auth(kitchen)).expect(200)).body;
    expect(st.map((s: any) => s.name)).toEqual(['Kuhinja', 'Šank']);
    const list = (await ctx.http().get(api(`/kds/tickets?stationId=${ctx.ids.stations.kitchen}`)).set(auth(kitchen)).expect(200)).body;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((t: any) => t.station === 'Kuhinja')).toBe(true);
    // za podešavanje grupa na KDS ekranu: pozicija zna svoje grupe, stavka svoju grupu
    const kitchenGroups = st.find((s: any) => s.name === 'Kuhinja').groups.map((g: any) => g.id);
    expect(kitchenGroups.length).toBeGreaterThan(0);
    expect(list.flatMap((t: any) => t.items).every((i: any) => kitchenGroups.includes(i.categoryId))).toBe(true);
  });

  it('statusi kartice, stavka spremna, nedozvoljen prelaz; konobar vidi status pripreme', async () => {
    const id = await order(waiter, [pljeskavica, salata], { tabName: 'Pera' });
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    const [t] = await ticketsOf(id);
    const list = (await ctx.http().get(api(`/kds/tickets?stationId=${ctx.ids.stations.kitchen}`)).set(auth(kitchen)).expect(200)).body;
    const card = list.find((x: any) => x.id === t.id);
    expect(card).toMatchObject({ status: 'NEW', tabName: 'Pera', waiter: 'Marko Konobar', batch: 1 });
    expect(card.items).toHaveLength(2);

    let r = await ctx.http().post(api(`/kds/tickets/${t.id}/status`)).set(auth(kitchen)).send({ status: 'IN_PROGRESS' }).expect(200);
    expect(r.body.startedAt).toBeTruthy();
    r = await ctx.http().post(api(`/kds/items/${card.items[0].id}/ready`)).set(auth(kitchen)).send({ ready: true }).expect(200);
    expect(r.body.status).toBe('IN_PROGRESS');
    let o = await get(id, waiter);
    expect(o.items.map((i: any) => i.prepStatus).sort()).toEqual(['IN_PROGRESS', 'READY']);
    r = await ctx.http().post(api(`/kds/items/${card.items[1].id}/ready`)).set(auth(kitchen)).send({ ready: true }).expect(200);
    expect(r.body.status).toBe('READY'); // sve stavke spremne → kartica spremna
    r = await ctx.http().post(api(`/kds/items/${card.items[1].id}/ready`)).set(auth(kitchen)).send({ ready: false }).expect(200);
    expect(r.body.status).toBe('IN_PROGRESS');
    await ctx.http().post(api(`/kds/tickets/${t.id}/status`)).set(auth(kitchen)).send({ status: 'DONE' }).expect(200);
    const bad = await ctx.http().post(api(`/kds/tickets/${t.id}/status`)).set(auth(kitchen)).send({ status: 'NEW' }).expect(409);
    expect(bad.body.error.code).toBe('INVALID_TRANSITION');
    o = await get(id, waiter);
    expect(o.items.every((i: any) => i.prepStatus === 'READY')).toBe(true);
    const done = (await ctx.http().get(api(`/kds/tickets?view=done&stationId=${ctx.ids.stations.kitchen}`)).set(auth(kitchen)).expect(200)).body;
    expect(done[0].id).toBe(t.id);
    // vraćanje greškom zatvorene kartice
    await ctx.http().post(api(`/kds/tickets/${t.id}/status`)).set(auth(kitchen)).send({ status: 'READY' }).expect(200);
    await drainQueue();
  });

  it('stornirana stavka ostaje vidljiva na kartici kao stornirana', async () => {
    const id = await order(waiter, [pljeskavica, salata]);
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    const o = await get(id);
    const it = o.items.find((i: any) => i.name === 'Šopska salata');
    await ctx.http().post(api(`/orders/${id}/items/${it.id}/void`)).set(auth(manager)).send({ reason: 'Greška' }).expect(200);
    const list = (await ctx.http().get(api(`/kds/tickets?stationId=${ctx.ids.stations.kitchen}`)).set(auth(kitchen)).expect(200)).body;
    const card = list.find((x: any) => x.orderId === id);
    expect(card.items.find((i: any) => i.id === it.id)).toMatchObject({ status: 'VOIDED', voidReason: 'Greška' });
    await ctx.http().post(api(`/kds/items/${it.id}/ready`)).set(auth(kitchen)).send({ ready: true }).expect(409);
    await drainQueue();
  });
});

describe('WebSocket', () => {
  const url = (q: string) => `ws://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}/api/v1/ws?${q}`;

  function connect(q: string): Promise<{ ws: WebSocket; msgs: any[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url(q));
      const msgs: any[] = [];
      ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
      ws.on('open', () => resolve({ ws, msgs }));
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }
  const wait = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  };

  it('bez tokena ili sa neispravnim tokenom veza se odbija (401)', async () => {
    await expect(connect('')).rejects.toThrow(/401/);
    await expect(connect('token=nevazeci')).rejects.toThrow(/401/);
  });

  it('kuhinja dobija samo događaje svoje pozicije; kasa (bez filtera) dobija sve događaje lokala - tek posle commit-a', async () => {
    const k = await connect(`token=${kitchen}&stationId=${ctx.ids.stations.kitchen}`);
    const all = await connect(`token=${waiter}`);
    await wait(() => k.msgs.length > 0 && all.msgs.length > 0);
    expect(k.msgs[0].type).toBe('hello');

    const id = await order(waiter, [espresso, pljeskavica]);
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
    await wait(() => k.msgs.some((m) => m.type === 'kds.ticket.created') && all.msgs.filter((m) => m.type === 'kds.ticket.created').length >= 2);
    const kCreated = k.msgs.filter((m) => m.type === 'kds.ticket.created');
    expect(kCreated).toHaveLength(1);
    expect(kCreated[0]).toMatchObject({ stationId: ctx.ids.stations.kitchen, data: { orderId: id } });
    expect(all.msgs.filter((m) => m.type === 'kds.ticket.created')).toHaveLength(2);
    expect(all.msgs.some((m) => m.type === 'order.updated' && m.data.orderId === id)).toBe(true);
    // događaj nosi id kartice koja je zaista u bazi (objava posle commit-a)
    const t = (await ctx.pool.query('SELECT id FROM kds_tickets WHERE id = $1', [kCreated[0].data.ticketId])).rows;
    expect(t).toHaveLength(1);

    // neuspela izmena (zastarela verzija) ne šalje događaj
    const before = all.msgs.length;
    await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({ expectedVersion: 0 }).expect(409);
    await new Promise((r) => setTimeout(r, 150));
    expect(all.msgs.length).toBe(before);

    // promena statusa na KDS-u stiže i kasi
    await ctx.http().post(api(`/kds/tickets/${kCreated[0].data.ticketId}/status`)).set(auth(kitchen)).send({ status: 'READY' }).expect(200);
    await wait(() => all.msgs.some((m) => m.type === 'order.prep.updated' && m.data.orderId === id));
    expect(all.msgs.some((m) => m.type === 'order.prep.updated' && m.data.orderId === id)).toBe(true);
    k.ws.close(); all.ws.close();
    await drainQueue();
  });

  it('deaktiviran korisnik ne može da otvori vezu', async () => {
    const r = await ctx.pool.query(`SELECT id FROM users WHERE full_name = 'Kuhinja'`);
    await ctx.pool.query('UPDATE users SET active = false WHERE id = $1', [r.rows[0].id]);
    try {
      await expect(connect(`token=${kitchen}`)).rejects.toThrow(/401/);
    } finally {
      await ctx.pool.query('UPDATE users SET active = true WHERE id = $1', [r.rows[0].id]);
    }
  });
});

describe('Fiskalizacija (TEST adapter)', () => {
  const fiscal = () => ctx.app.get(FiscalService);
  afterEach(() => fiscal().setProviderForTests(new TestFiscalProvider()));

  it('status je javno vidljiv kao TEST', async () => {
    const h = await ctx.http().get(api('/health')).expect(200);
    expect(h.body.fiscalization).toEqual({ provider: 'TEST', isTest: true, mode: 'TEST' });
  });

  it('naplaćen račun dobija TEST broj; zahtev nosi stavke posle popusta i načine plaćanja; ponovljena naplata ne pravi drugi zahtev', async () => {
    const id = await order(waiter, [espresso, pljeskavica], { buyer: undefined });
    await ctx.http().put(api(`/orders/${id}/buyer`)).set(auth(waiter)).send({ idType: '10', idValue: '100000024' }).expect(200);
    const key = idem('fis');
    const r = await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(cashier))
      .send({ parts: [{ method: 'CARD', amount: '170.00' }, { method: 'CASH', tendered: '1000.00' }], idempotencyKey: key }).expect(201);
    expect(r.body.order.status).toBe('PAID');
    expect(r.body.order.fiscal).toMatchObject({ status: 'SIGNED', provider: 'TEST', isTest: true, invoiceType: 'TRAINING' });
    expect(r.body.order.fiscal.invoiceNumber).toMatch(/^TEST-\d{8}-[0-9A-F]{8}-\d+$/);
    expect(r.body.order.fiscal.verificationUrl).toBeNull();
    const row = (await ctx.pool.query('SELECT request FROM fiscal_receipts WHERE order_id = $1', [id])).rows[0];
    expect(row.request).toMatchObject({
      buyerId: '10:100000024', total: '1170.00', invoiceType: 'TRAINING',
      payments: [{ paymentType: 'Card', amount: '170.00' }, { paymentType: 'Cash', amount: '1000.00' }],
    });
    await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(cashier))
      .send({ parts: [{ method: 'CARD', amount: '170.00' }, { method: 'CASH', tendered: '1000.00' }], idempotencyKey: key }).expect(201);
    expect((await ctx.pool.query('SELECT count(*)::int c FROM fiscal_receipts WHERE order_id = $1', [id])).rows[0].c).toBe(1);
  });

  it('nedostupan fiskalni sistem: naplata uspeva, račun NIJE označen kao fiskalizovan, ponovni pokušaji, pa uspeh', async () => {
    let calls = 0;
    const flaky: FiscalizationProvider = {
      code: 'TEST', isTest: true,
      async sign(req) {
        calls++;
        if (calls < 3) return { ok: false, retryable: true, error: 'Timeout prema fiskalnom sistemu' };
        return new TestFiscalProvider().sign(req);
      },
    };
    fiscal().setProviderForTests(flaky);
    const id = await order(waiter, [espresso]);
    const r = await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(cashier))
      .send({ parts: [{ method: 'CASH' }], idempotencyKey: idem('fl') }).expect(201);
    expect(r.body.order.status).toBe('PAID');
    expect(r.body.order.fiscal).toMatchObject({ status: 'PENDING', invoiceNumber: null, attempts: 1, lastError: 'Timeout prema fiskalnom sistemu' });
    await fiscal().processDue(); // odlaganje još traje → ništa
    expect(calls).toBe(1);
    await ctx.pool.query('UPDATE fiscal_receipts SET next_attempt_at = now() WHERE order_id = $1', [id]);
    await fiscal().processDue();
    await ctx.pool.query('UPDATE fiscal_receipts SET next_attempt_at = now() WHERE order_id = $1', [id]);
    await fiscal().processDue();
    const o = await get(id);
    expect(o.fiscal).toMatchObject({ status: 'SIGNED', attempts: 3 });
  });

  it('trajna greška → FAILED; ručni ponovni pokušaj (pravo settings.manage) → SIGNED', async () => {
    fiscal().setProviderForTests({ code: 'TEST', isTest: true, sign: async () => ({ ok: false, retryable: false, error: 'Neispravan zahtev' }) });
    const id = await order(waiter, [espresso]);
    const r = await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(cashier))
      .send({ parts: [{ method: 'CARD' }], idempotencyKey: idem('ff') }).expect(201);
    expect(r.body.order.fiscal).toMatchObject({ status: 'FAILED', lastError: 'Neispravan zahtev', invoiceNumber: null });
    const failed = (await ctx.http().get(api('/fiscal/receipts?status=FAILED')).set(auth(manager)).expect(200)).body;
    expect(failed.data.map((x: any) => x.orderId)).toContain(id);
    await ctx.http().post(api(`/fiscal/receipts/${r.body.order.fiscal.id}/retry`)).set(auth(cashier)).send({}).expect(403);
    fiscal().setProviderForTests(new TestFiscalProvider());
    const ok = await ctx.http().post(api(`/fiscal/receipts/${r.body.order.fiscal.id}/retry`)).set(auth(manager)).send({}).expect(200);
    expect(ok.body.status).toBe('SIGNED');
    await ctx.http().post(api(`/fiscal/receipts/${r.body.order.fiscal.id}/retry`)).set(auth(manager)).send({}).expect(409);
  });

  it('baza ne dozvoljava SIGNED bez broja računa', async () => {
    const [{ id }] = (await ctx.pool.query(`SELECT id FROM fiscal_receipts LIMIT 1`)).rows;
    await expect(ctx.pool.query(`UPDATE fiscal_receipts SET invoice_number = NULL WHERE id = $1 AND status = 'SIGNED'`, [id]))
      .rejects.toThrow(/fiscal_signed_has_number/);
  });

  it('fiskalizacija isključena (NONE): nema zahteva, račun nema fiskalni status', async () => {
    fiscal().setProviderForTests(null);
    const id = await order(waiter, [espresso]);
    const r = await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(cashier))
      .send({ parts: [{ method: 'CASH' }], idempotencyKey: idem('nf') }).expect(201);
    expect(r.body.order.fiscal).toBeNull();
  });

  it('štampa računa: na papiru piše da TEST račun nije fiskalni; isti ključ ne štampa dvaput; druga štampa je kopija', async () => {
    const id = await order(waiter, [espresso]);
    await ctx.http().post(api(`/orders/${id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CASH' }], idempotencyKey: idem('pr') }).expect(201);
    const key = idem('print');
    const p1 = await ctx.http().post(api(`/orders/${id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: key }).expect(201);
    expect(p1.body.idempotentReplay).toBe(false);
    expect(p1.body.job.payload).toMatchObject({ title: 'RAČUN', notFiscalNotice: 'TEST - OVO NIJE FISKALNI RAČUN', copy: false });
    expect(p1.body.job.payload.fiscal.invoiceNumber).toMatch(/^TEST-/);
    // raspored Poreske uprave: TEST adapter = ОБУКА, nije fiskalni; porezi po oznakama; PFR broj i brojač
    const fl = p1.body.job.payload.fiscalLayout;
    expect(fl).toMatchObject({ isFiscal: false, transaction: 'ОБУКА ПРОДАЈА', pfrNumber: p1.body.job.payload.fiscal.invoiceNumber });
    expect(fl.counter).toMatch(/^\d+\/\d+ОП$/);
    expect(fl.taxes).toEqual([{ label: 'Ђ', name: 'О-ПДВ', rate: '20.00', tax: '30.00' }]); // 180 sa 20% → 30,00
    expect(fl.company).toBeTruthy();
    const p2 = await ctx.http().post(api(`/orders/${id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: key }).expect(201);
    expect(p2.body).toMatchObject({ idempotentReplay: true, job: { id: p1.body.job.id } });
    const p3 = await ctx.http().post(api(`/orders/${id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: idem('print') }).expect(201);
    expect(p3.body.job.payload.copy).toBe(true);
    expect(p3.body.job.payload.fiscalLayout.transaction).toBe('КОПИЈА ПРОДАЈА');
    // otvoren račun → predračun, bez fiskalnog broja
    const open = await order(waiter, [espresso]);
    const p4 = await ctx.http().post(api(`/orders/${open}/print-receipt`)).set(auth(waiter)).send({ idempotencyKey: idem('pre') });
    expect(p4.body.job.payload).toMatchObject({ title: 'PREDRAČUN', fiscal: null, notFiscalNotice: 'OVO NIJE FISKALNI RAČUN', fiscalLayout: { transaction: 'ПРЕДРАЧУН ПРОДАЈА', isFiscal: false } });
    await drainQueue();
  });
});

describe('Print Bridge ↔ API (stvarni bridge, lažni mrežni štampač)', () => {
  it('blok za kuhinju stiže na TCP štampač kao ESC/POS → PRINTED; šank (simulacija) → SIMULATED', async () => {
    const net = await import('net');
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const { PrintBridge } = await import('../../../print-bridge/src/bridge');
    await drainQueue();
    const received: Buffer[] = [];
    const srv = net.createServer((s) => { const c: Buffer[] = []; s.on('data', (d) => c.push(Buffer.from(d))); s.on('end', () => { received.push(Buffer.concat(c)); s.end(); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    const printer = (await ctx.http().post(api('/printers')).set(auth(manager)).send({ name: 'Kuhinja TCP (test)', connection: 'NETWORK_ESCPOS', host: '127.0.0.1', port }).expect(201)).body;
    const old = (await ctx.http().get(api('/prep-stations')).set(auth(manager)).expect(200)).body.find((s: any) => s.id === ctx.ids.stations.kitchen).printerId;
    await ctx.http().patch(api(`/prep-stations/${ctx.ids.stations.kitchen}`)).set(auth(manager)).send({ printerId: printer.id }).expect(200);
    try {
      const id = await order(waiter, [pljeskavica, espresso], { tabName: 'Žika' });
      await ctx.http().post(api(`/orders/${id}/send`)).set(auth(waiter)).send({}).expect(200);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-e2e-'));
      const apiUrl = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}/api/v1`;
      const bridge = new PrintBridge({ apiUrl, key: ctx.ids.bridgeKey, pollMs: 50, codepage: 'cp852', codepageNumber: null, simulatedDir: dir, log: () => undefined });
      await bridge.hello();
      expect(await bridge.tick()).toBe(2);
      const jobs = await jobsOf(id);
      expect(Object.fromEntries(jobs.map((j) => [j.station_id, j.status]))).toEqual({
        [ctx.ids.stations.kitchen]: 'PRINTED', [ctx.ids.stations.bar]: 'SIMULATED',
      });
      await new Promise((r) => setTimeout(r, 50));
      const bytes = received[0];
      expect([...bytes.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 18]);
      expect(bytes.toString('latin1')).toContain('Pljeskavica');
      expect(bytes.includes(Buffer.from([0xa6]))).toBe(true); // "Ž" iz naziva ture u CP852
      expect(fs.readdirSync(dir)).toHaveLength(1);
      // drugi krug nema šta da radi - nema duple štampe
      expect(await bridge.tick()).toBe(0);
      expect(received).toHaveLength(1);
    } finally {
      await ctx.http().patch(api(`/prep-stations/${ctx.ids.stations.kitchen}`)).set(auth(manager)).send({ printerId: old }).expect(200);
      srv.close();
    }
  });
});

// Poslednje u fajlu: smena se zatvara direktno u bazi.
describe('KDS posle zatvaranja smene', () => {
  it('kartice iz zatvorene smene nisu na aktivnom ekranu', async () => {
    const list = () => ctx.http().get(api(`/kds/tickets?stationId=${ctx.ids.stations.kitchen}`)).set(auth(kitchen)).expect(200);
    expect((await list()).body.length).toBeGreaterThan(0);
    await ctx.pool.query(`UPDATE business_days SET status = 'CLOSED', closed_at = now(), closed_by_id = opened_by_id WHERE status = 'OPEN'`);
    expect((await list()).body).toEqual([]);
  });
});
