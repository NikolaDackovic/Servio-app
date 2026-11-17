import * as s from './schema';
import { hashSecret, pinLookup } from '../common/security';

/**
 * Podrazumevani nalozi svake nove baze (isti u svakom lokalu); menjaju se u ADMIN → Korisnici.
 *   ADMIN / 0000  - ADMIN (korisničko ime ADMIN, lozinka 0000) i kasa (PIN 0000)
 *   KON01 / 11, KON02 / 22 - konobari, PIN za kasu
 *   tv / tv       - KDS ekran (korisničko ime i lozinka)
 * Početna ADMIN-a upozorava dok je lozinka ADMIN-a i dalje 0000.
 */
export const DEFAULT_LOGINS = [
  { fullName: 'ADMIN', username: 'admin', role: 'ADMIN', password: '0000', pin: '0000' },
  { fullName: 'KON01', username: 'kon01', role: 'WAITER', pin: '11' },
  { fullName: 'KON02', username: 'kon02', role: 'WAITER', pin: '22' },
  { fullName: 'TV (KDS)', username: 'tv', role: 'KITCHEN', password: 'tv' },
] as const;

export async function createDefaultUsers(tx: any, organizationId: string, roleIds: Record<string, string>, pinPepper: string) {
  for (const d of DEFAULT_LOGINS) {
    const pin = 'pin' in d ? d.pin : null;
    const password = 'password' in d ? d.password : null;
    await tx.insert(s.users).values({
      organizationId, roleId: roleIds[d.role], fullName: d.fullName, firstName: d.fullName, lastName: '', username: d.username,
      passwordHash: password ? await hashSecret(password) : null,
      pinHash: pin ? await hashSecret(pin) : null, pinLookup: pin ? pinLookup(pin, pinPepper) : null,
    });
  }
}
