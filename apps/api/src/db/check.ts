import { Pool } from 'pg';

/** Proverava vezu sa bazom i vraća razumljivu poruku na srpskom (bez lozinke iz URL-a). */
export async function checkDatabase(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  const safeUrl = databaseUrl.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
  try {
    await pool.query('SELECT 1');
  } catch (e: any) {
    const codes = [e?.code, ...(e?.errors ?? []).map((x: any) => x?.code)];
    let hint = e?.message ?? String(e);
    if (codes.includes('ECONNREFUSED')) {
      hint = 'PostgreSQL ne radi ili ne sluša na tom portu. Na Windowsu: Services → postgresql-x64-16 → Start (ili instalirajte PostgreSQL 16).';
    } else if (e?.code === '28P01') {
      hint = 'Pogrešna lozinka — DATABASE_URL u apps/api/.env ne odgovara korisniku u bazi.';
    } else if (e?.code === '3D000') {
      hint = 'Baza ne postoji — napravite je (vidi docs/DEPLOYMENT.md, "Windows — razvoj").';
    } else if (e?.code === '28000') {
      hint = 'Korisnik ne postoji ili nema pristup — napravite korisnika (vidi docs/DEPLOYMENT.md).';
    }
    throw new Error(`Baza podataka nije dostupna (${safeUrl}).\n${hint}`);
  } finally {
    await pool.end().catch(() => {});
  }
}
