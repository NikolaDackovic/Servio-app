/**
 * ADMIN prijava samo šifrom, promena načina plaćanja, grupe za prodaju (sirovine), dodatni podaci na računu.
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
  await ctx.http().post(api('/business-days/open')).set(auth(cashier)).send({}).expect(201);
  await ctx.http().post(api('/shifts/open')).set(auth(cashier)).send({ openingCash: '0.00' }).expect(201);
});
afterAll(() => teardown(ctx));

const paidOrder = async (method: string) => {
  const o = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: idem('o') }).expect(201)).body;
  await ctx.http().post(api(`/orders/${o.id}/items`)).set(auth(waiter)).send({ productId: await productId(ctx, admin, 'K001') }).expect(201);
  return (await ctx.http().post(api(`/orders/${o.id}/settle`)).set(auth(cashier)).send({ parts: [{ method }], idempotencyKey: idem('p') }).expect(201)).body.order;
};

describe('ADMIN prijava šifrom', () => {
  it('PIN 0000 (ADMIN) ulazi; konobar (PIN 11) takođe (vidi samo ono za šta ima prava); pogrešna šifra 401', async () => {
    const r = (await ctx.http().post(api('/auth/admin-pin')).send({ pin: '0000' }).expect(200)).body;
    expect(r.user.fullName).toBe('ADMIN');
    expect(r.deviceId).toBeNull();
    const w = (await ctx.http().post(api('/auth/admin-pin')).send({ pin: '11' }).expect(200)).body;
    expect(w.user.permissions).not.toContain('settings.manage');
    await ctx.http().post(api('/auth/admin-pin')).send({ pin: '4242' }).expect(401);
  });
});

describe('Promena načina plaćanja', () => {
  it('kartica 4000 → gotovina; zbir mora biti isti; reprezentacija se ne menja', async () => {
    const o = await paidOrder('CARD');
    const total = o.total;
    await ctx.http().post(api(`/orders/${o.id}/payments/change`)).set(auth(manager)).send({ parts: [{ method: 'CASH', amount: '1.00' }] }).expect(422);
    await ctx.http().post(api(`/orders/${o.id}/payments/change`)).set(auth(waiter)).send({ parts: [{ method: 'CASH', amount: total }] }).expect(403);
    await ctx.http().post(api(`/orders/${o.id}/payments/change`)).set(auth(manager)).send({ parts: [{ method: 'CASH', amount: total }] }).expect(200);
    const after = (await ctx.http().get(api(`/orders/${o.id}`)).set(auth(manager)).expect(200)).body;
    expect(after.payments.map((p: any) => `${p.method}:${p.amount}`)).toEqual([`CASH:${total}`]);
    const rep = (await ctx.http().post(api('/orders')).set(auth(waiter)).send({ idempotencyKey: idem('o') }).expect(201)).body;
    await ctx.http().post(api(`/orders/${rep.id}/items`)).set(auth(waiter)).send({ productId: await productId(ctx, admin, 'K001') }).expect(201);
    await ctx.http().post(api(`/orders/${rep.id}/settle`)).set(auth(cashier)).send({ parts: [{ method: 'REPRESENTATION' }], idempotencyKey: idem('p') }).expect(201);
    await ctx.http().post(api(`/orders/${rep.id}/payments/change`)).set(auth(manager)).send({ parts: [{ method: 'CASH', amount: total }] }).expect(409);
  });
});

describe('Grupe i račun', () => {
  it('grupa sirovina (nije za prodaju) se ne vidi u QR meniju', async () => {
    const g = (await ctx.http().post(api('/categories')).set(auth(admin)).send({ name: 'Sirovine voće', forSale: false }).expect(201)).body;
    expect(g.forSale).toBe(false);
    const cats = (await ctx.http().get(api('/categories')).set(auth(admin)).expect(200)).body;
    expect(cats.find((c: any) => c.id === g.id).forSale).toBe(false);
    const tables = (await ctx.http().get(api('/tables')).set(auth(admin)).expect(200)).body;
    const m = (await ctx.http().get(api(`/public/qr/${tables[0].qrToken}`)).expect(200)).body;
    expect(m.categories.some((c: any) => c.id === g.id)).toBe(false);
  });

  it('žiro račun, telefon i MB idu na isečak', async () => {
    await ctx.http().put(api('/settings/kasa')).set(auth(admin)).send({ bankAccount: '160-123456-78', phone: '011/123-456', registrationNo: '12345678' }).expect(200);
    const o = await paidOrder('CASH');
    const p = (await ctx.http().post(api(`/orders/${o.id}/print-receipt`)).set(auth(cashier)).send({ idempotencyKey: idem('r') }).expect(201)).body.job.payload;
    expect(p.fiscalLayout.extra).toEqual(['МБ: 12345678', 'Жиро рачун: 160-123456-78', 'Тел: 011/123-456']);
  });
});

describe('Podrazumevane uloge', () => {
  it('konobar (podrazumevano) ima smene i specifikaciju pazara; PIN može imati 1-10 cifara', async () => {
    const { DEFAULT_ROLES } = await import('../../src/common/permissions');
    const w = DEFAULT_ROLES.find((r) => r.code === 'WAITER')!;
    expect(w.permissions).toEqual(expect.arrayContaining(['shift.manage', 'day.manage', 'report.read']));
    expect(w.permissions).not.toContain('settings.manage');
    const users = (await ctx.http().get(api('/users')).set(auth(admin)).expect(200)).body as any[];
    const u = users.find((x: any) => x.fullName === 'Marko Konobar');
    await ctx.http().patch(api(`/users/${u.id}`)).set(auth(admin)).send({ pin: '7' }).expect(200);
    await ctx.http().post(api('/auth/admin-pin')).send({ pin: '7' }).expect(200);
    await ctx.http().patch(api(`/users/${u.id}`)).set(auth(admin)).send({ pin: '12345678901' }).expect(400);
  });
});
