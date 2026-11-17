/**
 * Prava fiskalizacija preko LPFR-a (ESIR, API v3) - prema lažnom LPFR serveru u testu:
 * otključavanje PIN-om, telo računa (ćirilične oznake, kasir), broj/brojač iz odgovora PFR-a, odbijen račun, provera veze.
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Ctx, auth, idem, passwordLogin, pinLogin, productId, setupApp, teardown } from './setup';

let ctx: Ctx;
let admin: string, waiter: string, cashier: string;
const api = (p: string) => `/api/v1${p}`;

// lažni LPFR: traži PIN 4321, posle toga potpisuje; račun sa nazivom "ODBIJ" odbija sa 400
const lpfr = { unlocked: false, invoices: [] as any[], pins: [] as string[] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code: number, b: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'GET' && req.url === '/api/v3/status') return send(200, { uid: 'ABCD1234', sdcDateTime: new Date().toISOString(), gsc: lpfr.unlocked ? ['9999'] : ['1500'] });
    if (req.method === 'POST' && req.url === '/api/v3/pin') {
      lpfr.pins.push(JSON.parse(body));
      lpfr.unlocked = JSON.parse(body) === '4321';
      return send(200, lpfr.unlocked ? '0100' : '2100');
    }
    if (req.method === 'POST' && req.url === '/api/v3/invoices') {
      const inv = JSON.parse(body);
      lpfr.invoices.push(inv);
      if (!lpfr.unlocked) return send(400, { message: '1500' });
      if (inv.items.some((i: any) => i.name === 'ODBIJ')) return send(400, { message: 'Neispravan zahtev', modelState: [{ property: 'items', errors: ['2805'] }] });
      const n = lpfr.invoices.length;
      return send(200, {
        invoiceNumber: `ABCD1234-ABCD1234-${n}`, invoiceCounter: `${n}/${n}ПП`, sdcDateTime: '2026-11-01T12:00:00.000+01:00',
        verificationUrl: `https://suf.purs.gov.rs/v/?vl=TEST${n}`, verificationQRCode: 'R0lGOD...', journal: '====', totalAmount: inv.payment[0].amount,
      });
    }
    send(404, {});
  });
});

beforeAll(async () => {
  ctx = await setupApp();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!', ctx.ids.posDevice);
  waiter = await pinLogin(ctx, '1111');
  cashier = await pinLogin(ctx, '2222');
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
  await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
  const port = (server.address() as AddressInfo).port;
  await ctx.http().patch(api(`/computers/${ctx.ids.posDevice}`)).set(auth(admin))
    .send({ settings: { fiscal: { useVpfr: false, lpfrUrl: `127.0.0.1:${port}`, pin: '4321' } } }).expect(200);
  await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ fiscalMode: 'LPFR', esirNumber: '123/1.0' }).expect(200);
});
afterAll(async () => { server.close(); await teardown(ctx); });

const sell = async (name?: string) => {
  const o = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: idem('o') }).expect(201)).body;
  if (name) {
    const cats = (await ctx.http().get(api('/categories')).set(auth(admin)).expect(200)).body;
    const taxes = (await ctx.http().get(api('/tax-rates')).set(auth(admin)).expect(200)).body;
    const p = (await ctx.http().post(api('/products')).set(auth(admin)).send({ name, price: '100.00', categoryId: cats[0].id, taxRateId: taxes[0].id }).expect(201)).body;
    await ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(waiter)).send({ productId: p.id }).expect(201);
  }
  await ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(waiter)).send({ productId: await productId(ctx, admin, 'K001') }).expect(201);
  return (await ctx.http().post(api(`/orders/${o.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'CASH' }], idempotencyKey: idem('pay') }).expect(201)).body;
};

describe('LPFR', () => {
  it('provera veze otključava PIN-om', async () => {
    const r = (await ctx.http().post(api(`/fiscal/check/${ctx.ids.posDevice}`)).set(auth(admin)).expect(200)).body;
    expect(r).toMatchObject({ ok: true, kind: 'LPFR' });
    expect(r.message).toContain('ABCD1234');
    expect(lpfr.pins).toEqual(['4321']);
    expect((await ctx.http().get(api('/fiscal/status')).set(auth(cashier)).expect(200)).body).toEqual({ provider: 'LPFR', isTest: false, mode: 'LIVE' });
  });

  it('naplata izdaje pravi fiskalni račun; PIN se ne upisuje u fiskalni red', async () => {
    const r = await sell();
    expect(r.order.fiscal).toMatchObject({ status: 'SIGNED', provider: 'LPFR', isTest: false, invoiceType: 'NORMAL' });
    expect(r.order.fiscal.invoiceNumber).toMatch(/^ABCD1234-ABCD1234-\d+$/);
    const sent = lpfr.invoices.at(-1);
    expect(sent).toMatchObject({ invoiceType: 'Normal', transactionType: 'Sale', cashier: expect.any(String), invoiceNumber: expect.stringMatching(/^123\/1\.0\/\d+$/) });
    expect(sent.items[0].labels[0]).toMatch(/^[ЂЕАГЖ]$/);
    expect(sent.payment[0]).toEqual({ amount: expect.any(Number), paymentType: 'Cash' });
    const row = (await ctx.pool.query('SELECT request::text AS q, response FROM fiscal_receipts WHERE order_id = $1', [r.order.id])).rows[0];
    expect(row.q).not.toContain('4321');
    expect(row.response.verificationQRCode).toBeUndefined();

    const p = (await ctx.http().post(api(`/orders/${r.order.id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: idem('r') }).expect(201)).body.job.payload;
    expect(p.fiscalLayout).toMatchObject({ isFiscal: true, transaction: 'ПРОМЕТ ПРОДАЈА', pfrNumber: r.order.fiscal.invoiceNumber });
    expect(p.fiscalLayout.counter).toMatch(/^\d+\/\d+ПП$/);
    expect(p.fiscalLayout.qr).toContain('suf.purs.gov.rs');
  });

  it('odbijen račun (4xx) ide u FAILED bez ponavljanja', async () => {
    const r = await sell('ODBIJ');
    expect(r.order.fiscal).toMatchObject({ status: 'FAILED', invoiceNumber: null });
    expect(r.order.fiscal.lastError).toContain('LPFR 400');
  });

  it('LPFR nedostupan: račun čeka u redu (PENDING) i šalje se ponovo', async () => {
    const port = (server.address() as AddressInfo).port;
    await ctx.http().patch(api(`/computers/${ctx.ids.posDevice}`)).set(auth(admin)).send({ settings: { fiscal: { lpfrUrl: '127.0.0.1:1' } } }).expect(200);
    const r = await sell();
    expect(r.order.fiscal).toMatchObject({ status: 'PENDING', invoiceNumber: null, attempts: 1 });
    await ctx.http().patch(api(`/computers/${ctx.ids.posDevice}`)).set(auth(admin)).send({ settings: { fiscal: { lpfrUrl: `127.0.0.1:${port}` } } }).expect(200);
    await ctx.pool.query('UPDATE fiscal_receipts SET next_attempt_at = now() WHERE order_id = $1', [r.order.id]);
    await ctx.app.get((await import('../../src/modules/fiscal/fiscal')).FiscalService).processDue();
    const o = (await ctx.http().get(api(`/orders/${r.order.id}`)).set(auth(cashier)).expect(200)).body;
    expect(o.fiscal).toMatchObject({ status: 'SIGNED', provider: 'LPFR' });
  });

  it('podešavanje lokala "bez fiskalizacije" vraća TEST', async () => {
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ fiscalMode: 'NONE' }).expect(200);
    const r = await sell();
    expect(r.order.fiscal).toMatchObject({ status: 'SIGNED', provider: 'TEST', isTest: true });
  });
});
