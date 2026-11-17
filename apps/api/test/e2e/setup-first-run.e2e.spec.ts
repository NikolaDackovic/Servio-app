/**
 * Prvo pokretanje instalirane kase: dok baza nema firmu, kasa nudi podešavanje (nova radnja ili demo);
 * posle toga podešavanje više nije moguće.
 */
import { Ctx, setupApp, teardown } from './setup';

let ctx: Ctx;
const api = (p: string) => `/api/v1${p}`;

beforeAll(async () => { ctx = await setupApp(); });
afterAll(() => teardown(ctx));

const NEW = {
  mode: 'NEW', companyName: 'Kafe Centar d.o.o.', pib: '100000024', storeName: 'Kafe Centar', address: 'Knez Mihailova 1, Beograd',
};

describe('Prvo pokretanje', () => {
  it('podešena baza: nema podešavanja, ponovno podešavanje se odbija', async () => {
    expect((await ctx.http().get(api('/setup/status')).expect(200)).body).toEqual({ needsSetup: false });
    expect((await ctx.http().post(api('/setup')).send(NEW).expect(409)).body.error.code).toBe('ALREADY_SET_UP');
  });

  it('prazna baza: nova radnja sa podrazumevanim nalozima (ADMIN/0000, KON01/11, KON02/22, tv/tv); drugi put 409', async () => {
    await ctx.pool.query('TRUNCATE organizations CASCADE');
    expect((await ctx.http().get(api('/setup/status')).expect(200)).body).toEqual({ needsSetup: true });
    await ctx.http().post(api('/setup')).send({ ...NEW, pib: '123' }).expect(400);
    await ctx.http().post(api('/setup')).send(NEW).expect(201);
    expect((await ctx.http().get(api('/setup/status')).expect(200)).body).toEqual({ needsSetup: false });

    const login = (await ctx.http().post(api('/auth/login')).send({ email: 'ADMIN', password: '0000' }).expect(200)).body;
    expect(login.user.permissions).toContain('settings.manage');
    const kasa = (await ctx.http().get(api('/auth/kasa')).expect(200)).body.device;
    expect(kasa).toMatchObject({ name: 'Kasa 1', location: 'Kafe Centar' });
    const pin = (await ctx.http().post(api('/auth/pin')).send({ deviceId: kasa.id, pin: '0000' }).expect(200)).body;
    expect(pin.user.fullName).toBe('ADMIN');
    expect((await ctx.http().post(api('/auth/pin')).send({ deviceId: kasa.id, pin: '11' }).expect(200)).body.user.fullName).toBe('KON01');
    expect((await ctx.http().post(api('/auth/pin')).send({ deviceId: kasa.id, pin: '22' }).expect(200)).body.user.fullName).toBe('KON02');
    const st = (await ctx.http().get(api('/settings/kasa')).set('Authorization', `Bearer ${pin.accessToken}`).expect(200)).body;
    expect(st).toMatchObject({ pib: '100000024', companyName: 'Kafe Centar d.o.o.', storeName: 'Kafe Centar' });
    const kds = (await ctx.http().get(api('/auth/kasa?kind=KDS')).expect(200)).body.device;
    expect(kds.name).toBe('KDS - Kuhinja');
    await ctx.http().post(api('/auth/login')).send({ email: 'tv', password: 'tv', deviceId: kds.id }).expect(200);

    expect((await ctx.http().post(api('/setup')).send(NEW).expect(409)).body.error.code).toBe('ALREADY_SET_UP');
  });
});
