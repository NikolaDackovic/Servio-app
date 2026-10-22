import ExcelJS from 'exceljs';
import { Invalid } from '../../common/errors';

/** Čitanje i pisanje tabela (CSV i XLSX) za uvoz/izvoz. */

export type Cell = string;
export interface Table { headers: string[]; rows: { rowNumber: number; cells: Cell[] }[] }

/** CSV po RFC 4180; separator ";" ili "," (prepoznaje se iz zaglavlja); UTF-8 sa ili bez BOM-a. */
export function parseCsv(text: string): Table {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: string[][] = [];
  let row: string[] = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
    } else field += c;
  }
  if (q) throw Invalid('CSV_INVALID', 'CSV fajl nije ispravan: navodnik nije zatvoren');
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  const [headers = [], ...rest] = out;
  return {
    headers: headers.map((h) => h.trim()),
    rows: rest.map((cells, i) => ({ rowNumber: i + 2, cells: cells.map((c) => c.trim()) }))
      .filter((r) => r.cells.some((c) => c !== '')),
  };
}

export async function parseXlsx(buf: Buffer): Promise<Table> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw Invalid('XLSX_INVALID', 'XLSX fajl nije ispravan ili je oštećen'); }
  const ws = wb.worksheets[0];
  if (!ws) throw Invalid('XLSX_EMPTY', 'XLSX fajl nema nijedan list');
  const text = (v: ExcelJS.CellValue): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'da' : 'ne';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
      if ('result' in v) return text((v as any).result);
      if ('richText' in v) return (v as any).richText.map((t: any) => t.text).join('');
      if ('text' in v) return String((v as any).text);
    }
    return String(v);
  };
  const headers: string[] = [];
  const rows: Table['rows'] = [];
  const width = ws.columnCount;
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    const cells = Array.from({ length: width }, (_, i) => text(r.getCell(i + 1).value).trim());
    if (n === 1) headers.push(...cells);
    else if (cells.some((c) => c !== '')) rows.push({ rowNumber: n, cells });
  });
  return { headers, rows };
}

export async function readTable(fileName: string, base64: string): Promise<{ table: Table; format: 'csv' | 'xlsx' }> {
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw Invalid('FILE_EMPTY', 'Fajl je prazan');
  if (buf.length > 5 * 1024 * 1024) throw Invalid('FILE_TOO_LARGE', 'Fajl je veći od 5 MB');
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx')) return { table: await parseXlsx(buf), format: 'xlsx' };
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return { table: parseCsv(buf.toString('utf8')), format: 'csv' };
  throw Invalid('UNSUPPORTED_FORMAT', 'Podržani formati su CSV i XLSX');
}

/** Normalizacija naziva kolone: mala slova, bez dijakritika i razmaka. */
export const normHeader = (h: string) => h.toLowerCase()
  .replace(/[čć]/g, 'c').replace(/đ/g, 'dj').replace(/š/g, 's').replace(/ž/g, 'z')
  .replace(/[^a-z0-9]/g, '');

export interface ColumnDef { key: string; label: string; aliases: string[]; required: boolean }

export function mapColumns(headers: string[], defs: ColumnDef[]) {
  const idx: Record<string, number> = {};
  const norm = headers.map(normHeader);
  for (const d of defs) {
    const i = norm.findIndex((h) => [d.key, d.label, ...d.aliases].map(normHeader).includes(h));
    if (i >= 0) idx[d.key] = i;
  }
  const missing = defs.filter((d) => d.required && idx[d.key] === undefined).map((d) => d.label);
  const unknown = headers.filter((h, i) => h && !Object.values(idx).includes(i));
  return { idx, missing, unknown };
}

/** Broj iz ćelije: prihvata "1.234,56", "1234,56", "1234.56". */
export function parseNumber(s: string): string | null {
  const t = s.replace(/\s/g, '');
  if (t === '') return null;
  let n = t;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) n = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d+,\d+$/.test(t)) n = t.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(n) ? n : null;
}
export function parseBool(s: string): boolean | null {
  const t = normHeader(s);
  if (['da', 'yes', 'true', '1', 'x'].includes(t)) return true;
  if (['ne', 'no', 'false', '0', ''].includes(t)) return false;
  return null;
}

// ----- izvoz

export function toCsv(headers: string[], rows: (string | number | null)[][]): Buffer {
  const esc = (v: string | number | null) => {
    const s = v === null || v === undefined ? '' : typeof v === 'number' ? String(v).replace('.', ',') : v;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
  return Buffer.from('﻿' + body + '\r\n', 'utf8'); // BOM: Excel ispravno prikazuje č, ć, š…
}

export async function toXlsx(sheet: string, headers: string[], rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(headers).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((c, i) => { c.width = Math.min(50, Math.max(10, headers[i].length + 2, ...rows.map((r) => String(r[i] ?? '').length + 2))); });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
