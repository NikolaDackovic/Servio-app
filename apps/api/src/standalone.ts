/**
 * Server instalirane kase (desktop aplikacija ga pokreće kao poseban proces):
 * primenjuje migracije na lokalnu bazu, pa pokreće API koji služi i aplikacije (kasa, KDS, ADMIN).
 * Konfiguracija dolazi iz okruženja koje postavlja desktop aplikacija (DATABASE_URL, JWT_SECRET, PIN_PEPPER,
 * PORT, WEB_DIR, ADMIN_DIR, MIGRATIONS_DIR). Sluša na svim mrežnim karticama, da ADMIN i KDS rade sa drugih uređaja.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { loadConfig } from './config';
import { createApp } from './app';
import { runMigrations } from './db/migrate';

async function start() {
  const cfg = loadConfig();
  await runMigrations(cfg.databaseUrl);
  const app = await createApp(cfg);
  await app.listen(cfg.port, '0.0.0.0');
  Logger.log(`POS server: http://localhost:${cfg.port}`, 'Kasa');
  process.send?.({ type: 'ready', port: cfg.port });
}

start().catch((e) => {
  console.error(`Pokretanje servera nije uspelo: ${e?.message ?? e}`);
  process.exit(1);
});
