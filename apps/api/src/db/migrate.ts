/** Primena SQL migracija iz ./migrations (koristi se i u produkciji i u testovima). */
import '../load-env';
import path from 'path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { checkDatabase } from './check';

export async function runMigrations(databaseUrl: string): Promise<void> {
  await checkDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    // MIGRATIONS_DIR: instalirana kasa (server spojen u jedan fajl, migracije pored njega)
    await migrate(drizzle(pool), { migrationsFolder: process.env.MIGRATIONS_DIR ?? path.resolve(__dirname, '../../migrations') });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL nije postavljen');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('Migracije primenjene.'))
    .catch((e) => {
      console.error('Greška pri migraciji:', e.message, e.cause?.message ? `\nUzrok: ${e.cause.message}` : '');
      process.exit(1);
    });
}
