/**
 * ADMIN → Korisnici: korisnici (ime, prezime, korisničko ime, PIN, lozinka, uloga), uloge i prava, uvoz/izvoz.
 */
import ExcelJS from 'exceljs';
import { Ctx, auth, passwordLogin, pinLogin, setupApp, teardown } from './setup';

let ctx: Ctx;
let admin: string, waiter: string;
const api = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  ctx = await setupApp();
  admin = await passwordLogin(ctx, 'admin@demo.local', 'Demo123!');
  waiter = await pinLogin(ctx, '1111');
});
afterAll(() => teardown(ctx));

const roles = async () => (await ctx.http().get(api('/roles')).set(auth(admin)).expect(200)).body as any[];

describe('Uloge i prava', () => {
  it('katalog prava je na srpskom, po grupama', async () => {
    const p = (await ctx.http().get(api('/permissions')).set(auth(admin)).expect(200)).body;
    expect(p.find((x: any) => x.code === 'order.void')).toMatchObject({ group: 'Kasa', label: 'Storniranje' });
  });

  it('nova uloga Šanker sa pravima; konobar nema pristup', async () => {
    await ctx.http().get(api('/roles')).set(auth(waiter)).expect(403);
    const r = (await ctx.http().post(api('/roles')).set(auth(admin)).send({ name: 'Šanker', permissions: ['order.read', 'order.write', 'payment.create'] }).expect(201)).body;
    expect(r.code).toBe('SANKER');
    const u = (await ctx.http().patch(api(`/roles/${r.id}`)).set(auth(admin)).send({ permissions: ['order.read', 'order.write', 'payment.create', 'order.void'] }).expect(200)).body;
    expect(u.permissions).toContain('order.void');
    await ctx.http().post(api('/roles')).set(auth(admin)).send({ name: 'Loše', permissions: ['nepostojece.pravo'] }).expect(400);
  });

  it('Administrator uvek ima sva prava; uloga u upotrebi se ne briše', async () => {
    const a = (await roles()).find((x) => x.code === 'ADMIN');
    expect((await ctx.http().patch(api(`/roles/${a.id}`)).set(auth(admin)).send({ permissions: ['order.read'] }).expect(409)).body.error.code).toBe('ROLE_LOCKED');
    const w = (await roles()).find((x) => x.code === 'WAITER');
    expect((await ctx.http().delete(api(`/roles/${w.id}`)).set(auth(admin)).expect(409)).body.error.code).toBe('ROLE_IN_USE');
  });
});

describe('Korisnici', () => {
  let id: string;
  it('novi korisnik sa PIN-om radi na kasi; korisničko ime i PIN su jedinstveni', async () => {
    const sanker = (await roles()).find((x) => x.code === 'SANKER');
    id = (await ctx.http().post(api('/users')).set(auth(admin))
      .send({ firstName: 'Petar', lastName: 'Petrović', username: 'petar', roleId: sanker.id, pin: '4545' }).expect(201)).body.id;
    const t = await pinLogin(ctx, '4545');
    expect((await ctx.http().get(api('/auth/me')).set(auth(t)).expect(200)).body.user.fullName).toBe('Petar Petrović');
    expect((await ctx.http().post(api('/users')).set(auth(admin)).send({ firstName: 'X', username: 'petar', roleId: sanker.id, pin: '9090' }).expect(409)).body.error.code).toBe('USERNAME_TAKEN');
    expect((await ctx.http().post(api('/users')).set(auth(admin)).send({ firstName: 'X', username: 'drugi', roleId: sanker.id, pin: '4545' }).expect(409)).body.error.code).toBe('PIN_TAKEN');
  });

  it('promena uloge važi odmah; deaktiviran ne može da se prijavi', async () => {
    const t = await pinLogin(ctx, '4545');
    const waiterRole = (await roles()).find((x) => x.code === 'WAITER');
    await ctx.http().patch(api(`/users/${id}`)).set(auth(admin)).send({ roleId: waiterRole.id }).expect(200);
    expect((await ctx.http().get(api('/auth/me')).set(auth(t)).expect(200)).body.user.permissions).not.toContain('order.void');
    await ctx.http().patch(api(`/users/${id}`)).set(auth(admin)).send({ active: false }).expect(200);
    await ctx.http().post(api('/auth/pin')).send({ deviceId: ctx.ids.posDevice, pin: '4545' }).expect(401);
  });

  it('ADMIN prijava korisničkim imenom; ne može se deaktivirati sopstveni nalog', async () => {
    const r = await ctx.http().post(api('/auth/login')).send({ email: 'administrator', password: 'Demo123!' }).expect(200);
    const me = (await ctx.http().get(api('/auth/me')).set(auth(r.body.accessToken)).expect(200)).body.user;
    expect((await ctx.http().patch(api(`/users/${me.userId}`)).set(auth(admin)).send({ active: false }).expect(409)).body.error.code).toBe('SELF_DEACTIVATE');
    const waiterRole = (await roles()).find((x) => x.code === 'WAITER');
    expect((await ctx.http().patch(api(`/users/${me.userId}`)).set(auth(admin)).send({ roleId: waiterRole.id }).expect(409)).body.error.code).toBe('SELF_LOCKOUT');
  });

  it('izvoz u Excel i uvoz iz Excel-a (sve ili ništa)', async () => {
    const x = await ctx.http().get(api('/users/export?format=xlsx')).set(auth(admin)).buffer(true)
      .parse((res, cb) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); }).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    expect(wb.worksheets[0].getRow(1).getCell(1).value).toBe('Ime');

    const make = async (rows: any[][]) => {
      const w = new ExcelJS.Workbook(); const s = w.addWorksheet('Korisnici');
      s.addRow(['Ime', 'Prezime', 'Korisničko ime', 'Uloga', 'Šifra (PIN)']); rows.forEach((r) => s.addRow(r));
      return Buffer.from(await w.xlsx.writeBuffer()).toString('base64');
    };
    const bad = await ctx.http().post(api('/users/import')).set(auth(admin))
      .send({ fileName: 'k.xlsx', contentBase64: await make([['Mila', 'Milić', 'mila', 'Konobar', '7171'], ['Bez', 'Uloge', 'bez', 'Nepostojeća', '7272']]) }).expect(422);
    expect(bad.body.error.details.errors).toHaveLength(1);
    expect((await ctx.http().get(api('/users')).set(auth(admin)).expect(200)).body.some((u: any) => u.username === 'mila')).toBe(false);
    const ok = (await ctx.http().post(api('/users/import')).set(auth(admin))
      .send({ fileName: 'k.xlsx', contentBase64: await make([['Mila', 'Milić', 'mila', 'Konobar', '7171']]) }).expect(200)).body;
    expect(ok).toEqual({ created: 1, updated: 0 });
    await pinLogin(ctx, '7171');
  });
});

describe('Rastavljanje je posebno pravo', () => {
  it('uloga bez prava rastavljanja ne prebacuje stavke', async () => {
    const r = (await ctx.http().post(api('/roles')).set(auth(admin)).send({ name: 'Pomoćni', permissions: ['order.read', 'order.write', 'table.read', 'catalog.read'] }).expect(201)).body;
    await ctx.http().post(api('/users')).set(auth(admin)).send({ firstName: 'Pom', username: 'pom', roleId: r.id, pin: '6363' }).expect(201);
    const t = await pinLogin(ctx, '6363');
    const res = await ctx.http().post(api('/orders/00000000-0000-0000-0000-000000000000/move-items')).set(auth(t)).send({ itemIds: ['00000000-0000-0000-0000-000000000000'], toTabName: 'x' });
    expect(res.status).toBe(403);
  });
});
