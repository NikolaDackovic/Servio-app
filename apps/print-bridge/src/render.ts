/**
 * Pretvaranje sadržaja zadatka (nezavisnog od štampača) u redove teksta i u ESC/POS bajtove.
 * Isti redovi se koriste i za SIMULATED izlaz, pa se simulacija i papir ne razlikuju po sadržaju.
 */

export type Codepage = 'ascii' | 'cp852' | 'cp1250' | 'cp1251';

/**
 * Red isečka; `raster` je crno-bela slika (logo): širina u tačkama (deljiva sa 8), visina, bitovi base64;
 * `qr` je sadržaj QR koda (fiskalni račun) koji štampač sam iscrtava.
 */
export interface Line { text: string; bold?: boolean; big?: boolean; center?: boolean; raster?: { width: number; height: number; data: string }; qr?: string }

/** Srpska ćirilica → latinica (za štampače bez ćirilične kodne strane). */
const CYR_LAT: Record<string, string> = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Ђ: 'Đ', Е: 'E', Ж: 'Ž', З: 'Z', И: 'I', Ј: 'J', К: 'K', Л: 'L', Љ: 'Lj', М: 'M', Н: 'N', Њ: 'Nj', О: 'O', П: 'P',
  Р: 'R', С: 'S', Т: 'T', Ћ: 'Ć', У: 'U', Ф: 'F', Х: 'H', Ц: 'C', Ч: 'Č', Џ: 'Dž', Ш: 'Š',
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'đ', е: 'e', ж: 'ž', з: 'z', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', ћ: 'ć', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'č', џ: 'dž', ш: 'š',
};
/** Windows-1251: osnovna ćirilica А-я je 0xC0-0xFF, srpska slova posebno. */
const CP1251_SR: Record<string, number> = { Ђ: 0x80, ђ: 0x90, Ј: 0xa3, ј: 0xbc, Љ: 0x8a, љ: 0x9a, Њ: 0x8c, њ: 0x9c, Ћ: 0x8e, ћ: 0x9e, Џ: 0x8f, џ: 0x9f };
export const toLatin = (s: string) => [...s].map((ch) => CYR_LAT[ch] ?? ch).join('');

const TRANSLIT: Record<string, string> = {
  'Č': 'C', 'č': 'c', 'Ć': 'C', 'ć': 'c', 'Đ': 'Dj', 'đ': 'dj', 'Š': 'S', 'š': 's', 'Ž': 'Z', 'ž': 'z',
  '—': '-', '–': '-', '„': '"', '“': '"', '”': '"', '’': "'", '×': 'x',
};
const CP852: Record<string, number> = {
  'Č': 0xac, 'č': 0x9f, 'Ć': 0x8f, 'ć': 0x86, 'Đ': 0xd1, 'đ': 0xd0, 'Š': 0xe6, 'š': 0xe7, 'Ž': 0xa6, 'ž': 0xa7,
};
const CP1250: Record<string, number> = {
  'Č': 0xc8, 'č': 0xe8, 'Ć': 0xc6, 'ć': 0xe6, 'Đ': 0xd0, 'đ': 0xf0, 'Š': 0x8a, 'š': 0x9a, 'Ž': 0x8e, 'ž': 0x9e,
};
/** Podrazumevani brojevi kodnih strana za ESC t n (Epson). Drugi modeli mogu imati druge brojeve. */
export const DEFAULT_CODEPAGE_NUMBER: Record<Codepage, number | null> = { ascii: null, cp852: 18, cp1250: 45, cp1251: 46 };

export function encodeText(s: string, cp: Codepage): Buffer {
  const out: number[] = [];
  // Ćirilica ide u CP1251; ostale kodne strane dobijaju latinicu (bez upitnika na papiru).
  const text = cp === 'cp1251' ? s : toLatin(s);
  for (const ch of text) {
    if (cp === 'cp1251') {
      if (CP1251_SR[ch] !== undefined) { out.push(CP1251_SR[ch]); continue; }
      const c = ch.charCodeAt(0);
      if (c >= 0x410 && c <= 0x44f) { out.push(c - 0x410 + 0xc0); continue; }
    }
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

/** Levo i desno u istom redu; ako ne staje (npr. dug PFR broj računa) - desni deo ide u sledeći red, poravnat desno. */
function pad(left: string, right: string, width: number) {
  if (left && left.length + right.length + 1 > width) return `${left}\n${right.length >= width ? right : right.padStart(width)}`;
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
/** 04.03.2022 11:42:30 (vreme lokala), kao na fiskalnom računu. */
const time = (iso: string) => {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Belgrade', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
};
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
    L.push({ text: banner(kind === 'VOID_TICKET' ? 'STORNO PORUDŽBINE' : 'PORUDŽBINA', w), bold: true });
    L.push({ text: `${payload.title} - ${payload.station}`, bold: true, big: true, center: true });
    if (kind === 'VOID_TICKET') L.push({ text: '*** STORNO - NE PRIPREMATI ***', bold: true, center: true });
    const where = [payload.table ?? 'Brza prodaja', payload.tab ? `(${payload.tab})` : null].filter(Boolean).join(' ');
    L.push({ text: where, big: true, bold: true });
    L.push({ text: pad(`Račun #${payload.orderNumber}`, payload.batch ? `Tura ${payload.batch}` : '', w) });
    L.push({ text: pad(payload.waiter ?? '', time(payload.createdAt), w) });
    L.push({ text: sep });
    for (const l of payload.lines ?? []) {
      const first = `${qtyText(l.qty)} x ${l.name}`;
      // Veličina slova porudžbine: velika (podrazumevano) ili normalna (ADMIN → Izgled isečka)
      const large = payload.large !== false;
      wrap(first, large ? Math.floor(w / 2) : w).forEach((t) => L.push({ text: t, big: large, bold: true }));
      if (l.note) wrap(`  >> ${l.note}`, w).forEach((t) => L.push({ text: t, bold: true }));
    }
    if (payload.reason) { L.push({ text: sep }); wrap(`Razlog: ${payload.reason}`, w).forEach((t) => L.push({ text: t })); }
    L.push({ text: banner('KRAJ PORUDŽBINE', w) });
    return L;
  }
  if (kind === 'RECEIPT') return receiptLines(payload, w);
  if (kind === 'SHIFT_REPORT' && payload.mode === 'SALES') {
    const q = (s: string) => qtyText(s);
    L.push({ text: payload.location ?? '', bold: true, center: true });
    L.push({ text: payload.title, big: true, bold: true, center: true });
    L.push({ text: payload.waiter ?? '', bold: true });
    L.push({ text: pad('Štampano', time(payload.createdAt), w) });
    L.push({ text: '='.repeat(w) });
    L.push({ text: pad('UKUPNO PRODATO', `${q(payload.total.quantity)} kom`, w), bold: true });
    L.push({ text: pad('Iznos', moneyText(payload.total.amount), w), bold: true });
    for (const st of payload.stations ?? []) {
      L.push({ text: '='.repeat(w) });
      L.push({ text: pad(String(st.name).toUpperCase(), `${q(st.quantity)} kom`, w), bold: true, big: true });
      L.push({ text: sep });
      for (const it of st.items) for (const [i, t] of wrap(`${q(it.quantity)} x ${it.name}`, w - 12).entries()) L.push({ text: i ? `  ${t}` : pad(t, moneyText(it.gross), w) });
      L.push({ text: sep });
      L.push({ text: pad(`Ukupno ${st.name}`, moneyText(st.amount), w), bold: true });
    }
    if (!(payload.stations ?? []).length) L.push({ text: 'Nema prodaje u smeni.' });
    L.push({ text: '='.repeat(w) });
    return L;
  }
  if (kind === 'SHIFT_REPORT') {
    const names: Record<string, string> = { CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Virman', REPRESENTATION: 'Reprezentacija' };
    if (payload.notice) L.push({ text: payload.notice, bold: true, center: true });
    L.push({ text: payload.location ?? '', bold: true, center: true });
    L.push({ text: payload.title, big: true, bold: true, center: true });
    L.push({ text: payload.waiter ?? '', bold: true });
    L.push({ text: pad('Od', time(payload.startedAt), w) });
    L.push({ text: pad(payload.endedAt ? 'Do' : 'Štampano', time(payload.endedAt ?? payload.createdAt), w) });
    L.push({ text: sep });
    for (const m of payload.byMethod ?? []) L.push({ text: pad(`${names[m.method] ?? m.method} (${m.count})`, moneyText(m.amount), w) });
    if (!(payload.byMethod ?? []).length) L.push({ text: 'Nema naplata u smeni.' });
    L.push({ text: sep });
    L.push({ text: pad('UKUPNO NAPLAĆENO', moneyText(payload.total), w), bold: true });
    L.push({ text: pad('GOTOVINA ZA PREDAJU', moneyText(payload.cashToHandOver), w), bold: true, big: true });
    L.push({ text: sep });
    L.push({ text: pad(`Zatvoreni računi (${payload.receipts?.count ?? 0})`, moneyText(payload.receipts?.amount ?? '0.00'), w) });
    L.push({ text: pad(`Storna (${payload.voids?.count ?? 0})`, moneyText(payload.voids?.amount ?? '0.00'), w) });
    L.push({ text: pad('Otvoreni računi', String(payload.openOrders ?? 0), w) });
    if ((payload.byStation ?? []).length) {
      L.push({ text: sep });
      L.push({ text: 'Pazar po delu lokala:', bold: true });
      for (const st of payload.byStation) L.push({ text: pad(st.name, moneyText(st.amount), w) });
    }
    L.push({ text: sep });
    L.push({ text: 'Potpis: ______________________' });
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

/** "==== ТЕКСТ ====" preko cele širine. */
const banner = (text: string, w: number, ch = '=') => {
  const t = ` ${text} `;
  const left = Math.max(2, Math.floor((w - t.length) / 2));
  return (ch.repeat(left) + t).padEnd(w, ch).slice(0, Math.max(w, t.length + 4));
};
/** "------ ТЕКСТ ------" */
const rule = (text: string, w: number) => banner(text, w, '-');
const pct = (s: string) => `${Number(s).toFixed(2).replace('.', ',')}%`;

/**
 * Fiskalni račun u rasporedu Poreske uprave (kao na uzorku): zaglavlje sa PIB-om i prodajnim mestom,
 * kasir i ESIR, vrsta prometa, artikli (naziv sa oznakom, pa cena/količina/ukupno), načini plaćanja,
 * porezi po oznakama, PFR vreme/broj/brojač, QR kod, za refundaciju potpis kupca, kraj računa.
 * Natpisi su ćirilicom; štampač bez ćirilične kodne strane dobija latinicu (encodeText).
 */
/**
 * Reprezentacija kao kratak isečak (ADMIN → Podešavanje aplikacije → Podaci o računima): sto, konobar, vreme,
 * stavke i "Za naplatu" (posle popusta) - kao porudžbina, bez fiskalnih podataka.
 */
function repSlipLines(p: any, w: number): Line[] {
  const sep = '-'.repeat(w);
  const L: Line[] = [{ text: banner('REPREZENTACIJA', w), bold: true }];
  if (p.location) L.push({ text: p.location, center: true });
  L.push({ text: sep });
  if (p.table) L.push({ text: pad('Sto:', String(p.table), w), bold: true });
  L.push({ text: pad('Konobar:', p.waiter ?? '', w) });
  L.push({ text: pad('Vreme:', time(p.createdAt), w) });
  L.push({ text: pad('Račun:', `#${p.orderNumber}`, w) });
  L.push({ text: sep });
  for (const l of p.lines ?? []) {
    for (const [i, t] of wrap(`${qtyText(l.qty)}x ${l.name}`, w - 12).entries()) L.push({ text: i ? t : pad(t, moneyText(l.total), w) });
    if (l.discount && Number(l.discount) > 0) L.push({ text: pad('  popust', `-${moneyText(l.discount)}`, w) });
  }
  L.push({ text: sep });
  if (p.discount && Number(p.discount) > 0) L.push({ text: pad('Popust:', `-${moneyText(p.discount)}`, w) });
  L.push({ text: pad('Za naplatu =', `${moneyText(p.total)} RSD`, w), bold: true });
  const note = p.payments?.[0]?.note;
  if (note) L.push({ text: pad('Razlog:', note, w) });
  L.push({ text: '' });
  return L;
}

function receiptLines(p: any, w: number): Line[] {
  if (p.repStyle === 'SLIP') return repSlipLines(p, w);
  const L: Line[] = [];
  const f = p.fiscalLayout ?? {};
  const sep = '-'.repeat(w), dbl = '='.repeat(w);
  const isFiscal = !!f.isFiscal;
  const rep = !!f.representation; // reprezentacija: bez TEST/ОБУКА i bez fiskalnih podataka
  L.push({ text: banner(isFiscal ? 'ФИСКАЛНИ РАЧУН' : rep ? 'РЕПРЕЗЕНТАЦИЈА' : 'ОВО НИЈЕ ФИСКАЛНИ РАЧУН', w), bold: true });
  if (p.logo) L.push({ text: '', raster: p.logo });
  for (const t of [f.pib, f.company, f.store, f.address, f.city, ...(f.extra ?? [])]) if (t) wrap(String(t), w).forEach((x) => L.push({ text: x, center: true }));
  if (p.header) for (const t of String(p.header).split(/\r?\n/)) wrap(t, w).forEach((x) => L.push({ text: x, center: true }));
  L.push({ text: pad('Касир:', f.cashier ?? p.waiter ?? '', w) });
  if (f.buyerId) L.push({ text: pad('ИД купца:', f.buyerId, w) });
  L.push({ text: pad('ЕСИР број:', f.esir ?? '', w) });
  if (f.refNumber) {
    L.push({ text: pad('Реф. број:', f.refNumber, w) });
    if (f.refTime) L.push({ text: pad('Реф. време:', time(f.refTime), w) });
  }
  L.push({ text: rule(f.transaction ?? 'ПРОМЕТ ПРОДАЈА', w) });
  L.push({ text: 'Артикли' });
  L.push({ text: dbl });
  const cP = w >= 40 ? 13 : 10, cQ = w >= 40 ? 9 : 6, cT = w - cP - cQ;
  L.push({ text: `${'Назив'.padEnd(6)}${'Цена'.padStart(cP - 6)}${'Кол.'.padStart(cQ)}${'Укупно'.padStart(cT)}` });
  for (const l of p.lines ?? []) {
    wrap(`${l.name} (${l.taxLabel})`, w).forEach((t) => L.push({ text: t }));
    L.push({ text: `${moneyText(l.unitPrice).padStart(cP)}${qtyText(l.qty).padStart(cQ)}${moneyText(l.total).padStart(cT)}` });
    if (l.discount && l.discount !== '0.00') L.push({ text: pad('  Попуст:', `-${moneyText(l.discount)}`, w) });
  }
  L.push({ text: sep });
  L.push({ text: pad('Укупан износ:', moneyText(p.total), w), bold: true });
  const PAY: Record<string, string> = { CASH: 'Готовина:', CARD: 'Платна картица:', TRANSFER: 'Пренос на рачун:', REPRESENTATION: 'Друго безготовинско:' }; // reprezentacija (na kuću) = regularan račun po PU
  let change = 0;
  for (const pm of p.payments ?? []) {
    L.push({ text: pad(PAY[pm.method] ?? `${pm.method}:`, moneyText(pm.amount), w) });
    change += Number(pm.change ?? 0);
  }
  if (f.refund) L.push({ text: pad('Повраћај:', moneyText(p.total), w) });
  else if (change > 0) L.push({ text: pad('Повраћај:', moneyText(change.toFixed(2)), w) });
  L.push({ text: dbl });
  if (!isFiscal && !rep) L.push({ text: 'ОВО НИЈЕ ФИСКАЛНИ РАЧУН', bold: true, big: w >= 40, center: true });
  if ((f.taxes ?? []).length) {
    const c1 = Math.floor(w / 4);
    L.push({ text: `${'Ознака'.padEnd(c1)}${'Име'.padEnd(c1)}${'Стопа'.padStart(c1)}${'Порез'.padStart(w - 3 * c1)}` });
    for (const t of f.taxes) L.push({ text: `${String(t.label).padEnd(c1)}${String(t.name).padEnd(c1)}${pct(t.rate).padStart(c1)}${moneyText(t.tax).padStart(w - 3 * c1)}` });
    L.push({ text: sep });
    L.push({ text: pad('Укупан износ пореза:', moneyText(f.taxTotal ?? '0.00'), w) });
  }
  if (rep) {
    L.push({ text: dbl });
    L.push({ text: pad('Време:', time(p.createdAt), w) });
    L.push({ text: pad('Рачун:', `#${p.orderNumber}`, w) });
    if (p.footer) for (const t of String(p.footer).split(/\r?\n/)) wrap(t, w).forEach((x) => L.push({ text: x, center: true }));
    L.push({ text: banner('КРАЈ', w), bold: true });
    return L;
  }
  L.push({ text: dbl });
  L.push({ text: pad('ПФР време:', f.pfrTime ? time(f.pfrTime) : time(p.createdAt), w) });
  L.push({ text: pad('ПФР број рачуна:', f.pfrNumber ?? '-', w) });
  L.push({ text: pad('Бројач рачуна:', f.counter ?? '-', w) });
  L.push({ text: dbl });
  if (f.qr) L.push({ text: '', qr: f.qr });
  if (f.signature) { L.push({ text: '' }); L.push({ text: `Потпис купца: ${'_'.repeat(Math.max(8, w - 15))}` }); }
  if (p.footer) for (const t of String(p.footer).split(/\r?\n/)) wrap(t, w).forEach((x) => L.push({ text: x, center: true }));
  if (p.footerImage) L.push({ text: '', raster: p.footerImage });
  if (f.representationNote) wrap(f.representationNote, w).forEach((x) => L.push({ text: x, center: true, bold: true }));
  L.push({ text: banner('КРАЈ ФИСКАЛНОГ РАЧУНА', w), bold: true });
  return L;
}

export function linesToText(lines: Line[], paperWidth: number) {
  const w = charsPerLine(paperWidth);
  return lines.map((l) => (l.raster ? '[LOGO]' : l.qr ? `[QR: ${l.qr}]` : l.center ? ' '.repeat(Math.max(0, Math.floor((w - l.text.length) / 2))) + l.text : l.text)).join('\n') + '\n';
}

const ESC = 0x1b, GS = 0x1d;

/** ESC/POS: inicijalizacija, kodna strana, redovi (podebljano/dupla veličina/centrirano), pomak i sečenje papira. */
export function linesToEscPos(lines: Line[], opts: { codepage: Codepage; codepageNumber?: number | null }): Buffer {
  const parts: Buffer[] = [Buffer.from([ESC, 0x40])];
  const n = opts.codepageNumber ?? DEFAULT_CODEPAGE_NUMBER[opts.codepage];
  if (n !== null && n !== undefined) parts.push(Buffer.from([ESC, 0x74, n]));
  for (const l of lines) {
    if (l.qr) {
      // GS ( k: QR kod (model 2, veličina modula 5, korekcija M), centriran
      const data = Buffer.from(l.qr, 'utf8');
      const len = data.length + 3;
      parts.push(Buffer.from([ESC, 0x61, 1,
        GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0,
        GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, 5,
        GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31,
        GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30]));
      parts.push(data, Buffer.from([GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30, 0x0a]));
      continue;
    }
    if (l.raster) {
      // GS v 0: rasterska slika (logo), centrirana
      const bytesPerRow = Math.ceil(l.raster.width / 8);
      parts.push(Buffer.from([ESC, 0x61, 1, GS, 0x76, 0x30, 0, bytesPerRow & 0xff, bytesPerRow >> 8, l.raster.height & 0xff, l.raster.height >> 8]));
      parts.push(Buffer.from(l.raster.data, 'base64'), Buffer.from([0x0a]));
      continue;
    }
    parts.push(Buffer.from([ESC, 0x61, l.center ? 1 : 0]));
    parts.push(Buffer.from([ESC, 0x45, l.bold ? 1 : 0]));
    parts.push(Buffer.from([GS, 0x21, l.big ? 0x11 : 0x00]));
    parts.push(encodeText(l.text, opts.codepage), Buffer.from([0x0a]));
  }
  parts.push(Buffer.from([ESC, 0x45, 0, GS, 0x21, 0, ESC, 0x61, 0]));
  parts.push(Buffer.from([GS, 0x56, 0x42, 0x03])); // pomak papira + delimično sečenje
  return Buffer.concat(parts);
}
