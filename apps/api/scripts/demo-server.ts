/**
 * Demo server za slike uputstva i proveru ekrana: ČISTI bazu TEST_DATABASE_URL (mora se završavati na _test),
 * primeni migracije i demo podatke, pa služi kasu (/), ADMIN (/admin) i KDS (/kds) na http://127.0.0.1:3100.
 * Pre pokretanja: build kase i ADMIN-a (npm run build -w apps/web; ADMIN_BASE=/admin/ npm run build -w apps/admin).
 *
 *   npx ts-node --transpile-only scripts/demo-server.ts      (iz apps/api)
 */
import path from 'node:path';
import { Pool } from 'pg';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { seed } from '../src/db/seed';

const APPS = path.resolve(__dirname, '../..');
process.env.WEB_DIR ??= path.join(APPS, 'web/dist');
process.env.ADMIN_DIR ??= path.join(APPS, 'admin/dist');
process.env.DISABLE_SWAGGER = '1';

(async () => {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://pos:pos_dev@localhost:5432/pos_test';
  if (!/_test(\?|$)/.test(url)) throw new Error('Demo server briše bazu - dozvoljena je samo baza čije ime se završava na _test');
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  await admin.end();
  await runMigrations(url);
  await seed(url, 'demo-pepper');
  const app = await createApp({
    databaseUrl: url, jwtSecret: 'demo-secret-demo-secret-demo-secret-123', pinPepper: 'demo-pepper', port: 3100,
    corsOrigin: ['http://127.0.0.1:3100'], paymentMode: 'TEST', fiscalProvider: 'TEST', fiscalWorkerIntervalMs: 3000,
  });
  app.useLogger(['error']);
  await app.listen(3100, '127.0.0.1');
  console.log('READY http://127.0.0.1:3100');
})().catch((e) => { console.error(e); process.exit(1); });
