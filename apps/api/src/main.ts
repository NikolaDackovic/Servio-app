import './load-env';
import { Logger } from '@nestjs/common';
import { loadConfig } from './config';
import { createApp } from './app';
import { checkDatabase } from './db/check';

async function bootstrap() {
  const cfg = loadConfig();
  await checkDatabase(cfg.databaseUrl); // bez baze API ne prijavljuje uspešan start
  const app = await createApp(cfg);
  await app.listen(cfg.port);
  Logger.log(`POS API: http://localhost:${cfg.port}/api/v1  |  Swagger: http://localhost:${cfg.port}/api/docs`, 'Bootstrap');
  Logger.warn('Režim naplate: TEST (nema platnog terminala ni fiskalizacije)', 'Bootstrap');
}

bootstrap().catch((e) => {
  // Jasna poruka ako baza nije dostupna ili konfiguracija nedostaje.
  console.error(`Pokretanje nije uspelo: ${e?.message ?? e}`);
  process.exit(1);
});
