/**
 * Precizna decimalna aritmetika za novac i količine.
 *
 * Pravila (dokumentovano u docs/DATABASE.md):
 *  - Nikada se ne koristi JS `number` za novac.
 *  - Zaokruživanje: HALF_UP (komercijalno) na 2 decimale za novac, 3 za količine.
 *  - Iznos stavke = round2(jedinična bruto cena × količina).
 *  - Ukupan iznos računa = zbir zaokruženih iznosa stavki (bez naknadnog zaokruživanja).
 *  - PDV se izdvaja iz bruto iznosa: porez = round2(bruto × stopa / (100 + stopa)).
 */
import Decimal from 'decimal.js';

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;
export type DecInput = string | number | Dec;

export const ZERO = new D(0);

export function dec(v: DecInput | null | undefined): Dec {
  if (v === null || v === undefined || v === '') return ZERO;
  return new D(v as any);
}

export function round2(v: DecInput): Dec {
  return dec(v).toDecimalPlaces(2, D.ROUND_HALF_UP);
}

export function round3(v: DecInput): Dec {
  return dec(v).toDecimalPlaces(3, D.ROUND_HALF_UP);
}

/** Formatira novac za bazu i API: uvek string sa tačno 2 decimale. */
export function money(v: DecInput): string {
  return round2(v).toFixed(2);
}

export function qty(v: DecInput): string {
  return round3(v).toFixed(3);
}

export function lineTotal(unitPrice: DecInput, quantity: DecInput): Dec {
  return round2(dec(unitPrice).mul(dec(quantity)));
}

export function sum(values: DecInput[]): Dec {
  return values.reduce<Dec>((acc, v) => acc.add(dec(v)), ZERO);
}

/** PDV sadržan u bruto iznosu za datu stopu (u procentima, npr. "20.00"). */
export function taxFromGross(gross: DecInput, ratePercent: DecInput): Dec {
  const r = dec(ratePercent);
  if (r.isZero()) return ZERO;
  return round2(dec(gross).mul(r).div(r.add(100)));
}

/** Proverava da string predstavlja ne-negativan decimalni broj sa najviše `scale` decimala. */
export function isDecimalString(v: unknown, scale: number): v is string {
  if (typeof v !== 'string') return false;
  const re = new RegExp(`^\\d{1,12}(\\.\\d{1,${scale}})?$`);
  return re.test(v);
}
