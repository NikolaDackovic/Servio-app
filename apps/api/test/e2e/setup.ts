import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { AppConfig } from '../../src/config';
import { runMigrations } from '../../src/db/migrate';
import { seed } from '../../src/db/seed';
import { checkDatabase } from '../../src/db/check';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://pos:pos_dev@localhost:5432/pos_test';
const PEPPER = 'test-pin-pepper';

export interface Ctx {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  pool: Pool;
  ids: { org: string; location: string; posDevice: string; kdsDevice: string; bridgeKey: string; stations: { bar: string; kitchen: string }; warehouses: { main: string; bar: string } };
}

/** Svaki test fajl dobija čistu bazu: šema se briše, primenjuju se SVE migracije, pa demo seed. */
export async function setupApp(): Promise<Ctx> {
  if (!/_test\b|_test\?/.test(TEST_DB_URL)) throw new Error('Testovi smeju da rade samo nad bazom čije ime se završava na _test');
  await checkDatabase(TEST_DB_URL); // jedna jasna greška umesto lanca neuspeha
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  await admin.end();
  await runMigrations(TEST_DB_URL);
  const s = await seed(TEST_DB_URL, PEPPER);
  // Testovi proveravaju da server odbija radnju bez prava: konobar u testovima je 'strog' (bez smena i izveštaja),
  // dok podrazumevani konobar u programu sme i da otvori/zatvori smenu i vidi specifikaciju pazara.
  const fix = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await fix.query("UPDATE roles SET permissions = array_remove(array_remove(array_remove(permissions, 'shift.manage'), 'day.manage'), 'report.read') WHERE code = 'WAITER'");
  await fix.end();

  const cfg: AppConfig = {
    databaseUrl: TEST_DB_URL, jwtSecret: 'test-secret-test-secret-test-secret-123', pinPepper: PEPPER,
    port: 0, corsOrigin: ['http://localhost'], paymentMode: 'TEST',
    fiscalProvider: 'TEST', fiscalWorkerIntervalMs: 0, // fiskalni red se u testovima obrađuje eksplicitno
  };
  const app = await createApp(cfg);
  app.useLogger(false);
  await app.listen(0, '127.0.0.1'); // jedan server za sve zahteve (supertest inače pokreće server po zahtevu)
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 3 });
  return {
    app, pool,
    http: () => request(app.getHttpServer()),
    ids: {
      org: s.organizationId, location: (s as any).locationId, posDevice: (s as any).posDeviceId,
      kdsDevice: (s as any).kdsDeviceId, bridgeKey: (s as any).bridgeKey, stations: (s as any).stations,
      warehouses: (s as any).warehouses,
    },
  };
}

export async function teardown(ctx: Ctx | undefined) {
  if (!ctx) return; // setup nije uspeo - nema šta da se zatvori
  await ctx.app.close();
  await ctx.pool.end();
}

export async function pinLogin(ctx: Ctx, pin: string, deviceId = ctx.ids.posDevice): Promise<string> {
  const r = await ctx.http().post('/api/v1/auth/pin').send({ deviceId, pin }).expect(200);
  return r.body.accessToken;
}

export async function passwordLogin(ctx: Ctx, email: string, password: string, deviceId?: string): Promise<string> {
  const r = await ctx.http().post('/api/v1/auth/login').send({ email, password, deviceId }).expect(200);
  return r.body.accessToken;
}

export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let seq = 0;
export const idem = (p = 'k') => `${p}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

export async function productId(ctx: Ctx, token: string, code: string): Promise<string> {
  const r = await ctx.http().get(`/api/v1/products?search=${encodeURIComponent(code)}`).set(auth(token)).expect(200);
  const p = r.body.data.find((x: any) => x.code === code);
  if (!p) throw new Error(`Nema proizvoda ${code}`);
  return p.id;
}

export function today(): string {
  // Datum u zoni lokala (Europe/Belgrade)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date());
}
