import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, fmt } from '@shared/api';
import { useAuth } from '@shared/auth';
import { ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { ProductForm, TaxRate } from '@shared/pages/Products';
import { DOC_STATUS_LABEL, Partner, PickProduct, ProductPicker, saveBlob, Warehouse } from './stockShared';
import { ImportPanel } from './ImportExport';
import { Calculator, CalcResult, num } from './Calculator';
import { useTab } from './tabs';
import { GroupTree } from './GroupTree';

/** Vrste dokumenata: naziv ekrana (kao u Octopos-u), kratka oznaka i šta dokument traži. */
export const DOC_KINDS: Record<string, { title: string; short: string; partner?: 'Dobavljač' | 'Kupac'; partnerRequired?: boolean; price?: boolean }> = {
  RECEIPT: { title: 'Ulazna faktura', short: 'UF', partner: 'Dobavljač', partnerRequired: true, price: true },
  RECEIPT_NOTE: { title: 'Ulazna otpremnica', short: 'UO', partner: 'Dobavljač', partnerRequired: true, price: true },
  ISSUE: { title: 'Izlazna faktura', short: 'IF', partner: 'Kupac' },
  RETURN: { title: 'Povrat dobavljaču', short: 'POV', partner: 'Dobavljač', partnerRequired: true },
  TRANSFER: { title: 'Prenos između magacina', short: 'MP' },
  WRITE_OFF: { title: 'Otpis', short: 'OTP' },
  INTERNAL: { title: 'Interna potrošnja', short: 'IP' },
  STOCKTAKE: { title: 'Popis', short: 'PO' },
  CORRECTION: { title: 'Korekcija zalihe', short: 'KOR' },
};

interface Line { productId: string; code: string; name: string; unit: string; quantity: string; unitCost: string | null; discountPercent: string | null; bookQuantity?: string | null; value?: string | null }
export interface Doc {
  id: string; kind: string; kindLabel: string; status: 'DRAFT' | 'POSTED' | 'CANCELLED'; displayNumber: string | null; version: number;
  warehouseId: string; warehouseName: string; targetWarehouseId: string | null; targetWarehouseName: string | null;
  partnerId: string | null; partnerName: string | null; docDate: string; dueDate: string | null; externalNumber: string | null; note: string | null; internalNote: string | null;
  createdByName: string; postedAt: string | null; cancelledAt: string | null; cancelReason: string | null; lines: Line[]; total: string;
}
interface Prod { id: string; code: string; name: string; unit: string; categoryId: string; active: boolean; price: string; taxRateId: string; purchaseTaxRateId: string | null; trackStock: boolean }
type Mode = 'un' | 'ug' | 'tn' | 'tg';
const MODES: [Mode, string][] = [['un', 'Jed. bez PDV'], ['ug', 'Jed. sa PDV'], ['tn', 'Uk. bez PDV'], ['tg', 'Uk. sa PDV']];

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date());
const s2 = (v: number) => v.toLocaleString('sr-Latn-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const s4 = (v: number) => v.toLocaleString('sr-Latn-RS', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const pref = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(`admin.doc.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } };
const setPref = (k: string, v: unknown) => { try { localStorage.setItem(`admin.doc.${k}`, JSON.stringify(v)); } catch { /* samo za ovu posetu */ } };

/** Tab dokumenta: "Sačuvaj i novi" otvara prazan dokument iste vrste u istom tabu. */
export function DocTab({ kind, id }: { kind?: string; id?: string }) {
  const [state, setState] = useState<{ id?: string; k: number }>({ id, k: 0 });
  return <DocScreen key={state.k} kind={kind} id={state.id} onNew={() => setState((s) => ({ id: undefined, k: s.k + 1 }))} />;
}

/**
 * Robni dokument - isti ekran za sve vrste (UF, UO, IF, povrat, prenos, otpis, interna potrošnja, popis, korekcija):
 * zaglavlje (magacin, partner, broj, datumi, napomene), desno zbirovi; stavke u tabeli (šifra, naziv, poslednja nabavna,
 * trenutno stanje, količina, cena, rabat, PDV, iznos); artikal se kuca šifrom, barkodom ili nazivom i otvara kalkulator.
 * "Sačuvaj" knjiži dokument (utiče na zalihe), "Sačuvaj nacrt" čuva bez knjiženja.
 */
function DocScreen({ kind: kind0, id: id0, onNew }: { kind?: string; id?: string; onNew: () => void }) {
  const toast = useToast();
  const tab = useTab();
  const { can } = useAuth();
  const [id, setId] = useState(id0);
  const [doc, setDoc] = useState<Doc | null>(null);
  const loaded = useLoad(() => (id0 ? api<Doc>('GET', `/stock/documents/${id0}`) : Promise.resolve(null)), [id0]);
  const kind = doc?.kind ?? loaded.data?.kind ?? kind0 ?? 'RECEIPT';
  const K = DOC_KINDS[kind] ?? DOC_KINDS.RECEIPT;
  const whs = useLoad(() => api<Warehouse[]>('GET', '/warehouses'), []);
  const partners = useLoad(() => (K.partner ? api<Partner[]>('GET', '/partners') : Promise.resolve([] as Partner[])), [K.partner]);
  const taxes = useLoad(() => api<TaxRate[]>('GET', '/tax-rates'), []);
  const prods = useLoad(() => api<{ data: Prod[] }>('GET', '/products?pageSize=5000&includeInactive=true').then((r) => new Map(r.data.map((p) => [p.id, p]))), []);

  const [h, setH] = useState({ warehouseId: '', targetWarehouseId: '', partnerId: '', docDate: today(), dueDate: '', externalNumber: '', note: '', internalNote: '' });
  const [lines, setLines] = useState<Line[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [mode, setModeRaw] = useState<Mode>(() => pref('mode', 'un'));
  const [auto, setAutoRaw] = useState<boolean>(() => pref('calc', true));
  const setMode = (m: Mode) => { setModeRaw(m); setPref('mode', m); };
  const setAuto = (v: boolean) => { setAutoRaw(v); setPref('calc', v); };
  const [last, setLast] = useState<Record<string, number | null>>({});
  const [calc, setCalc] = useState<{ p: { id: string; code: string; name: string; unit: string }; index: number | null } | null>(null);
  const [dialog, setDialog] = useState<null | 'cancel' | 'partner' | 'import' | 'prep'>(null);
  const [printList, setPrintList] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const apply = (d: Doc) => {
    setDoc(d); setId(d.id);
    setH({ warehouseId: d.warehouseId, targetWarehouseId: d.targetWarehouseId ?? '', partnerId: d.partnerId ?? '', docDate: d.docDate, dueDate: d.dueDate ?? '', externalNumber: d.externalNumber ?? '', note: d.note ?? '', internalNote: d.internalNote ?? '' });
    setLines(d.lines.map((l) => ({ ...l, discountPercent: l.discountPercent ?? null })));
    setDirty(false);
    tab.retitle(`${DOC_KINDS[d.kind]?.short ?? ''} ${d.displayNumber ? d.displayNumber.replace(/^[A-Z]+-/, '') : '(nacrt)'}`, `docid:${d.id}`);
  };
  useEffect(() => { if (loaded.data) apply(loaded.data); }, [loaded.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!id0 && kind0) tab.retitle(DOC_KINDS[kind0]?.title ?? kind0, `doc:${kind0}`); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!id0 && whs.data && !h.warehouseId) setH((x) => ({ ...x, warehouseId: whs.data!.find((w) => w.isDefault)?.id ?? whs.data![0]?.id ?? '' }));
  }, [whs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // poslednja nabavna cena za stavke učitanog dokumenta
  useEffect(() => {
    if (!K.price) return;
    const missing = lines.map((l) => l.productId).filter((p) => !(p in last));
    if (!missing.length) return;
    void Promise.all(missing.map((p) => api<{ unitCost: string } | null>('GET', `/products/${p}/last-cost`).then((r) => [p, r ? Number(r.unitCost) : null] as const).catch(() => [p, null] as const)))
      .then((pairs) => setLast((x) => ({ ...x, ...Object.fromEntries(pairs) })));
  }, [lines.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const bal = useLoad(() => (h.warehouseId ? api<{ data: { productId: string; quantity: string; avgCost: string }[] }>('GET', `/stock/balances?nonZero=false&warehouseId=${h.warehouseId}`)
    .then((r) => new Map(r.data.map((x) => [x.productId, x]))) : Promise.resolve(new Map())), [h.warehouseId]);

  const draft = !doc || doc.status === 'DRAFT';
  const posted = doc?.status === 'POSTED';
  const isStocktake = kind === 'STOCKTAKE', isCorr = kind === 'CORRECTION';
  const rate = (pid: string) => { const p = prods.data?.get(pid); return Number(taxes.data?.find((t) => t.id === (p?.purchaseTaxRateId ?? p?.taxRateId))?.rate ?? 0); };
  // popis za raniji dan: očekivano = stanje na kraju tog dana (kao što ga knjiži server)
  const nextDay = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
  const past = isStocktake && !!h.docDate && h.docDate < today();
  const asOf = useLoad(() => (past && h.warehouseId ? api<{ productId: string; quantity: string }[]>('GET', `/stock/as-of?date=${nextDay(h.docDate)}&warehouseId=${h.warehouseId}`).then((r) => new Map(r.map((x) => [x.productId, Number(x.quantity)]))) : Promise.resolve(null)), [past, h.docDate, h.warehouseId]);
  const stock = (pid: string) => (past && asOf.data ? asOf.data.get(pid) ?? 0 : bal.data?.get(pid) ? Number(bal.data.get(pid)!.quantity) : 0);
  const avg = (pid: string) => (bal.data?.get(pid) ? Number(bal.data.get(pid)!.avgCost) : 0);
  const upd = (i: number, patch: Partial<Line>) => { setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l))); setDirty(true); };
  const before = (l: Line) => { const r = num(l.discountPercent); return r < 100 ? num(l.unitCost) / (1 - r / 100) : 0; };

  const totals = useMemo(() => {
    let gross0 = 0, net = 0, vat = 0;
    for (const l of lines) {
      const q = num(l.quantity);
      const v = l.value !== undefined && l.value !== null && !draft ? Number(l.value) : q * num(l.unitCost);
      gross0 += q * before(l); net += v; vat += (v * rate(l.productId)) / 100;
    }
    return { before: gross0, rabat: gross0 - net, net, vat, gross: net + vat };
  }, [lines, prods.data, taxes.data, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusPicker = () => setTimeout(() => box.current?.querySelector<HTMLInputElement>('.doc-pick .picker input')?.focus(), 40);
  // novi red za unos je uvek vidljiv (dno tabele)
  useEffect(() => { const g = box.current?.querySelector('.doc-grid'); if (g) g.scrollTop = g.scrollHeight; }, [lines.length]);
  const add = async (p: PickProduct) => {
    const i = lines.findIndex((l) => l.productId === p.id);
    if (i >= 0) {
      if (isStocktake) setTimeout(() => box.current?.querySelector<HTMLInputElement>(`[data-r="${i}"][data-c="q"]`)?.focus(), 60); else setCalc({ p, index: i });
      return;
    }
    // artikal bez vođenja zalihe: dokument ga uključuje sam
    if (p.trackStock === false) {
      try { await api('PATCH', `/products/${p.id}`, { trackStock: true }); toast('ok', `${p.name}: uključeno vođenje zalihe`); } catch (e: any) { toast('err', e.message); return; }
    }
    if (K.price && !(p.id in last)) {
      const lc = await api<{ unitCost: string } | null>('GET', `/products/${p.id}/last-cost`).catch(() => null);
      setLast((x) => ({ ...x, [p.id]: lc ? Number(lc.unitCost) : null }));
    }
    if (auto && !isStocktake) { setCalc({ p, index: null }); return; }
    const lc = K.price ? last[p.id] ?? null : null;
    setLines((ls) => [...ls, { productId: p.id, code: p.code, name: p.name, unit: p.unit, quantity: isStocktake ? '' : '1', unitCost: lc !== null ? String(lc) : null, discountPercent: null }]);
    setDirty(true);
    setTimeout(() => box.current?.querySelector<HTMLInputElement>(`[data-r="${lines.length}"][data-c="q"]`)?.select(), 60);
  };
  const calcSave = async (r: CalcResult) => {
    if (!calc) return;
    const patch = { quantity: String(r.quantity), unitCost: r.unitCost !== null ? String(r.unitCost) : null, discountPercent: r.discountPercent ? String(r.discountPercent) : null };
    if (calc.index !== null) upd(calc.index, K.price ? patch : { quantity: patch.quantity });
    else { setLines((ls) => [...ls, { productId: calc.p.id, code: calc.p.code, name: calc.p.name, unit: calc.p.unit, ...patch }]); setDirty(true); }
    if (r.salePrice !== null) {
      try { await api('PATCH', `/products/${calc.p.id}`, { price: r.salePrice.toFixed(2) }); const pr = prods.data?.get(calc.p.id); if (pr) pr.price = r.salePrice.toFixed(2); toast('ok', `Nova prodajna cena: ${calc.p.name} ${fmt(r.salePrice.toFixed(2))}`); }
      catch (e: any) { toast('err', e.message); }
    }
    setCalc(null); focusPicker();
  };

  // ---- čuvanje
  const header = () => ({
    warehouseId: h.warehouseId, ...(kind === 'TRANSFER' ? { targetWarehouseId: h.targetWarehouseId || null } : {}),
    partnerId: K.partner ? h.partnerId || null : null, docDate: h.docDate || today(), dueDate: h.dueDate || null,
    externalNumber: h.externalNumber.trim() || null, note: h.note.trim() || null, internalNote: h.internalNote.trim() || null,
  });
  const persist = async (ls: Line[] = lines): Promise<Doc> => {
    let d: Doc;
    if (!id) d = await api<Doc>('POST', '/stock/documents', { kind, ...header() });
    else d = await api<Doc>('PATCH', `/stock/documents/${id}`, { ...header(), expectedVersion: doc!.version });
    setId(d.id);
    d = await api<Doc>('PUT', `/stock/documents/${d.id}/lines`, {
      expectedVersion: d.version,
      lines: ls.map((l) => ({ productId: l.productId, quantity: String(+num(l.quantity).toFixed(4)), unitCost: l.unitCost !== null && l.unitCost !== '' ? String(+num(l.unitCost).toFixed(4)) : null, discountPercent: num(l.discountPercent) ? String(+num(l.discountPercent).toFixed(2)) : null })),
    });
    apply(d); // nacrt je sačuvan i ako knjiženje posle ne uspe
    return d;
  };
  const run = async (fn: () => Promise<Doc | void>, msg: string) => {
    setBusy(true); setError(undefined);
    try { const d = await fn(); if (d) apply(d); toast('ok', msg); return true; }
    catch (e) { setError(e); if ((e as ApiError).code === 'STALE_DOCUMENT' && id) apply(await api<Doc>('GET', `/stock/documents/${id}`)); return false; }
    finally { setBusy(false); }
  };
  /** Popis: artikli bez upisanog "Izmereno" ne ulaze u popis (pita se pre čuvanja). */
  const ready = (): Line[] | null => {
    const open = isStocktake ? lines.filter((l) => l.quantity === '') : [];
    if (!open.length) return lines;
    if (!window.confirm(`${open.length} artikala nema upisano „Izmereno“ (npr. ${open.slice(0, 3).map((l) => l.name).join(', ')}). Ukloniti ih iz popisa i nastaviti?`)) return null;
    const rest = lines.filter((l) => l.quantity !== ''); setLines(rest); return rest;
  };
  const saveDraft = () => { const ls = ready(); return ls && run(() => persist(ls), 'Nacrt sačuvan (zalihe nisu promenjene)'); };
  const post = async (andNew: boolean) => {
    const ls = ready(); if (!ls) return;
    const ok = await run(async () => { const d = await persist(ls); return api<Doc>('POST', `/stock/documents/${d.id}/post`, { expectedVersion: d.version }); }, `${K.title} je sačuvana i proknjižena`);
    if (ok && andNew) onNew();
  };
  const exportCsv = () => {
    const rows = [['Šifra', 'Naziv', 'JM', 'Količina', 'Jed. cena bez PDV', 'Rabat %', 'PDV %', 'Iznos bez PDV'],
      ...lines.map((l) => [l.code, l.name, l.unit, s4(num(l.quantity)), s4(num(l.unitCost)), s2(num(l.discountPercent)), s2(rate(l.productId)), s2(num(l.quantity) * num(l.unitCost))])];
    saveBlob(new Blob([`﻿${rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' }), `${doc?.displayNumber ?? K.short}.csv`);
  };
  const prepare = (groups: string[]) => {
    const have = new Set(lines.map((l) => l.productId));
    const add = [...(prods.data?.values() ?? [])].filter((p) => p.trackStock && p.active && !have.has(p.id) && (!groups.length || groups.includes(p.categoryId)))
      .sort((a, b) => a.name.localeCompare(b.name, 'sr'))
      .map((p) => ({ productId: p.id, code: p.code, name: p.name, unit: p.unit, quantity: '', unitCost: null, discountPercent: null } as Line));
    setLines([...lines, ...add]); setDirty(true); setDialog(null);
    toast('ok', add.length ? `U popis je upisano ${add.length} artikala - upišite izmereno` : 'Svi artikli iz izabranih grupa su već u popisu');
  };
  const close = () => { if (!dirty || window.confirm('Izmene nisu sačuvane. Zatvoriti dokument?')) tab.close(); };

  if (loaded.error) return <div className="page"><ErrorBox error={loaded.error} onRetry={loaded.reload} /></div>;
  if ((id0 && !doc) || !whs.data || !taxes.data || !prods.data) return <Spinner />;
  const activeWh = whs.data.filter((w) => w.active || w.id === h.warehouseId);
  const qtyOk = (l: Line) => (isCorr ? num(l.quantity) !== 0 : isStocktake ? l.quantity === '' || num(l.quantity) >= 0 : num(l.quantity) > 0);
  const uncounted = isStocktake ? lines.filter((l) => l.quantity === '').length : 0;
  const invalid = lines.some((l) => !qtyOk(l) || (K.price && !(num(l.unitCost) > 0)));
  const ro = !draft;
  const setHF = (patch: Partial<typeof h>) => { setH({ ...h, ...patch }); setDirty(true); };

  // ---- kolone po vrsti dokumenta
  const priceCell = (l: Line, i: number) => {
    const bn = before(l), k = 1 + rate(l.productId) / 100, q = num(l.quantity);
    const shown = mode === 'un' ? bn : mode === 'ug' ? bn * k : mode === 'tn' ? bn * q : bn * k * q;
    return <NumCell r={i} c="p" ro={ro} value={shown} digits={mode[0] === 'u' ? 4 : 2} onChange={(v0) => {
      const v = v0 ?? 0;
      const unitBefore = mode === 'un' ? v : mode === 'ug' ? v / k : q ? (mode === 'tn' ? v / q : v / k / q) : 0;
      upd(i, { unitCost: String(+(unitBefore * (1 - num(l.discountPercent) / 100)).toFixed(4)) });
    }} />;
  };

  return (
    <div className="page doc" ref={box}>
      <div className={`doc-head ${K.price || (posted && !isStocktake) ? '' : 'two'}`}>
        <div className="doc-form dh-a">
          <label>Interni broj<input className="input ro" readOnly value={doc?.displayNumber ?? (id ? 'nacrt' : 'novi dokument')} /></label>
          <label>{kind === 'TRANSFER' ? 'Iz magacina' : 'Magacin'}<select className="input" disabled={ro} value={h.warehouseId} onChange={(e) => setHF({ warehouseId: e.target.value })}>
            {activeWh.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
          {kind === 'TRANSFER' && <label>U magacin<select className="input" disabled={ro} value={h.targetWarehouseId} onChange={(e) => setHF({ targetWarehouseId: e.target.value })}>
            <option value="">- izaberite -</option>{activeWh.filter((w) => w.id !== h.warehouseId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
          {K.partner && <label>{K.partner}<div className="doc-partner">
            <select className="input" disabled={ro} value={h.partnerId} onChange={(e) => setHF({ partnerId: e.target.value })}>
              <option value="">{K.partnerRequired ? '- izaberite -' : '- bez -'}</option>
              {partners.data?.filter((p) => p.active || p.id === h.partnerId).map((p) => <option key={p.id} value={p.id}>{p.name}{p.taxId ? ` (${p.taxId})` : ''}</option>)}
            </select>
            {!ro && <button type="button" className="btn sm" title={`Novi ${K.partner.toLowerCase()}`} onClick={() => setDialog('partner')}>+</button>}
          </div></label>}
          <label>Broj dok.<input className="input" disabled={ro} value={h.externalNumber} maxLength={60} placeholder={K.partner ? 'broj fakture / otpremnice' : ''} onChange={(e) => setHF({ externalNumber: e.target.value })} /></label>
        </div>
        <div className="doc-form dh-b">
          <label>Datum prometa<input type="date" className="input" disabled={ro} value={h.docDate} onChange={(e) => setHF({ docDate: e.target.value })} /></label>
          {(K.partner || K.price) && <label>Datum valute<input type="date" className="input" disabled={ro} value={h.dueDate} onChange={(e) => setHF({ dueDate: e.target.value })} /></label>}
          <label>Status<input className={`input ro doc-st-${doc?.status ?? 'NEW'}`} readOnly title={doc?.cancelReason ?? undefined} value={doc ? `${DOC_STATUS_LABEL[doc.status]}${doc.postedAt ? ` ${new Date(doc.postedAt).toLocaleDateString('sr-Latn-RS')}` : ''}${doc.cancelReason ? ` - ${doc.cancelReason}` : ''}` : 'Nov (nije sačuvan)'} /></label>
          <label>Napomena<input className="input" disabled={ro} maxLength={500} value={h.note} onChange={(e) => setHF({ note: e.target.value })} /></label>
          <label title="Ne štampa se">Interna nap.<input className="input" disabled={ro} maxLength={500} value={h.internalNote} placeholder="ne štampa se" onChange={(e) => setHF({ internalNote: e.target.value })} /></label>
        </div>
        {(K.price || (posted && !isStocktake)) && <div className="doc-sum dh-d">
          <div className="doc-totals">
            {K.price && <div><span>Iznos bez PDV</span><b>{s2(totals.before)}</b></div>}
            {K.price && <div><span>Rabat</span><b>{s2(totals.rabat)}</b></div>}
            <div><span>Osnovica</span><b>{s2(totals.net)}</b></div>
            {K.price && <div><span>PDV</span><b>{s2(totals.vat)}</b></div>}
            {K.price && <div className="big"><span>Iznos sa PDV</span><b>{s2(totals.gross)}</b></div>}
          </div>
        </div>}
      </div>

      <div className="doc-grid">
        <table className="tbl grid doc-table">
          <thead><tr>
            <th>#</th><th>Šifra</th><th>Naziv</th><th>JM</th>
            {K.price && <th className="num">Poslednja nabavna</th>}
            <th className="num">{isStocktake ? 'Očekivano' : 'Trenutno stanje'}</th>
            <th className="num">{isStocktake ? 'Izmereno' : isCorr ? 'Korekcija (+/−)' : 'Količina'}</th>
            {isStocktake && <th className="num">Razlika</th>}
            {isCorr && <th className="num">Novo stanje</th>}
            {K.price && <th className="num">{MODES.find((m) => m[0] === mode)![1]}</th>}
            {K.price && <th className="num">Rabat %</th>}
            {K.price && <th className="num">PDV %</th>}
            {!K.price && <th className="num">Nab. cena</th>}
            <th className="num">{K.price ? 'Iznos sa PDV' : isStocktake ? 'Vrednost razlike' : 'Vrednost'}</th>
            {!ro && <th />}
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const q = num(l.quantity), st = isStocktake && !draft ? num(l.bookQuantity) : stock(l.productId);
              const cost = K.price ? num(l.unitCost) : l.unitCost ? num(l.unitCost) : avg(l.productId);
              const counted = !(isStocktake && l.quantity === '');
              const value = isStocktake ? (!draft && l.value ? Number(l.value) : counted ? (q - st) * (l.unitCost ? num(l.unitCost) : avg(l.productId)) : 0)
                : (!draft && l.value ? Number(l.value) : K.price ? q * num(l.unitCost) : q * cost) * (K.price ? 1 + rate(l.productId) / 100 : 1);
              return (
                <tr key={l.productId} className={qtyOk(l) && (!K.price || num(l.unitCost) > 0) ? '' : 'ig-missing'}>
                  <td className="muted">{i + 1}</td>
                  <td>{l.code}</td>
                  <td>{ro ? <b>{l.name}</b> : <button className="link doc-name" title="Kalkulator (izmena količine i cene)" onClick={() => setCalc({ p: { id: l.productId, code: l.code, name: l.name, unit: l.unit }, index: i })}><b>{l.name}</b></button>}</td>
                  <td>{l.unit}</td>
                  {K.price && <td className="num red">{last[l.productId] ? s2(last[l.productId]!) : ''}</td>}
                  <td className="num">{s4(st)}</td>
                  <td className="num"><NumCell r={i} c="q" ro={ro} value={counted ? q : null} digits={4} allowMinus={isCorr} placeholder={isStocktake ? 'upišite' : undefined} onChange={(v) => upd(i, { quantity: v === null ? (isStocktake ? '' : '0') : String(v) })} /></td>
                  {isStocktake && <td className={`num ${counted && q - st < 0 ? 'err-text' : counted && q - st > 0 ? 'ok-text' : ''}`}>{counted ? s4(q - st) : ''}</td>}
                  {isCorr && <td className={`num ${st + q < 0 ? 'err-text' : ''}`}>{s4(st + q)}</td>}
                  {K.price && <td className="num">{priceCell(l, i)}</td>}
                  {K.price && <td className="num"><NumCell r={i} c="r" ro={ro} value={num(l.discountPercent)} digits={2} onChange={(v) => {
                    const bn = before(l), r = Math.min(Math.max(v ?? 0, 0), 99.99);
                    upd(i, { discountPercent: r ? String(r) : null, unitCost: String(+(bn * (1 - r / 100)).toFixed(4)) });
                  }} /></td>}
                  {K.price && <td className="num">{s2(rate(l.productId))}</td>}
                  {!K.price && <td className="num">{isStocktake && !ro
                    ? <NumCell r={i} c="p" ro={ro} value={l.unitCost ? num(l.unitCost) : avg(l.productId)} digits={2} onChange={(v) => upd(i, { unitCost: v === null ? null : String(v) })} />
                    : s2(isStocktake ? (l.unitCost ? num(l.unitCost) : avg(l.productId)) : cost)}</td>}
                  <td className="num"><b>{s2(value)}</b></td>
                  {!ro && <td><button className="btn sm danger-ghost" tabIndex={-1} title="Ukloni stavku" onClick={() => { setLines(lines.filter((_, j) => j !== i)); setDirty(true); }}>✕</button></td>}
                </tr>
              );
            })}
            {ro && lines.length === 0 && <tr className="dt-empty"><td colSpan={14}>Dokument nema stavki.</td></tr>}
            {!ro && (
              <tr className={`doc-new ${lines.length >= 5 ? 'up' : ''}`}>
                <td className="muted">{lines.length + 1}</td>
                <td colSpan={2} className="doc-pick">
                  <ProductPicker key={lines.length} filter="includeInactive=false" autoFocus={!id0} onCreate={can('catalog.write') ? setCreating : undefined} onPick={(p) => void add(p)}
                    placeholder={isStocktake ? 'artikal: šifra, barkod ili naziv… (ili Pripremi popis)' : 'kucajte šifru, barkod ili naziv i Enter…'} />
                </td>
                <td colSpan={11} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {error !== undefined && <ErrorBox error={error} />}
      <div className="doc-bar">
        <div className="doc-bar-left">
          {K.price && !ro && <div className="doc-modes" role="radiogroup" aria-label="Unos cene">
            {MODES.map(([m, l]) => <label key={m}><input type="radio" name={`mode-${id ?? 'new'}`} checked={mode === m} onChange={() => setMode(m)} /> {l}</label>)}
          </div>}
          {K.price && !ro && <select className="input doc-mode-sel" value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label="Unos cene">
            {MODES.map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select>}
          {!ro && !isStocktake && <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Kalkulacija</label>}
          {isStocktake && !ro && <button className="btn primary" disabled={busy} onClick={() => setDialog('prep')} title="Izaberite kategorije/grupe - svi artikli upisuju se u tabelu">Pripremi popis</button>}
          {isStocktake && !ro && uncounted > 0 && <button className="btn" title="Artikli koje ne brojite (npr. lepinje) - izmereno postaje isto kao očekivano, razlika 0"
            onClick={() => { setLines(lines.map((l) => (l.quantity === '' ? { ...l, quantity: String(Math.max(0, stock(l.productId))) } : l))); setDirty(true); toast('ok', `Upisano očekivano za ${uncounted} artikala`); }}>Prazno = očekivano</button>}
          {isStocktake && lines.length > 0 && <span className={`doc-count ${uncounted ? 'warn' : ''}`}>Stavki: {lines.length}{uncounted ? ` · nije izmereno: ${uncounted}` : ''}</span>}
          {isStocktake && <button className="btn" disabled={!lines.length} onClick={() => { setPrintList(true); setTimeout(() => { window.print(); setPrintList(false); }, 150); }} title="Lista za brojanje: očekivano i prazna kolona izmereno">Štampaj popis</button>}
          {!ro && <button className="btn" disabled={busy} onClick={async () => { if (!id || dirty) { if (!(await run(persist, 'Nacrt sačuvan'))) return; } setDialog('import'); }}>Uvoz stavki</button>}
        </div>
        <div className="doc-bar-right">
          <button className="btn" onClick={exportCsv} disabled={!lines.length}>Eksport</button>
          {!isStocktake && <button className="btn" onClick={() => setTimeout(() => window.print(), 100)} disabled={!lines.length}>Štampaj</button>}
          {doc && doc.status !== 'CANCELLED' && can('stock.post') && <button className="btn danger-ghost" disabled={busy} onClick={() => setDialog('cancel')}>{draft ? 'Obriši nacrt' : 'Storniraj'}</button>}
          {!ro && <button className="btn" disabled={busy || invalid || !lines.length} onClick={saveDraft} title="Čuva bez knjiženja - zalihe se ne menjaju">Sačuvaj nacrt</button>}
          {!ro && can('stock.post') && <button className="btn" disabled={busy || invalid || !lines.length} onClick={() => void post(true)}>Sačuvaj i novi</button>}
          {!ro && can('stock.post') && <button className="btn primary" disabled={busy || invalid || !lines.length} onClick={() => void post(false)}>{busy ? 'Čuvam…' : 'Sačuvaj'}</button>}
          <button className="btn" onClick={close}>Zatvori</button>
        </div>
      </div>

      <DocPrint list={printList} expected={(pid) => stock(pid)} doc={{ ...(doc ?? {} as Doc), kind, kindLabel: K.title, docDate: h.docDate, externalNumber: h.externalNumber || null, note: h.note || null,
        warehouseName: whs.data.find((w) => w.id === h.warehouseId)?.name ?? '', targetWarehouseName: whs.data.find((w) => w.id === h.targetWarehouseId)?.name ?? null,
        partnerName: partners.data?.find((p) => p.id === h.partnerId)?.name ?? null, createdByName: doc?.createdByName ?? '', displayNumber: doc?.displayNumber ?? null, status: doc?.status ?? 'DRAFT',
        lines: lines.map((l) => ({ ...l, value: l.value ?? String(num(l.quantity) * num(l.unitCost)) })) }} />

      {calc && <Calculator name={calc.p.name} unit={calc.p.unit} rate={rate(calc.p.id)} stock={stock(calc.p.id)} lastCost={last[calc.p.id] ?? null}
        salePrice={prods.data.get(calc.p.id) ? Number(prods.data.get(calc.p.id)!.price) : null}
        initial={calc.index !== null ? { quantity: num(lines[calc.index].quantity), unitNet: before(lines[calc.index]) || null, discount: num(lines[calc.index].discountPercent) } : undefined}
        mode={K.price ? 'price' : isCorr ? 'correction' : 'qty'} auto={auto} onAuto={setAuto}
        onClose={() => { setCalc(null); focusPicker(); }} onSave={(r) => void calcSave(r)} />}
      {dialog === 'cancel' && id && <CancelDialog id={id} draft={draft} onClose={() => setDialog(null)} onDone={(d) => { setDialog(null); if (draft) { toast('ok', 'Nacrt obrisan'); tab.close(); } else { apply(d); toast('ok', 'Dokument storniran'); } }} />}
      {dialog === 'partner' && <NewPartner label={K.partner!} onClose={() => setDialog(null)} onCreated={(p) => { setDialog(null); partners.setData([...(partners.data ?? []), p]); setHF({ partnerId: p.id }); }} />}
      {dialog === 'import' && id && <Modal title="Uvoz stavki (CSV/XLSX)" onClose={() => setDialog(null)} wide>
        <ImportPanel entity="document-lines" documentId={id} onDone={async () => { setDialog(null); apply(await api<Doc>('GET', `/stock/documents/${id}`)); }} />
      </Modal>}
      {dialog === 'prep' && <PrepStocktake onClose={() => setDialog(null)} onPick={prepare} />}
      {creating !== null && <QuickProduct name={creating} onClose={() => setCreating(null)} onCreated={(p) => { setCreating(null); toast('ok', `Napravljen artikal ${p.name} (šifra ${p.code})`); void add(p); }} />}
    </div>
  );
}

/** Pripremi popis: štiklirane kategorije i grupe - svi artikli sa zalihom upisuju se u tabelu. */
function PrepStocktake({ onClose, onPick }: { onClose: () => void; onPick: (groups: string[]) => void }) {
  const [v, setV] = useState<string[]>([]);
  return (
    <Modal title="Pripremi popis" onClose={onClose}>
      <div className="form">
        <p className="muted small">Štiklirajte kategorije (npr. Kuhinja) ili pojedine grupe. Svi artikli sa zalihom iz njih upisuju se u tabelu; zatim redom upisujete izmereno. Ništa štiklirano = sve.</p>
        <div className="prep-tree"><GroupTree value={v} onChange={setV} /></div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
          <button type="button" className="btn primary" onClick={() => onPick(v)}>Upiši u tabelu</button>
        </div>
      </div>
    </Modal>
  );
}

/** Broj u ćeliji tabele: prikaz sa decimalnim zarezom, dok se kuca ostaje uneti tekst. Enter = sledeće polje. */
function NumCell({ r, c, value, digits, ro, onChange, allowMinus, placeholder }: {
  r: number; c: string; value: number | null; digits: number; ro: boolean; onChange: (v: number | null) => void; allowMinus?: boolean; placeholder?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const fmtv = value ? value.toLocaleString('sr-Latn-RS', { minimumFractionDigits: digits === 4 ? 0 : digits, maximumFractionDigits: digits }) : '';
  if (ro) return <>{fmtv}</>;
  return (
    <input data-r={r} data-c={c} className="input num cell" inputMode="decimal" value={text ?? fmtv} placeholder={placeholder}
      onFocus={(e) => { setText(fmtv.replace(/\./g, '')); setTimeout(() => e.target.select(), 0); }} onBlur={() => setText(null)}
      onChange={(e) => {
        const t = e.target.value.replace(allowMinus ? /[^0-9,.-]/g : /[^0-9,.]/g, '');
        setText(t);
        if (t !== '-' && t !== '') onChange(num(t)); else if (t === '') onChange(null);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const cells = [...(e.currentTarget.closest('table')?.querySelectorAll<HTMLInputElement>('input.cell') ?? [])];
        const i = cells.indexOf(e.currentTarget);
        if (i >= 0 && i < cells.length - 1) cells[i + 1].focus();
        else e.currentTarget.closest('.doc')?.querySelector<HTMLInputElement>('.doc-pick .picker input')?.focus();
      }} />
  );
}

function NewPartner({ label, onClose, onCreated }: { label: string; onClose: () => void; onCreated: (p: Partner) => void }) {
  const [f, setF] = useState({ name: '', taxId: '' });
  const [error, setError] = useState<unknown>();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(undefined);
    try { onCreated(await api<Partner>('POST', '/partners', { name: f.name.trim(), kind: label === 'Kupac' ? 'CUSTOMER' : 'SUPPLIER', taxId: f.taxId.trim() || null })); } catch (err) { setError(err); }
  };
  return (
    <Modal title={`Novi ${label.toLowerCase()}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Naziv<input className="input" autoFocus value={f.name} maxLength={160} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>PIB (opciono)<input className="input" inputMode="numeric" maxLength={9} value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value.replace(/[^0-9]/g, '') })} /></label>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Odustani</button><button className="btn primary" disabled={!f.name.trim()}>Dodaj</button></div>
      </form>
    </Modal>
  );
}

export function CancelDialog({ id, draft, onClose, onDone }: { id: string; draft: boolean; onClose: () => void; onDone: (d: Doc) => void }) {
  const [reason, setReason] = useState(draft ? 'nacrt nije potreban' : '');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { onDone(await api('POST', `/stock/documents/${id}/cancel`, { reason: reason.trim() })); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={draft ? 'Brisanje nacrta' : 'Storno dokumenta'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {!draft && <p>Storno pravi suprotna kretanja po istim cenama; kartica ostaje potpuna. Ako je roba u međuvremenu potrošena, storno će biti odbijen.</p>}
        <label>Razlog<input className="input" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required /></label>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Nazad</button><button className="btn danger" disabled={busy || reason.trim().length < 3}>{draft ? 'Obriši' : 'Storniraj'}</button></div>
      </form>
    </Modal>
  );
}

/** A4 štampa robnog dokumenta: zaglavlje firme, vrsta i broj, partner i magacin, stavke sa vrednostima, potpisi. */
function DocPrint({ doc, list, expected }: { doc: Doc; list?: boolean; expected?: (productId: string) => number }) {
  const st = useLoad(() => api<any>('GET', '/settings/kasa').catch(() => ({})), []);
  const c = st.data ?? {};
  const isStocktake = doc.kind === 'STOCKTAKE';
  const n = (v: string | null | undefined, d = 2) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('sr-Latn-RS', { minimumFractionDigits: d, maximumFractionDigits: Math.max(d, 4) }));
  const total = doc.lines.reduce((a, l) => a + Number(l.value ?? 0), 0);
  if (list) {
    return (
      <div className="doc-print" aria-hidden>
        <div className="dp-head"><div><b>{c.companyName || ''}</b><div>{c.storeName || ''}</div></div>
          <div className="dp-title"><h1>Popisna lista</h1><div>Magacin: {doc.warehouseName}</div><div>Datum: {doc.docDate.split('-').reverse().join('.')}</div></div></div>
        <table className="dp-lines">
          <thead><tr><th>R.br.</th><th>Šifra</th><th>Naziv</th><th>JM</th><th>Očekivano</th><th style={{ width: '22%' }}>Izmereno</th><th>Razlika</th></tr></thead>
          <tbody>{doc.lines.map((l, i) => (
            <tr key={l.productId}><td>{i + 1}</td><td>{l.code}</td><td>{l.name}</td><td>{l.unit}</td>
              <td className="num">{n(String(expected?.(l.productId) ?? l.bookQuantity ?? ''), 0)}</td><td className="num">{l.quantity === '' ? '' : n(l.quantity, 0)}</td><td /></tr>
          ))}</tbody>
        </table>
        <div className="dp-sign"><div>Popisao: ____________________</div><div>Kontrolisao: ____________________</div></div>
      </div>
    );
  }
  return (
    <div className="doc-print" aria-hidden>
      <div className="dp-head">
        <div><b>{c.companyName || ''}</b><div>{c.storeName || ''}</div><div>{c.address || ''}{c.city ? `, ${c.city}` : ''}</div>{c.pib && <div>PIB: {c.pib}</div>}</div>
        <div className="dp-title"><h1>{doc.kindLabel}</h1><div className="dp-no">{doc.displayNumber ?? 'NACRT'}</div>
          <div>Datum: {doc.docDate.split('-').reverse().join('.')}</div>{doc.status === 'CANCELLED' && <div className="dp-cancel">STORNIRAN</div>}</div>
      </div>
      <table className="dp-meta"><tbody>
        <tr><td>Magacin</td><td>{doc.warehouseName}{doc.targetWarehouseName ? ` → ${doc.targetWarehouseName}` : ''}</td></tr>
        {doc.partnerName && <tr><td>Partner</td><td>{doc.partnerName}</td></tr>}
        {doc.externalNumber && <tr><td>Broj dokumenta</td><td>{doc.externalNumber}</td></tr>}
        {doc.note && <tr><td>Napomena</td><td>{doc.note}</td></tr>}
      </tbody></table>
      <table className="dp-lines">
        <thead><tr><th>R.br.</th><th>Šifra</th><th>Naziv</th><th>JM</th>
          {isStocktake && <th>Knjižno</th>}<th>{isStocktake ? 'Popisano' : 'Količina'}</th>
          <th>Cena</th><th>Rabat</th><th>Vrednost</th></tr></thead>
        <tbody>{doc.lines.map((l, i) => (
          <tr key={l.productId}><td>{i + 1}</td><td>{l.code}</td><td>{l.name}</td><td>{l.unit}</td>
            {isStocktake && <td className="num">{n(l.bookQuantity, 0)}</td>}<td className="num">{n(l.quantity, 0)}</td>
            <td className="num">{n(l.unitCost)}</td><td className="num">{l.discountPercent ? `${n(l.discountPercent)}%` : ''}</td><td className="num">{n(l.value)}</td></tr>
        ))}</tbody>
        <tfoot><tr><td colSpan={isStocktake ? 8 : 7}>Ukupno</td><td className="num">{n(String(total))}</td></tr></tfoot>
      </table>
      <div className="dp-sign"><div>Sastavio: {doc.createdByName}</div><div>Primio / Izdao: ____________________</div><div>Odobrio: ____________________</div></div>
      <div className="dp-foot">Štampano {new Date().toLocaleString('sr-Latn-RS')}</div>
    </div>
  );
}

/** Novi artikal iz dokumenta (pretraga ga nije našla): naziv je već upisan, zaliha se prati; posle čuvanja odmah ide u dokument. */
function QuickProduct({ name, onClose, onCreated }: { name: string; onClose: () => void; onCreated: (p: PickProduct) => void }) {
  const cats = useLoad(() => api<any[]>('GET', '/categories'), []);
  const taxes = useLoad(() => api<TaxRate[]>('GET', '/tax-rates'), []);
  if (!cats.data || !taxes.data) return <Modal title="Novi artikal" onClose={onClose}><Spinner /></Modal>;
  return <ProductForm product={null} categories={cats.data} taxes={taxes.data} initial={{ name, trackStock: true }} onClose={onClose} onImage={() => undefined}
    onSaved={(c) => c && onCreated(c as unknown as PickProduct)} />;
}
