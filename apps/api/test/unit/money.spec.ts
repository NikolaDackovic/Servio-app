import { dec, lineTotal, money, qty, sum, taxFromGross, isDecimalString } from '../../src/common/money';

describe('money — decimalna aritmetika i zaokruživanje', () => {
  it('nema floating-point grešaka (0.1 + 0.2)', () => {
    expect(money(sum(['0.1', '0.2']))).toBe('0.30');
    expect(money(sum(Array(10).fill('0.10')))).toBe('1.00');
  });

  it('iznos stavke = round2(cena × količina), HALF_UP', () => {
    expect(money(lineTotal('100.00', '0.333'))).toBe('33.30');
    expect(money(lineTotal('0.05', '0.5'))).toBe('0.03'); // 0.025 → 0.03 (half-up)
    expect(money(lineTotal('199.99', '3'))).toBe('599.97');
    expect(money(lineTotal('1.15', '1.5'))).toBe('1.73'); // 1.725 → 1.73
  });

  it('PDV se izdvaja iz bruto iznosa', () => {
    expect(money(taxFromGross('120.00', '20.00'))).toBe('20.00');
    expect(money(taxFromGross('540.00', '20.00'))).toBe('90.00');
    expect(money(taxFromGross('110.00', '10.00'))).toBe('10.00');
    expect(money(taxFromGross('100.00', '20.00'))).toBe('16.67');
    expect(money(taxFromGross('500.00', '0.00'))).toBe('0.00');
  });

  it('formatiranje količina i novca', () => {
    expect(qty('2')).toBe('2.000');
    expect(money('5')).toBe('5.00');
    expect(dec(null).toString()).toBe('0');
  });

  it('validacija decimalnih stringova', () => {
    expect(isDecimalString('180.00', 2)).toBe(true);
    expect(isDecimalString('180.001', 2)).toBe(false);
    expect(isDecimalString('-1', 2)).toBe(false);
    expect(isDecimalString(180 as any, 2)).toBe(false);
  });
});
