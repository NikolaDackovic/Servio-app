import { and, eq } from 'drizzle-orm';
import { DbOrTx } from '../../db/db.module';
import { businessDays, staffShifts } from '../../db/schema';
import { AuthUser } from '../../common/auth-context';
import { Conflict } from '../../common/errors';

/** Otvoren poslovni dan lokala (opciono zaključan FOR UPDATE). */
export async function findOpenDay(tx: DbOrTx, locationId: string, lock = false) {
  const q = tx.select().from(businessDays)
    .where(and(eq(businessDays.locationId, locationId), eq(businessDays.status, 'OPEN')));
  const [d] = lock ? await q.for('update') : await q;
  return d;
}

/** Prodaja i naplata su mogući samo u otvorenom poslovnom danu. */
export async function requireOpenDay(tx: DbOrTx, u: AuthUser, lock = false) {
  const d = await findOpenDay(tx, u.locationId, lock);
  if (!d) throw Conflict('DAY_NOT_OPEN', 'Poslovni dan nije otvoren. Otvorite dan (meni "Dan") pre rada na kasi.');
  return d;
}

/**
 * Vraća otvorenu smenu zaposlenog u lokalu, a ako je nema - otvara je u tekućem danu.
 * Smena počinje prvom radnjom zaposlenog (otvaranje računa, naplata), ne prijavom,
 * da bi kratka prijava radi pregleda ne pravila prazne smene.
 */
export async function ensureStaffShift(tx: DbOrTx, u: AuthUser, businessDayId: string) {
  await tx.insert(staffShifts)
    .values({ locationId: u.locationId, businessDayId, userId: u.userId })
    .onConflictDoNothing();
  const [s] = await tx.select().from(staffShifts)
    .where(and(eq(staffShifts.locationId, u.locationId), eq(staffShifts.userId, u.userId), eq(staffShifts.status, 'OPEN')));
  return s;
}
