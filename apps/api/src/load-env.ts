/**
 * Učitava apps/api/.env (ako postoji) pre čitanja konfiguracije.
 * Radi i iz src/ (ts-node) i iz dist/ (build), i ne zavisi od trenutnog foldera
 * (npm workspaces, PowerShell, Windows servis). Već postavljene promenljive okruženja imaju prednost.
 */
import fs from 'fs';
import path from 'path';

const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath); // Node ≥ 20.12; ne prepisuje postojeće promenljive
  } catch (e) {
    console.error(`Ne mogu da pročitam ${envPath}: ${(e as Error).message}`);
    process.exit(1);
  }
}
