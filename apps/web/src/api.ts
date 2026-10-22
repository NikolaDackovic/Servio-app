/** Tanak klijent za POS API: token, standardizovane greške, idempotency ključevi. */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) {
    super(message);
  }
}

const TOKEN_KEY = 'pos.token';
const DEVICE_KEY = 'pos.deviceId';

export const storage = {
  get token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set token(v: string | null) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
  get deviceId() { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } },
  set deviceId(v: string | null) { try { v ? localStorage.setItem(DEVICE_KEY, v) : localStorage.removeItem(DEVICE_KEY); } catch { /* ignore */ } },
};

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = storage.token;
  if (t) headers.Authorization = `Bearer ${t}`;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Server nije dostupan. Proverite mrežu i da li je POS servis pokrenut.');
  }
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (!res.ok) {
    const e = data?.error ?? {};
    // Odgovor bez našeg formata greške = nije stigao od API-ja (npr. proxy ne može da dođe do servera).
    if (!data?.error && res.status >= 500) {
      throw new ApiError(res.status, 'API_UNREACHABLE',
        'POS API server nije dostupan. Proverite da li je pokrenut (npm run dev:api) i da li radi baza podataka.');
    }
    if (res.status === 401 && path !== '/auth/pin' && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? `Greška ${res.status}`, e.details, e.requestId);
  }
  return data as T;
}

/** Ključ se generiše JEDNOM po nameri (npr. po otvaranju dijaloga naplate) i ponavlja se pri retry-ju. */
export function newIdempotencyKey(prefix = 'ui'): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`;
}

export const fmt = (v: string | number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  const [i, d = '00'] = String(v).split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d.padEnd(2, '0').slice(0, 2)}`;
};
export const toCents = (v: string): bigint => {
  const neg = v.startsWith('-');
  const [i, d = ''] = v.replace('-', '').split('.');
  const c = BigInt(i || '0') * 100n + BigInt((d + '00').slice(0, 2));
  return neg ? -c : c;
};
export const fromCents = (c: bigint): string => {
  const neg = c < 0n; const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};
export const subMoney = (a: string, b: string) => fromCents(toCents(a) - toCents(b));
export const cmpMoney = (a: string, b: string) => { const d = toCents(a) - toCents(b); return d === 0n ? 0 : d > 0n ? 1 : -1; };

/** Sabiranje novčanih stringova u celim parama (bez float-a). */
export function addMoney(...vals: string[]): string {
  const cents = vals.reduce((acc, v) => {
    const [i, d = ''] = v.split('.');
    return acc + BigInt(i) * 100n + BigInt((d + '00').slice(0, 2));
  }, 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/** Menja količinu za ceo broj komada, računajući u hiljaditim delovima (bez float-a). */
const toMilli = (q: string) => {
  const [i, d = ''] = q.split('.');
  return BigInt(i) * 1000n + BigInt((d + '000').slice(0, 3));
};
export function stepQty(q: string, delta: number): string {
  const milli = toMilli(q) + BigInt(delta) * 1000n;
  return `${milli / 1000n}.${String(milli % 1000n).padStart(3, '0')}`;
}
/** Smanjenje za 1 bi dalo količinu ≤ 0 → dugme "−" se onemogućava. */
export const qtyAtMostOne = (q: string) => toMilli(q) <= 1000n;

export const fmtQty = (v: string) => {
  const n = String(v).replace(/\.?0+$/, '');
  return n.replace('.', ',');
};
export const time = (iso: string) => new Date(iso).toLocaleTimeString('sr-Latn-RS', { hour: '2-digit', minute: '2-digit' });

export interface Me {
  user: { userId: string; fullName: string; roleCode: string; permissions: string[]; deviceId: string | null; locationId: string };
  locations: { id: string; name: string }[];
  devices: { id: string; name: string; kind: string }[];
}
export interface Product { id: string; code: string; name: string; unit: string; price: string; color: string | null; categoryId: string; taxLabel: string; taxRate: string; active: boolean; taxRateId: string; barcode: string | null }
export interface Category { id: string; name: string; color: string | null; sortOrder: number; active: boolean }
export interface OrderItem { id: string; productId: string; name: string; unitPrice: string; quantity: string; lineTotal: string; note: string | null; status: 'NEW' | 'SENT' | 'VOIDED'; sendBatch: number | null; voidReason: string | null; taxLabel: string }
export interface Payment { id: string; method: string; amount: string; tendered: string | null; change: string; mode: string; createdAt: string }
export interface Order {
  id: string; number: number; status: 'OPEN' | 'PAID' | 'CANCELLED'; total: string; paidTotal: string; remaining: string;
  tableId: string | null; tableName: string | null; waiterName: string; version: number; openedAt: string; closedAt: string | null;
  items: OrderItem[]; payments: Payment[]; taxSummary: { label: string; rate: string; gross: string; tax: string; net: string }[];
}
export interface Table { id: string; name: string; area: string; seats: number; status: 'FREE' | 'OCCUPIED' | 'PARTIALLY_PAID'; openOrders: { id: string; number: number; total: string; paidTotal: string; openedAt: string; waiterName: string }[] }
