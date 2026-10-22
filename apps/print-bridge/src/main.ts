import fs from 'fs';
import path from 'path';
import { PrintBridge } from './bridge';
import { Codepage } from './render';

// .env pored package.json (radi bez obzira iz kog foldera se pokreće)
const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const key = process.env.BRIDGE_KEY ?? '';
if (!key.startsWith('pb_')) {
  console.error('Nedostaje BRIDGE_KEY (počinje sa pb_). Ključ izdaje ADMIN → Štampa → Print Bridge. Pogledajte .env.example.');
  process.exit(1);
}
const cp = (process.env.CODEPAGE ?? 'ascii').toLowerCase();
if (!['ascii', 'cp852', 'cp1250'].includes(cp)) {
  console.error(`CODEPAGE=${cp} nije podržan (ascii, cp852, cp1250)`);
  process.exit(1);
}

const bridge = new PrintBridge({
  apiUrl: (process.env.API_URL ?? 'http://localhost:3000/api/v1').replace(/\/$/, ''),
  key,
  pollMs: Number(process.env.POLL_MS ?? 1500),
  codepage: cp as Codepage,
  codepageNumber: process.env.CODEPAGE_NUMBER ? Number(process.env.CODEPAGE_NUMBER) : null,
  simulatedDir: path.resolve(process.env.SIMULATED_DIR ?? path.resolve(__dirname, '..', 'simulated-output')),
});

bridge.hello()
  .catch((e) => console.error(`Prvo povezivanje nije uspelo: ${e.message} — nastavljam sa pokušajima.`))
  .finally(() => bridge.start());

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`Zaustavljam Print Bridge (odštampano ${bridge.stats.printed}, simulirano ${bridge.stats.simulated}, neuspešno ${bridge.stats.failed}).`);
    bridge.stop();
    process.exit(0);
  });
}
