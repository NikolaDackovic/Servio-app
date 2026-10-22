/** Konfiguracija iz okruženja. Tajne se nikada ne loguju. */
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Nedostaje obavezna promenljiva okruženja: ${name} (pogledaj .env.example)`);
  }
  return v;
}

export interface AppConfig {
  databaseUrl: string;
  jwtSecret: string;
  pinPepper: string;
  port: number;
  corsOrigin: string[];
  /** Iteracija 1 podržava isključivo TEST režim naplate (nema integracije sa platnim terminalom). */
  paymentMode: 'TEST';
  /** Fiskalni provajder: TEST (testni adapter, jasno označen) ili NONE (fiskalizacija isključena). LIVE ne postoji. */
  fiscalProvider: 'TEST' | 'NONE';
  /** Interval pozadinskog obrađivača fiskalnog reda (ms); 0 = samo obrada odmah posle naplate. */
  fiscalWorkerIntervalMs: number;
}

export function loadConfig(): AppConfig {
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET mora imati najmanje 32 znaka');
  const mode = process.env.PAYMENT_MODE ?? 'TEST';
  if (mode !== 'TEST') {
    throw new Error('PAYMENT_MODE=LIVE još nije podržan: ne postoji integracija sa platnim terminalom/fiskalnim uređajem.');
  }
  return {
    databaseUrl: required('DATABASE_URL'),
    jwtSecret,
    pinPepper: required('PIN_PEPPER'),
    port: Number(process.env.PORT ?? 3000),
    corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
    paymentMode: 'TEST',
    fiscalProvider: fiscalProvider(),
    fiscalWorkerIntervalMs: Number(process.env.FISCAL_WORKER_INTERVAL_MS ?? 5000),
  };
}

function fiscalProvider(): 'TEST' | 'NONE' {
  const v = (process.env.FISCAL_PROVIDER ?? 'TEST').toUpperCase();
  if (v === 'TEST' || v === 'NONE') return v;
  throw new Error(`FISCAL_PROVIDER=${v} nije podržan. Podržano: TEST, NONE. Integracija sa stvarnim PFR/ESIR sistemom ne postoji.`);
}

export const CONFIG = Symbol('CONFIG');
