/**
 * Podrazumevani nalozi svake baze (ADMIN/0000, KON01/11, KON02/22, tv/tv) i prijava karticom (čitač kartica = PIN).
 */
import { Ctx, auth, passwordLogin, setupApp, teardown } from './setup';

let ctx: Ctx;
let admin: string;
const api = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  ctx = await setupApp();
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!', ctx.ids.posDevice);
});
afterAll(() => teardown(ctx));

const pin = (p: string, deviceId = ctx.ids.posDevice) => ctx.http().post(api('/auth/pin')).send({ deviceId, pin: p });

describe('Podrazumevani nalozi', () => {
  it('ADMIN / 0000 (velika ili mala slova), PIN 0000 na kasi', async () => {
    const r = (await ctx.http().post(api('/auth/login')).send({ email: 'ADMIN', password: '0000' }).expect(200)).body;
    expect(r.user).toMatchObject({ fullName: 'ADMIN', role: 'ADMIN' });
    await ctx.http().post(api('/auth/login')).send({ email: 'admin', password: '0000' }).expect(200);
    expect((await pin('0000').expect(200)).body.user.fullName).toBe('ADMIN');
  });

  it('KON01 / 11 i KON02 / 22 su konobari na kasi', async () => {
    expect((await pin('11').expect(200)).body.user).toMatchObject({ fullName: 'KON01', role: 'WAITER' });
    expect((await pin('22').expect(200)).body.user).toMatchObject({ fullName: 'KON02', role: 'WAITER' });
  });

  it('KDS: tv / tv', async () => {
    const r = (await ctx.http().post(api('/auth/login')).send({ email: 'tv', password: 'tv', deviceId: ctx.ids.kdsDevice }).expect(200)).body;
    expect(r.user.role).toBe('KITCHEN');
    expect(r.deviceId).toBe(ctx.ids.kdsDevice);
  });

  it('Početna upozorava dok ADMIN ima šifru 0000', async () => {
    expect((await ctx.http().get(api('/admin/overview')).set(auth(admin)).expect(200)).body.warnings.defaultPassword).toBe(true);
    const users = (await ctx.http().get(api('/users')).set(auth(admin)).expect(200)).body;
    const a = users.find((u: any) => u.username === 'admin');
    await ctx.http().patch(api(`/users/${a.id}`)).set(auth(admin)).send({ password: 'nova-sifra-1' }).expect(200);
    expect((await ctx.http().get(api('/admin/overview')).set(auth(admin)).expect(200)).body.warnings.defaultPassword).toBe(false);
  });
});

describe('Vraćanje podrazumevanih naloga (Ctrl+Shift+R na glavnoj kasi)', () => {
  it('samo sa tokenom programa; vraća ADMIN/0000 i PIN', async () => {
    const token = 'x'.repeat(48);
    process.env.LOCAL_TOKEN = token;
    await ctx.http().post(api('/setup/reset-logins')).expect(403);
    await ctx.http().post(api('/setup/reset-logins')).set('x-local-token', 'y'.repeat(48)).expect(403);
    // ADMIN je u međuvremenu promenio šifru (test iznad) - posle vraćanja opet radi 0000
    await ctx.http().post(api('/auth/login')).send({ email: 'ADMIN', password: '0000' }).expect(401);
    const r = (await ctx.http().post(api('/setup/reset-logins')).set('x-local-token', token).expect(200)).body;
    expect(r.done.join(' ')).toContain('ADMIN');
    await ctx.http().post(api('/auth/login')).send({ email: 'ADMIN', password: '0000' }).expect(200);
    expect((await pin('0000').expect(200)).body.user.fullName).toBe('ADMIN');
    await ctx.http().post(api('/auth/login')).send({ email: 'tv', password: 'tv' }).expect(200);
    delete process.env.LOCAL_TOKEN;
  });
});

describe('Kartica', () => {
  it('dodeljena kartica prijavljuje zaposlenog; ista kartica ne može drugom; uklanjanje', async () => {
    const users = (await ctx.http().get(api('/users')).set(auth(admin)).expect(200)).body;
    const kon1 = users.find((u: any) => u.username === 'kon01');
    const kon2 = users.find((u: any) => u.username === 'kon02');
    await pin('0012345678').expect(401);
    await ctx.http().patch(api(`/users/${kon1.id}`)).set(auth(admin)).send({ card: '0012345678' }).expect(200);
    expect((await ctx.http().get(api('/users')).set(auth(admin)).expect(200)).body.find((u: any) => u.id === kon1.id).hasCard).toBe(true);
    expect((await pin('0012345678').expect(200)).body.user.fullName).toBe('KON01');
    // hex kartice: mala/velika slova su ista kartica
    await ctx.http().patch(api(`/users/${kon2.id}`)).set(auth(admin)).send({ card: 'ab12cd34' }).expect(200);
    expect((await pin('AB12CD34').expect(200)).body.user.fullName).toBe('KON02');
    await ctx.http().patch(api(`/users/${kon2.id}`)).set(auth(admin)).send({ card: '0012345678' }).expect(409);
    await ctx.http().patch(api(`/users/${kon1.id}`)).set(auth(admin)).send({ card: null }).expect(200);
    await pin('0012345678').expect(401);
    await ctx.http().patch(api(`/users/${kon1.id}`)).set(auth(admin)).send({ card: '12' }).expect(400);
  });
});
