/** Tanak klijent za POS API: token, standardizovane greške, idempotency ključevi. */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) {
    super(message);
  }
}

/** Ekran kuhinje/šanka na adresi /kds: sopstvena prijava i uređaj (kasa i KDS mogu biti otvoreni u istom pregledaču). */
export const KDS_MODE = typeof location !== 'undefined' && /^\/kds(\/|$)/.test(location.pathname);
/** ADMIN na adresi /admin (npr. poseban prozor na kasi): sopstvena prijava - promena konobara na kasi ne dira ADMIN. */
const ADMIN_APP = typeof location !== 'undefined' && /^\/admin(\/|$)/.test(location.pathname);
const TOKEN_KEY = KDS_MODE ? 'pos.kds.token' : ADMIN_APP ? 'pos.admin.token' : 'pos.token';
const DEVICE_KEY = KDS_MODE ? 'pos.kds.deviceId' : 'pos.deviceId';

/** ADMIN pamti prijavu samo dok je prozor otvoren (svako otvaranje ADMIN-a traži šifru); kasa i KDS ostaju prijavljeni. */
const tokenStore = (): Storage => (ADMIN_APP ? sessionStorage : localStorage);
try { if (ADMIN_APP) localStorage.removeItem(TOKEN_KEY); } catch { /* stara trajna prijava ADMIN-a se briše */ }

export const storage = {
  get token() { try { return tokenStore().getItem(TOKEN_KEY); } catch { return null; } },
  set token(v: string | null) { try { v ? tokenStore().setItem(TOKEN_KEY, v) : tokenStore().removeItem(TOKEN_KEY); } catch { /* ignore */ } },
  get deviceId() { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } },
  set deviceId(v: string | null) { try { v ? localStorage.setItem(DEVICE_KEY, v) : localStorage.removeItem(DEVICE_KEY); } catch { /* ignore */ } },
};

// Dodatni računar (desktop program kase) otvara kasu sa ?device=<id>: ta kasa je ovaj računar.
try {
  const d = new URLSearchParams(location.search).get('device');
  if (d && /^[0-9a-f-]{36}$/i.test(d)) { storage.deviceId = d; history.replaceState(null, '', location.pathname); }
} catch { /* van pregledača (testovi) */ }

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

/**
 * Poziv API-ja. `token` (opciono) koristi drugi nalog samo za ovaj poziv - npr. pregled računa
 * uz PIN drugog konobara, bez odjave prijavljenog korisnika.
 */
export async function api<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = token ?? storage.token;
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
    if (res.status === 401 && !token && path !== '/auth/pin' && path !== '/auth/login') onUnauthorized();
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
  if (v === null || v === undefined) return '-';
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
export interface Product { id: string; code: string; name: string; unit: string; price: string; color: string | null; categoryId: string; taxLabel: string; taxRate: string; active: boolean; taxRateId: string; barcode: string | null; imageAt?: string | null; noteOptions?: string[] }
/** Adresa slike artikla (javna, keširana po verziji). */
export const productImageUrl = (p: { id: string; imageAt?: string | null }) => (p.imageAt ? `/api/v1/products/${p.id}/image?v=${encodeURIComponent(p.imageAt)}` : null);
export interface Category { id: string; name: string; color: string | null; sortOrder: number; active: boolean }
export interface OrderItem { id: string; productId: string; name: string; unitPrice: string; quantity: string; lineTotal: string; discountAmount: string; note: string | null; status: 'NEW' | 'SENT' | 'VOIDED'; sendBatch: number | null; voidReason: string | null; taxLabel: string;
  prepStationId?: string | null; prepStationName?: string | null; prepStatus?: 'NEW' | 'IN_PROGRESS' | 'READY' | 'DONE' | null }
export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'REPRESENTATION';
export const METHOD_LABEL: Record<string, string> = { CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Virman', REPRESENTATION: 'Reprezentacija' };
export interface Payment { id: string; method: string; amount: string; tendered: string | null; change: string; mode: string; createdAt: string; note?: string | null }
export interface Order {
  id: string; number: number; status: 'OPEN' | 'PAID' | 'CANCELLED' | 'MERGED'; total: string; paidTotal: string; remaining: string;
  subtotal: string; discountTotal: string; discountPercent: string; discountId: string | null; tabName: string | null; waiterId: string;
  buyerIdType: string | null; buyerId: string | null; buyerIdLabel: string | null; buyerOptionalBasis: string | null; buyerOptionalValue: string | null;
  tableId: string | null; tableName: string | null; waiterName: string; version: number; openedAt: string; closedAt: string | null;
  fiscal: Fiscal | null;
  items: OrderItem[]; payments: Payment[]; taxSummary: { label: string; rate: string; gross: string; tax: string; net: string }[];
}
export interface Table { id: string; name: string; area: string; seats: number; posX: number; posY: number; width: number; height: number; shape: 'RECT' | 'ROUND'; color?: string | null; isRoom?: boolean; status: 'FREE' | 'OCCUPIED' | 'PARTIALLY_PAID'; openOrders: { id: string; number: number; total: string; paidTotal: string; openedAt: string; waiterName: string; waiterId: string; tabName: string | null }[] }

export interface Discount { id: string; name: string; percent: string; active: boolean; sortOrder: number; scope?: 'ALL' | 'GROUP' | 'PRODUCT'; targetIds?: string[] }

/** Stanje fiskalizacije računa. Račun je fiskalizovan SAMO ako je status SIGNED i isTest = false. */
export interface Fiscal {
  id: string; provider: string; isTest: boolean; invoiceType: string; status: 'PENDING' | 'SIGNED' | 'FAILED' | 'NOT_REQUIRED';
  invoiceNumber: string | null; verificationUrl: string | null; attempts: number; lastError: string | null; signedAt: string | null;
}

/** Kratak, istinit opis stanja fiskalizacije (bez tvrdnje da je račun fiskalni kada nije). */
export function fiscalText(f: Fiscal | null | undefined): { cls: string; text: string } {
  if (!f) return { cls: 'none', text: 'Nije fiskalizovano - fiskalizacija nije uključena.' };
  if (f.status === 'SIGNED' && f.isTest) return { cls: 'signed-test', text: `TEST fiskalizacija: ${f.invoiceNumber} - ovo NIJE fiskalni račun.` };
  if (f.status === 'SIGNED') return { cls: 'signed', text: `Fiskalizovano: ${f.invoiceNumber}` };
  if (f.status === 'PENDING') return { cls: 'pending', text: `Fiskalizacija na čekanju (pokušaja: ${f.attempts})${f.lastError ? ` - ${f.lastError}` : ''}. Račun još NIJE fiskalizovan.` };
  if (f.status === 'FAILED') return { cls: 'failed', text: `Fiskalizacija NIJE uspela: ${f.lastError ?? 'nepoznata greška'}. Potrebna je ručna provera (ADMIN → Fiskalizacija).` };
  return { cls: 'none', text: 'Fiskalizacija nije potrebna.' };
}
