/**
 * Pretvaranje sadržaja zadatka (nezavisnog od štampača) u redove teksta i u ESC/POS bajtove.
 * Isti redovi se koriste i za SIMULATED izlaz, pa se simulacija i papir ne razlikuju po sadržaju.
 */

export type Codepage = 'ascii' | 'cp852' | 'cp1250';

export interface Line { text: string; bold?: boolean; big?: boolean; center?: boolean }

const TRANSLIT: Record<string, string> = {
  'Č': 'C', 'č': 'c', 'Ć': 'C', 'ć': 'c', 'Đ': 'Dj', 'đ': 'dj', 'Š': 'S', 'š': 's', 'Ž': 'Z', 'ž': 'z',
  '–': '-', '—': '-', '„': '"', '“': '"', '”': '"', '’': "'", '×': 'x',
};
const CP852: Record<string, number> = {
  'Č': 0xac, 'č': 0x9f, 'Ć': 0x8f, 'ć': 0x86, 'Đ': 0xd1, 'đ': 0xd0, 'Š': 0xe6, 'š': 0xe7, 'Ž': 0xa6, 'ž': 0xa7,
};
const CP1250: Record<string, number> = {
  'Č': 0xc8, 'č': 0xe8, 'Ć': 0xc6, 'ć': 0xe6, 'Đ': 0xd0, 'đ': 0xf0, 'Š': 0x8a, 'š': 0x9a, 'Ž': 0x8e, 'ž': 0x9e,
};
/** Podrazumevani brojevi kodnih strana za ESC t n (Epson). Drugi modeli mogu imati druge brojeve. */
export const DEFAULT_CODEPAGE_NUMBER: Record<Codepage, number | null> = { ascii: null, cp852: 18, cp1250: 45 };

export function encodeText(s: string, cp: Codepage): Buffer {
  const out: number[] = [];
  for (const ch of s) {
    const table = cp === 'cp852' ? CP852 : cp === 'cp1250' ? CP1250 : null;
    if (table && table[ch] !== undefined) { out.push(table[ch]); continue; }
    const t = TRANSLIT[ch];
    if (t !== undefined) { for (const c of t) out.push(c.charCodeAt(0)); continue; }
    const code = ch.charCodeAt(0);
    out.push(code >= 0x20 && code < 0x7f ? code : 0x3f); // nepoznat znak → '?'
  }
  return Buffer.from(out);
}

export const charsPerLine = (paperWidth: number) => (paperWidth === 58 ? 32 : 48);

function pad(left: string, right: string, width: number) {
  const space = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(space) + right;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if ((cur + ' ' + word).trim().length > width) {
      if (cur) out.push(cur);
      cur = word.length > width ? word.slice(0, width) : word;
    } else cur = (cur + ' ' + word).trim();
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

const qtyText = (q: string) => {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
};
const time = (iso: string) => new Date(iso).toLocaleString('sr-Latn-RS', { timeZone: 'Europe/Belgrade', hour12: false });
const moneyText = (s: string) => {
  const [i, d = '00'] = s.split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d.padEnd(2, '0')}`;
};

/** Redovi za sve vrste zadataka. */
export function renderLines(kind: string, payload: any, paperWidth: number): Line[] {
  const w = charsPerLine(paperWidth);
  const sep = '-'.repeat(w);
  const L: Line[] = [];
  if (kind === 'ORDER_TICKET' || kind === 'VOID_TICKET') {
    L.push({ text: `${payload.title} – ${payload.station}`, bold: true, big: true, center: true });
    if (kind === 'VOID_TICKET') L.push({ text: '*** STORNO — NE PRIPREMATI ***', bold: true, center: true });
    const where = [payload.table ?? 'Brza prodaja', payload.tab ? `(${payload.tab})` : null].filter(Boolean).join(' ');
    L.push({ text: where, big: true, bold: true });
    L.push({ text: pad(`Račun #${payload.orderNumber}`, payload.batch ? `Tura ${payload.batch}` : '', w) });
    L.push({ text: pad(payload.waiter ?? '', time(payload.createdAt), w) });
    L.push({ text: sep });
    for (const l of payload.lines ?? []) {
      const first = `${qtyText(l.qty)} x ${l.name}`;
      wrap(first, Math.floor(w / 2)).forEach((t) => L.push({ text: t, big: true, bold: true }));
      if (l.note) wrap(`  >> ${l.note}`, w).forEach((t) => L.push({ text: t, bold: true }));
    }
    if (payload.reason) { L.push({ text: sep }); wrap(`Razlog: ${payload.reason}`, w).forEach((t) => L.push({ text: t })); }
    return L;
  }
  if (kind === 'RECEIPT') {
    if (payload.notFiscalNotice) L.push({ text: payload.notFiscalNotice, bold: true, center: true });
    L.push({ text: payload.location ?? '', bold: true, center: true });
    L.push({ text: payload.copy ? `${payload.title} — KOPIJA` : payload.title, big: true, bold: true, center: true });
    L.push({ text: pad(`Račun #${payload.orderNumber}`, payload.table ?? 'Brza prodaja', w) });
    L.push({ text: pad(payload.waiter ?? '', time(payload.createdAt), w) });
    L.push({ text: sep });
    for (const l of payload.lines ?? []) {
      wrap(`${l.name} (${l.taxLabel})`, w).forEach((t) => L.push({ text: t }));
      L.push({ text: pad(`  ${qtyText(l.qty)} x ${moneyText(l.unitPrice)}`, moneyText(l.total), w) });
    }
    L.push({ text: sep });
    if (payload.discount && payload.discount !== '0.00') {
      L.push({ text: pad('Međuzbir', moneyText(payload.subtotal), w) });
      L.push({ text: pad('Popust', `-${moneyText(payload.discount)}`, w) });
    }
    L.push({ text: pad('UKUPNO', moneyText(payload.total), w), bold: true, big: false });
    const names: Record<string, string> = { CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Virman', REPRESENTATION: 'Reprezentacija' };
    for (const p of payload.payments ?? []) {
      L.push({ text: pad(names[p.method] ?? p.method, moneyText(p.amount), w) });
      if (p.change && p.change !== '0.00') L.push({ text: pad('  Kusur', moneyText(p.change), w) });
    }
    if (payload.fiscal?.invoiceNumber) { L.push({ text: sep }); L.push({ text: `Broj: ${payload.fiscal.invoiceNumber}` }); }
    if (payload.notFiscalNotice) { L.push({ text: sep }); L.push({ text: payload.notFiscalNotice, bold: true, center: true }); }
    return L;
  }
  if (kind === 'TEST_PAGE') {
    L.push({ text: 'PROBNA STRANA', big: true, bold: true, center: true });
    L.push({ text: `Štampač: ${payload.printer}` });
    L.push({ text: `Veza: ${payload.connection}, papir ${payload.paperWidth} mm (${w} znakova)` });
    L.push({ text: `Pokrenuo: ${payload.by ?? ''}` });
    L.push({ text: time(payload.createdAt) });
    L.push({ text: sep });
    L.push({ text: 'Srpska slova: Č č Ć ć Đ đ Š š Ž ž' });
    L.push({ text: 'Ako su slova pogrešna, promenite CODEPAGE.' });
    L.push({ text: '1234567890'.repeat(Math.ceil(w / 10)).slice(0, w) });
    return L;
  }
  return [{ text: `Nepoznata vrsta zadatka: ${kind}` }];
}

export function linesToText(lines: Line[], paperWidth: number) {
  const w = charsPerLine(paperWidth);
  return lines.map((l) => (l.center ? ' '.repeat(Math.max(0, Math.floor((w - l.text.length) / 2))) + l.text : l.text)).join('\n') + '\n';
}

const ESC = 0x1b, GS = 0x1d;

/** ESC/POS: inicijalizacija, kodna strana, redovi (podebljano/dupla veličina/centrirano), pomak i sečenje papira. */
export function linesToEscPos(lines: Line[], opts: { codepage: Codepage; codepageNumber?: number | null }): Buffer {
  const parts: Buffer[] = [Buffer.from([ESC, 0x40])];
  const n = opts.codepageNumber ?? DEFAULT_CODEPAGE_NUMBER[opts.codepage];
  if (n !== null && n !== undefined) parts.push(Buffer.from([ESC, 0x74, n]));
  for (const l of lines) {
    parts.push(Buffer.from([ESC, 0x61, l.center ? 1 : 0]));
    parts.push(Buffer.from([ESC, 0x45, l.bold ? 1 : 0]));
    parts.push(Buffer.from([GS, 0x21, l.big ? 0x11 : 0x00]));
    parts.push(encodeText(l.text, opts.codepage), Buffer.from([0x0a]));
  }
  parts.push(Buffer.from([ESC, 0x45, 0, GS, 0x21, 0, ESC, 0x61, 0]));
  parts.push(Buffer.from([GS, 0x56, 0x42, 0x03])); // pomak papira + delimično sečenje
  return Buffer.concat(parts);
}
