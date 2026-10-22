/**
 * Identifikacija kupca na računu — šifre vrste identifikacije iz šifarnika eFiskalizacije.
 * Izvor spiska: javno uputstvo knjigovodstvenog softvera koje prenosi šifarnik PU (vidi docs/FISCAL.md).
 * PRE produkcione fiskalizacije uskladiti sa važećim Tehničkim vodičem PU.
 */
import { Invalid } from './errors';

export const BUYER_ID_TYPES: { code: string; label: string; hint: string }[] = [
  { code: '10', label: 'PIB', hint: 'Domaće pravno lice — 9 cifara' },
  { code: '11', label: 'JMBG', hint: 'Domaći preduzetnik (fizičko lice) — 13 cifara' },
  { code: '12', label: 'PIB i JBKJS', hint: 'Korisnik javnih sredstava — PIB:JBKJS' },
  { code: '20', label: 'Lična karta', hint: 'Domaće fizičko lice' },
  { code: '21', label: 'Izbeglička legitimacija', hint: 'Domaće fizičko lice' },
  { code: '22', label: 'EBS', hint: 'Strano fizičko lice sa boravkom u Srbiji' },
  { code: '23', label: 'Pasoš (domaći)', hint: 'Domaće fizičko lice' },
  { code: '30', label: 'Pasoš (strani)', hint: 'Strano fizičko lice' },
  { code: '31', label: 'Diplomatska legitimacija / LK', hint: 'Strani diplomata' },
  { code: '32', label: 'Lična karta MKD', hint: 'Strano fizičko lice' },
  { code: '33', label: 'Lična karta MNE', hint: 'Strano fizičko lice' },
  { code: '34', label: 'Lična karta ALB', hint: 'Strano fizičko lice' },
  { code: '35', label: 'Lična karta BIH', hint: 'Strano fizičko lice' },
  { code: '40', label: 'Strani poreski broj (TIN)', hint: 'Poreski broj izdat u inostranstvu' },
];

/** Osnovi za opciono polje kupca (npr. oslobođenje od PDV-a). Numeričke šifre se mapiraju pri integraciji sa fiskalizacijom. */
export const BUYER_OPTIONAL_BASES = [
  'LNPDV — lice sa pravom na oslobođenje od PDV-a',
  'Broj ugovora / narudžbenice',
  'Broj polise osiguranja',
  'Drugo',
];

/** PIB: 9 cifara, kontrolna cifra po ISO 7064 (MOD 11,10). */
export function isValidPib(pib: string): boolean {
  if (!/^\d{9}$/.test(pib)) return false;
  let p = 10;
  for (let i = 0; i < 8; i++) {
    let s = (Number(pib[i]) + p) % 10;
    if (s === 0) s = 10;
    p = (2 * s) % 11;
  }
  return (11 - p) % 10 === Number(pib[8]);
}

/** JMBG: 13 cifara, kontrolna cifra (modul 11). */
export function isValidJmbg(j: string): boolean {
  if (!/^\d{13}$/.test(j)) return false;
  const d = j.split('').map(Number);
  const w = [7, 6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let m = 11 - (w.reduce((a, x, i) => a + x * d[i], 0) % 11);
  if (m > 9) m = 0;
  return m === d[12];
}

export function validateBuyer(type: string, value: string) {
  if (!BUYER_ID_TYPES.some((t) => t.code === type)) throw Invalid('INVALID_BUYER_TYPE', 'Nepoznata vrsta identifikacije kupca');
  const v = value.trim();
  if (type === '10' && !isValidPib(v)) throw Invalid('INVALID_PIB', 'PIB nije ispravan (9 cifara, kontrolna cifra)');
  if (type === '11' && !isValidJmbg(v)) throw Invalid('INVALID_JMBG', 'JMBG nije ispravan (13 cifara, kontrolna cifra)');
  if (type === '12') {
    const [pib, jbkjs] = v.split(':');
    if (!pib || !isValidPib(pib) || !/^\d{5}$/.test(jbkjs ?? '')) throw Invalid('INVALID_PIB_JBKJS', 'Format je PIB:JBKJS (9 cifara : 5 cifara)');
  }
  if (!/^[A-Za-z0-9:\-\/ ]{3,40}$/.test(v)) throw Invalid('INVALID_BUYER_ID', 'Broj identifikacije: 3–40 znakova (slova, cifre)');
  return v;
}
