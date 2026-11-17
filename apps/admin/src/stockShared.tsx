import { useEffect, useRef, useState } from 'react';
import { api, ApiError, storage } from '@shared/api';

export interface Warehouse { id: string; name: string; isDefault: boolean; active: boolean }
export interface Partner { id: string; name: string; kind: 'SUPPLIER' | 'CUSTOMER' | 'BOTH'; taxId: string | null; registrationNo: string | null; address: string | null; city: string | null; email: string | null; phone: string | null; active: boolean }
export interface PickProduct { id: string; code: string; name: string; unit: string; trackStock: boolean; isSellable: boolean; taxRate?: string; taxRateId?: string; purchaseTaxRateId?: string | null }

export const DOC_KIND_LABEL: Record<string, string> = {
  RECEIPT: 'Ulazna faktura (UF)', RECEIPT_NOTE: 'Ulazna otpremnica (UO)', ISSUE: 'Izlazna faktura (IF)', RETURN: 'Povrat dobavljaču', TRANSFER: 'Prenos', WRITE_OFF: 'Otpis', INTERNAL: 'Interna potrošnja', STOCKTAKE: 'Popis (PO)',
};
export const DOC_STATUS_LABEL: Record<string, string> = { DRAFT: 'Nacrt', POSTED: 'Proknjižen', CANCELLED: 'Storniran' };

/** Količina/cena za prikaz: 4 decimale → bez suvišnih nula, decimalni zarez. */
export const fq = (v: string | null | undefined) => {
  if (v === null || v === undefined) return '-';
  const neg = v.startsWith('-');
  const [i, d = ''] = v.replace('-', '').split('.');
  const dd = d.replace(/0+$/, '');
  return `${neg ? '−' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${dd ? `,${dd}` : ''}`;
};

/** Preuzimanje fajla sa API-ja (sa tokenom) - CSV/XLSX izvoz i šabloni. */
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
export function ProductPicker({ onPick, filter = 'trackStock=true', placeholder = 'Dodaj artikal: šifra, barkod ili naziv… (Enter)', exclude = [], autoFocus, onCreate }: {
  onPick: (p: PickProduct) => void; filter?: string; placeholder?: string; exclude?: string[];
  autoFocus?: boolean;
  /** "Napravi novi artikal" kada pretraga ništa ne nađe (naziv iz pretrage) */
  onCreate?: (name: string) => void;
}) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<PickProduct[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [searched, setSearched] = useState('');
  const seq = useRef(0);
  const search = (term: string) => {
    const n = ++seq.current;
    return api<{ data: PickProduct[] }>('GET', `/products?pageSize=20&${filter}&search=${encodeURIComponent(term)}`)
      .then((r) => {
        if (n !== seq.current) return null;
        // tačna šifra ili barkod ide prva (čitač barkoda)
        const l = r.data.filter((p) => !exclude.includes(p.id))
          .sort((a, b) => Number(b.code === term || (b as any).barcode === term) - Number(a.code === term || (a as any).barcode === term));
        setList(l); setHi(0); setSearched(term); return l;
      }).catch(() => null);
  };
  useEffect(() => {
    if (!q.trim()) { setList([]); setSearched(''); return; }
    const t = setTimeout(() => void search(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (p: PickProduct) => { onPick(p); setQ(''); setList([]); setSearched(''); };
  const onKey = async (e: { key: string; preventDefault: () => void }) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Escape') { setQ(''); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const term = q.trim(); if (!term) return;
      // Enter pre nego što stigne rezultat (brzo kucanje / barkod): traži odmah
      const l = searched === term ? list : await search(term);
      if (l?.[hi] ?? l?.[0]) pick((l[hi] ?? l[0])!);
      else if (l && onCreate) { onCreate(term); setQ(''); } // nema ga - Enter pravi novi artikal
    }
  };
  return (
    <div className="picker">
      <input className="input" value={q} placeholder={placeholder} autoFocus={autoFocus} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => void onKey(e)} />
      {open && list.length > 0 && (
        <ul className="picker-list">
          {list.map((p, i) => <li key={p.id}><button type="button" className={i === hi ? 'hi' : ''} onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}><code>{p.code}</code> {p.name} <span className="muted">({p.unit})</span></button></li>)}
        </ul>
      )}
      {open && q.trim() && searched === q.trim() && list.length === 0 && (
        <div className="picker-list empty muted small">
          Nema artikala{filter.includes('trackStock') ? ' sa vođenjem zalihe' : ''} za „{q}“.
          {onCreate && <> <button type="button" className="btn sm primary" onMouseDown={(e) => e.preventDefault()} onClick={() => { onCreate(q.trim()); setQ(''); }}>+ Napravi novi artikal „{q.trim()}“</button></>}
        </div>
      )}
    </div>
  );
}
