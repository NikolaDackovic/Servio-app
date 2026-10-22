import { useEffect, useRef, useState } from 'react';
import { api, ApiError, storage } from '@shared/api';

export interface Warehouse { id: string; name: string; isDefault: boolean; active: boolean }
export interface Partner { id: string; name: string; kind: 'SUPPLIER' | 'CUSTOMER' | 'BOTH'; taxId: string | null; registrationNo: string | null; address: string | null; city: string | null; email: string | null; phone: string | null; active: boolean }
export interface PickProduct { id: string; code: string; name: string; unit: string; trackStock: boolean; isSellable: boolean }

export const DOC_KIND_LABEL: Record<string, string> = {
  RECEIPT: 'Prijemnica', ISSUE: 'Izlaz robe', RETURN: 'Povrat dobavljaču', TRANSFER: 'Prenos', WRITE_OFF: 'Otpis', INTERNAL: 'Interna potrošnja', STOCKTAKE: 'Popis',
};
export const DOC_STATUS_LABEL: Record<string, string> = { DRAFT: 'Nacrt', POSTED: 'Proknjižen', CANCELLED: 'Storniran' };

/** Količina/cena za prikaz: 4 decimale → bez suvišnih nula, decimalni zarez. */
export const fq = (v: string | null | undefined) => {
  if (v === null || v === undefined) return '—';
  const neg = v.startsWith('-');
  const [i, d = ''] = v.replace('-', '').split('.');
  const dd = d.replace(/0+$/, '');
  return `${neg ? '−' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${dd ? `,${dd}` : ''}`;
};

/** Preuzimanje fajla sa API-ja (sa tokenom) — CSV/XLSX izvoz i šabloni. */
export async function download(path: string) {
  const res = await fetch(`/api/v1${path}`, { headers: { Authorization: `Bearer ${storage.token}` } });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new ApiError(res.status, e?.error?.code ?? 'HTTP_ERROR', e?.error?.message ?? `Greška ${res.status}`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'izvoz';
  saveBlob(await res.blob(), name);
}
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const fileToBase64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] ?? '');
  r.onerror = () => rej(new Error('Fajl ne može da se pročita'));
  r.readAsDataURL(f);
});

/** Izbor artikla pretragom (šifra ili naziv). */
export function ProductPicker({ onPick, filter = 'trackStock=true', placeholder = 'Dodaj artikal: šifra ili naziv…', exclude = [] }: {
  onPick: (p: PickProduct) => void; filter?: string; placeholder?: string; exclude?: string[];
}) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<PickProduct[]>([]);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!q.trim()) { setList([]); return; }
    const n = ++seq.current;
    const t = setTimeout(() => {
      api<{ data: PickProduct[] }>('GET', `/products?pageSize=20&${filter}&search=${encodeURIComponent(q.trim())}`)
        .then((r) => { if (n === seq.current) setList(r.data.filter((p) => !exclude.includes(p.id))); }).catch(() => undefined);
    }, 200);
    return () => clearTimeout(t);
  }, [q, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (p: PickProduct) => { onPick(p); setQ(''); setList([]); };
  return (
    <div className="picker">
      <input className="input" value={q} placeholder={placeholder} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); pick(list[0]); } }} />
      {open && list.length > 0 && (
        <ul className="picker-list">
          {list.map((p) => <li key={p.id}><button type="button" onMouseDown={(e) => { e.preventDefault(); pick(p); }}><code>{p.code}</code> {p.name} <span className="muted">({p.unit})</span></button></li>)}
        </ul>
      )}
      {open && q.trim() && list.length === 0 && <div className="picker-list empty muted small">Nema artikala{filter.includes('trackStock') ? ' sa vođenjem zalihe' : ''} za „{q}“.</div>}
    </div>
  );
}
