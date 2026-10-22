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
  };
}

export const CONFIG = Symbol('CONFIG');
