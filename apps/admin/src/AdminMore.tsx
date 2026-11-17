import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, Category, fmt } from '@shared/api';
import { Empty, ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { Column, DataTable } from './DataTable';
import { NameDialog } from './TableMap';
import { n2, n4, useDayRange } from './dayRange';
import { useTab } from './tabs';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date());
const q3 = (s: string | null | undefined) => (s === null || s === undefined ? '-' : Number(s).toLocaleString('sr-Latn-RS', { maximumFractionDigits: 3 }));

// ---------------------------------------------------------------- Zalihe

type Level = { productId: string; code: string; name: string; unit: string; isSellable: boolean; minStock: string | null; quantity: string; value: string; belowMin: boolean };

/** Zalihe: sve što se prati na zalihi. U minusu: svetlo crven red; ispod minimalne zalihe: crven tekst (za poručivanje). */
export function StockLevels() {
  const r = useLoad(() => api<Level[]>('GET', '/stock/levels'), []);
  if (r.loading && !r.data) return <Spinner />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const rows = r.data ?? [];
  const neg = rows.filter((x) => Number(x.quantity) < 0).length;
  const low = rows.filter((x) => x.belowMin && Number(x.quantity) >= 0).length;
  const columns: Column<Level>[] = [
    { key: 'code', label: 'Šifra', value: (x) => x.code, width: 90 },
    { key: 'name', label: 'Naziv', value: (x) => x.name, render: (x) => <strong>{x.name}</strong> },
    { key: 'unit', label: 'JM', value: (x) => x.unit.toUpperCase(), width: 70, filter: 'select' },
    { key: 'qty', label: 'Stanje', value: (x) => Number(x.quantity), render: (x) => q3(x.quantity), align: 'right' },
    { key: 'min', label: 'Minimum', value: (x) => (x.minStock === null ? '' : Number(x.minStock)), render: (x) => q3(x.minStock), align: 'right' },
    { key: 'state', label: 'Stanje zalihe', value: (x) => (Number(x.quantity) < 0 ? 'U minusu' : x.belowMin ? 'Ispod minimuma' : 'U redu'), filter: 'select',
      render: (x) => (Number(x.quantity) < 0 ? <span className="badge neg">U minusu</span> : x.belowMin ? <span className="badge low">Ispod minimuma</span> : <span className="badge paid">U redu</span>) },
    { key: 'value', label: 'Vrednost', value: (x) => Number(x.value), render: (x) => fmt(x.value), align: 'right' },
  ];
  return (
    <div className="page">
      <div className="stats compact">
        <div className="stat"><span>Prati se</span><b>{rows.length}</b></div>
        <div className="stat stat-neg"><span>U minusu</span><b>{neg}</b></div>
        <div className="stat stat-low"><span>Ispod minimuma</span><b>{low}</b></div>
        <div className="stat"><span>Ukupna vrednost</span><b>{fmt(rows.reduce((a, x) => a + Number(x.value), 0).toFixed(2))}</b></div>
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(x) => x.productId} empty="Nema artikala koji se prate na zalihi."
        rowClass={(x) => (Number(x.quantity) < 0 ? 'row-neg' : x.belowMin ? 'low' : undefined)} />
    </div>
  );
}

// ---------------------------------------------------------------- Stanje na dan

type AsOf = { productId: string; code: string; name: string; unit: string; quantity: string; value: string };

/** Stanje robe na početku izabranog dana (pre otvaranja), npr. za inspekciju ili kontrolu popisa. */
export function StockAsOf() {
  const [date, setDate] = useState(today());
  const r = useLoad(() => api<AsOf[]>('GET', `/stock/as-of?date=${date}`), [date]);
  const rows = r.data ?? [];
  const columns: Column<AsOf>[] = [
    { key: 'code', label: 'Šifra', value: (x) => x.code, width: 90 },
    { key: 'name', label: 'Naziv', value: (x) => x.name, render: (x) => <strong>{x.name}</strong> },
    { key: 'unit', label: 'JM', value: (x) => x.unit.toUpperCase(), width: 70, filter: 'select' },
    { key: 'qty', label: 'Stanje', value: (x) => Number(x.quantity), render: (x) => q3(x.quantity), align: 'right' },
    { key: 'value', label: 'Vrednost', value: (x) => Number(x.value), render: (x) => fmt(x.value), align: 'right' },
  ];
  return (
    <div className="page">
      <div className="toolbar">
        <label>Stanje na početku dana<input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <span className="muted">Ukupna vrednost: <b>{fmt(rows.reduce((a, x) => a + Number(x.value), 0).toFixed(2))}</b></span>
      </div>
      {r.loading && !r.data ? <Spinner /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <DataTable columns={columns} rows={rows} rowKey={(x) => x.productId} empty="Nema kretanja robe pre ovog datuma."
          rowClass={(x) => (Number(x.quantity) < 0 ? 'row-neg' : undefined)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Kartica proizvoda

type CardRow = { at: string; in: string | null; out: string | null; balance: string | null; user: string | null; document: string; description: string; partner: string | null; unitCost: string | null; salePrice: string | null; taxRate: string | null };
type Card = { product: { id: string; code: string; name: string; unit: string; price: string; taxRate: string | null }; tracked: boolean; opening: string | null; closing: string | null; totals: { in: string; out: string }; rows: CardRow[] };
type CRow = CardRow & { k: number; qty: number; rate: number; costNet: number; saleNet: number };

const dt = (iso: string) => new Date(iso).toLocaleString('sr-Latn-RS', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Kartica proizvoda (kao u Octopos-u): početna i završna smena, proizvod, Pronađi; vreme, ulaz, izlaz, stanje, dokument,
 * komitent, nabavna i prodajna cena bez PDV-a, PDV, nabavna i prodajna vrednost (bez i sa PDV-om), korisnik. U dnu UKUPNO.
 */
export function ProductCard({ initialProductId }: { initialProductId?: string }) {
  const tab = useTab();
  const range = useDayRange();
  const prods = useLoad(() => api<{ data: any[] }>('GET', '/products?pageSize=5000&includeInactive=true').then((r) => r.data), []);
  const [text, setText] = useState('');
  useEffect(() => {
    const p0 = initialProductId && prods.data?.find((x) => x.id === initialProductId);
    if (p0) setText(`${p0.name} [${p0.code}]`);
  }, [initialProductId, prods.data]);
  const p = prods.data?.find((x) => `${x.name} [${x.code}]` === text || x.code === text.trim());
  const [query, setQuery] = useState<{ id: string; from: string; to: string } | null>(null);
  // otvaranje iz Trenutnog stanja robe: odmah prikaži
  useEffect(() => { if (initialProductId && p && range.dates && !query) setQuery({ id: p.id, ...range.dates }); }, [p?.id, range.dates?.from]); // eslint-disable-line react-hooks/exhaustive-deps
  const card = useLoad(() => (query ? api<Card>('GET', `/reports/product-card?productId=${query.id}&from=${query.from}&to=${query.to}`) : Promise.resolve(null)), [query?.id, query?.from, query?.to]);
  const c = card.data;
  const rows: CRow[] = (c?.rows ?? []).map((x, k) => {
    const rate = Number(x.taxRate ?? c?.product.taxRate ?? 0);
    return { ...x, k, qty: Number(x.in ?? 0) || Number(x.out ?? 0), rate, costNet: Number(x.unitCost ?? 0), saleNet: x.salePrice ? Number(x.salePrice) / (1 + rate / 100) : 0 };
  });
  const m = (v: number) => (v ? n2(v) : '');
  const sum = (rs: CRow[], f: (r: CRow) => number) => rs.reduce((a, r) => a + f(r), 0);
  const columns: Column<CRow>[] = [
    { key: 'at', label: 'Vreme', value: (x) => x.at, render: (x) => dt(x.at), width: 160, filter: false },
    { key: 'in', label: 'Ulaz', value: (x) => (x.in ? Number(x.in) : ''), render: (x) => (x.in ? <span className="qty-in">{n4(Number(x.in))}</span> : ''), align: 'right', filter: false },
    { key: 'out', label: 'Izlaz', value: (x) => (x.out ? Number(x.out) : ''), render: (x) => (x.out ? <span className="qty-out">{n4(Number(x.out))}</span> : ''), align: 'right', filter: false },
    ...(c?.tracked ? [{ key: 'bal', label: 'Stanje', value: (x: CRow) => Number(x.balance), render: (x: CRow) => <b>{n4(Number(x.balance))}</b>, align: 'right', filter: false } as Column<CRow>] : []),
    { key: 'prod', label: 'Proizvod', value: (x) => `${n4(x.qty)} x ${c?.product.name ?? ''}` },
    { key: 'doc', label: 'Dokument', value: (x) => x.document, render: (x) => <span className="doc-code">{x.document}</span>, width: 110 },
    { key: 'partner', label: 'Komitent', value: (x) => x.partner ?? '', filter: 'select' },
    { key: 'cost', label: 'Jed. cena bez PDV', value: (x) => x.costNet, render: (x) => m(x.costNet), align: 'right', filter: false },
    { key: 'sale', label: 'Prod. cena bez PDV', value: (x) => x.saleNet, render: (x) => m(x.saleNet), align: 'right', filter: false },
    { key: 'rate', label: 'PDV', value: (x) => x.rate, render: (x) => n2(x.rate), align: 'right', filter: false, width: 60 },
    { key: 'cvn', label: 'Nabavna vrednost bez PDV', value: (x) => x.qty * x.costNet, render: (x) => m(x.qty * x.costNet), align: 'right', filter: false },
    { key: 'cvg', label: 'Nabavna vrednost sa PDV', value: (x) => x.qty * x.costNet * (1 + x.rate / 100), render: (x) => m(x.qty * x.costNet * (1 + x.rate / 100)), align: 'right', filter: false },
    { key: 'svn', label: 'Prodajna vrednost bez PDV', value: (x) => x.qty * x.saleNet, render: (x) => m(x.qty * x.saleNet), align: 'right', filter: false },
    { key: 'svg', label: 'Prodajna vrednost sa PDV', value: (x) => x.qty * x.saleNet * (1 + x.rate / 100), render: (x) => m(x.qty * x.saleNet * (1 + x.rate / 100)), align: 'right', filter: false },
    { key: 'user', label: 'Korisnik', value: (x) => x.user ?? '', filter: 'select' },
  ];
  return (
    <div className="page wide fill">
      <div className="filters-row">
        {range.ui}
        <label className="grow">Proizvod
          <input className="input" list="pc-products" value={text} placeholder="šifra ili naziv…" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && p && range.dates) setQuery({ id: p.id, ...range.dates }); }} />
          <datalist id="pc-products">{prods.data?.map((x) => <option key={x.id} value={`${x.name} [${x.code}]`} />)}</datalist>
        </label>
        <button className="btn primary" disabled={!p || !range.dates} onClick={() => p && range.dates && setQuery({ id: p.id, ...range.dates })}>Pronađi</button>
      </div>
      {!query ? <Empty>Izaberite smene i proizvod, pa Pronađi.</Empty> : card.loading && !c ? <Spinner /> : card.error ? <ErrorBox error={card.error} onRetry={card.reload} /> : c && (
        <>
          <div className="card-sum">
            <b>{c.product.name}</b> <span className="muted">[{c.product.code}] · {c.product.unit}</span>
            {c.tracked && <span>Početno stanje: <b>{n4(Number(c.opening))}</b></span>}
            <span>Ulaz: <b className="qty-in">{n4(Number(c.totals.in))}</b></span>
            <span>Izlaz: <b className="qty-out">{n4(Number(c.totals.out))}</b></span>
            {c.tracked && <span>Završno stanje: <b className={Number(c.closing) < 0 ? 'qty-out' : ''}>{n4(Number(c.closing))}</b></span>}
            {!c.tracked && <span className="muted">(ne prati se na zalihi - prikazana je prodaja sa kase)</span>}
          </div>
          <DataTable columns={columns} rows={rows} rowKey={(x) => String(x.k)} empty="Nema promena u periodu."
            totals={(rs) => ({ at: 'UKUPNO', in: <b>{n4(sum(rs, (x) => Number(x.in ?? 0)))}</b>, out: <b>{n4(sum(rs, (x) => Number(x.out ?? 0)))}</b>,
              cvn: <b>{n2(sum(rs, (x) => x.qty * x.costNet))}</b>, cvg: <b>{n2(sum(rs, (x) => x.qty * x.costNet * (1 + x.rate / 100)))}</b>,
              svn: <b>{n2(sum(rs, (x) => x.qty * x.saleNet))}</b>, svg: <b>{n2(sum(rs, (x) => x.qty * x.saleNet * (1 + x.rate / 100)))}</b> })} />
        </>
      )}
      <div className="bar"><div className="bar-left"><button className="btn" disabled={!c} onClick={() => window.print()}>Štampaj</button></div>
        <div className="bar-right"><button className="btn" onClick={tab.close}>Zatvori</button></div></div>
    </div>
  );
}

// ---------------------------------------------------------------- Cenovnik

/** Cenovnici: kopija svih proizvoda sa drugim cenama (Nova godina, Dostava…); kasa bira cenovnik dugmetom "Postavi cenovnik". */
export function PriceLists() {
  const toast = useToast();
  const lists = useLoad(() => api<any[]>('GET', '/price-lists'), []);
  const [open, setOpen] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const create = async (name: string) => {
    try { const l = await api('POST', '/price-lists', { name }); setNaming(false); lists.reload(); setOpen(l.id); }
    catch (e: any) { toast('err', e.message); }
  };
  if (open) return <PriceListEditor id={open} onBack={() => { setOpen(null); lists.reload(); }} />;
  return (
    <div className="page">
      <div className="toolbar"><span className="muted">Novi cenovnik kopira trenutne cene svih proizvoda; zatim menjate cene i štiklirate šta ulazi.</span>
        <button className="btn primary" onClick={() => setNaming(true)}>+ Cenovnik</button></div>
      {naming && <NameDialog title="Novi cenovnik" label="Naziv (npr. Nova godina, Dostava)" onClose={() => setNaming(false)} onSave={create} />}
      {lists.loading && !lists.data ? <Spinner /> : (
        <DataTable rows={lists.data ?? []} rowKey={(l) => l.id} onRowClick={(l) => setOpen(l.id)} empty="Nema cenovnika. Kasa radi sa osnovnim cenama." columns={[
          { key: 'name', label: 'Cenovnik', value: (l) => l.name, render: (l) => <strong>{l.name}</strong> },
          { key: 'items', label: 'Proizvoda', value: (l) => l.items, align: 'right' },
          { key: 'upd', label: 'Izmenjen', value: (l) => l.updatedAt, render: (l) => new Date(l.updatedAt).toLocaleString('sr-Latn-RS'), filter: false },
          { key: 'active', label: 'Status', value: (l) => (l.active ? 'Aktivan' : 'Neaktivan'), filter: 'select',
            render: (l) => (l.active ? <span className="badge paid">Aktivan</span> : <span className="badge cancelled">Neaktivan</span>) },
        ] as Column<any>[]} />
      )}
    </div>
  );
}

type PLRow = { productId: string; code: string; name: string; groupName: string; basePrice: string; price: string; included: boolean };

function PriceListEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const toast = useToast();
  const l = useLoad(() => api<any>('GET', `/price-lists/${id}`), [id]);
  const [rows, setRows] = useState<PLRow[] | null>(null);
  const data: PLRow[] = rows ?? (l.data?.items ?? []).map((i: any) => ({ ...i, price: i.price ?? i.basePrice }));
  const [mode, setMode] = useState<'PCT' | 'RSD'>('PCT');
  const [dir, setDir] = useState<1 | -1>(1);
  const [val, setVal] = useState('10');
  const [round, setRound] = useState(10);
  const [busy, setBusy] = useState(false);
  const set = (fn: (r: PLRow) => PLRow) => setRows(data.map(fn));
  const apply = () => {
    const v = Number(val.replace(',', '.'));
    if (!(v >= 0)) return;
    set((r) => {
      if (!r.included) return r;
      const base = Number(r.basePrice);
      let p = mode === 'PCT' ? base * (1 + (dir * v) / 100) : base + dir * v;
      p = Math.max(0, round > 0 ? Math.round(p / round) * round : p);
      return { ...r, price: p.toFixed(2) };
    });
  };
  const save = async () => {
    setBusy(true);
    try {
      await api('PUT', `/price-lists/${id}/items`, { items: data.filter((r) => r.included).map((r) => ({ productId: r.productId, price: Number(r.price.replace(',', '.')).toFixed(2) })) });
      toast('ok', 'Cenovnik sačuvan'); setRows(null); l.reload();
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  const toggleActive = async () => {
    try { await api('PATCH', `/price-lists/${id}`, { active: !l.data.active }); l.reload(); } catch (e: any) { toast('err', e.message); }
  };
  const remove = async () => {
    if (!window.confirm(`Obrisati cenovnik "${l.data.name}"?`)) return;
    try { await api('DELETE', `/price-lists/${id}`); onBack(); } catch (e: any) { toast('err', e.message); }
  };
  if (l.loading && !l.data) return <Spinner />;
  if (l.error) return <ErrorBox error={l.error} onRetry={l.reload} />;
  const bad = data.some((r) => r.included && !/^\d{1,10}([.,]\d{1,2})?$/.test(r.price));
  return (
    <div className="page wide">
      <div className="row-between">
        <div><button className="btn ghost" onClick={onBack}>‹ Cenovnici</button> <strong className="pl-name">{l.data.name}</strong></div>
        <div className="btn-row tight">
          <button className="btn" onClick={toggleActive}>{l.data.active ? 'Deaktiviraj' : 'Aktiviraj'}</button>
          <button className="btn danger-ghost" onClick={remove}>Obriši</button>
          <button className="btn primary" disabled={busy || bad || rows === null} onClick={save}>{busy ? 'Čuvam…' : 'Sačuvaj cenovnik'}</button>
        </div>
      </div>
      <div className="card pl-tools">
        <span>Nove cene od trenutnih:</span>
        <div className="seg"><button className={`seg-btn ${dir === 1 ? 'on' : ''}`} onClick={() => setDir(1)}>Podigni</button><button className={`seg-btn ${dir === -1 ? 'on' : ''}`} onClick={() => setDir(-1)}>Spusti</button></div>
        <input className="input num pl-val" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} />
        <div className="seg"><button className={`seg-btn ${mode === 'PCT' ? 'on' : ''}`} onClick={() => setMode('PCT')}>%</button><button className={`seg-btn ${mode === 'RSD' ? 'on' : ''}`} onClick={() => setMode('RSD')}>RSD</button></div>
        <label className="pl-round">Zaokruži na<select className="input" value={round} onChange={(e) => setRound(Number(e.target.value))}>
          {[0, 1, 5, 10, 50, 100].map((x) => <option key={x} value={x}>{x === 0 ? 'bez' : `${x} RSD`}</option>)}</select></label>
        <button className="btn primary" onClick={apply}>Primeni na štiklirane</button>
        <span className="muted small">Pojedinačnu cenu možete i ručno izmeniti u tabeli.</span>
      </div>
      <table className="tbl pl">
        <thead><tr>
          <th className="pl-check">
            <button className="icon-btn" title="Izaberi sve" onClick={() => set((r) => ({ ...r, included: true }))}>☑</button>
            <button className="icon-btn" title="Poništi sve" onClick={() => set((r) => ({ ...r, included: false }))}>✕</button>
          </th><th>Grupa</th><th>Naziv</th><th className="num">Stara cena</th><th className="num">Nova cena</th></tr></thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.productId} className={r.included ? '' : 'inactive'}>
              <td className="pl-check"><input type="checkbox" checked={r.included} onChange={(e) => set((x) => (x.productId === r.productId ? { ...x, included: e.target.checked } : x))} /></td>
              <td className="muted">{r.groupName}</td><td>{r.name}</td><td className="num">{fmt(r.basePrice)}</td>
              <td className="num"><input className={`input num pl-price ${r.included && !/^\d{1,10}([.,]\d{1,2})?$/.test(r.price) ? 'invalid' : ''}`} disabled={!r.included} value={r.price}
                onChange={(e) => set((x) => (x.productId === r.productId ? { ...x, price: e.target.value } : x))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Happy hour

const DAYS = ['Ned', 'Pon', 'Uto', 'Sre', 'Čet', 'Pet', 'Sub'];

/** Happy hour: od-do datum, u vremenu od-do, za grupu ili proizvod: nova cena ili popust %. */
export function HappyHours() {
  const list = useLoad(() => api<any[]>('GET', '/happy-hours'), []);
  const cats = useLoad(() => api<Category[]>('GET', '/categories'), []);
  const prods = useLoad(() => api<{ data: any[] }>('GET', '/products?pageSize=500&sellable=true').then((r) => r.data), []);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const target = (h: any) => (h.productId ? prods.data?.find((p) => p.id === h.productId)?.name : cats.data?.find((c) => c.id === h.categoryId)?.name) ?? '-';
  return (
    <div className="page">
      <div className="toolbar"><span className="muted">Cena važi na kasi automatski u zadatom periodu i vremenu.</span><button className="btn primary" onClick={() => setEdit('new')}>+ Happy hour</button></div>
      {list.loading && !list.data ? <Spinner /> : (
        <DataTable rows={list.data ?? []} rowKey={(h) => h.id} onRowClick={setEdit} empty="Nema definisanih happy hour pravila." columns={[
          { key: 'name', label: 'Naziv', value: (h) => h.name, render: (h) => <strong>{h.name}</strong> },
          { key: 'period', label: 'Period', value: (h) => `${h.dateFrom.split('-').reverse().join('.')} - ${h.dateTo.split('-').reverse().join('.')}` },
          { key: 'time', label: 'Vreme', value: (h) => `${h.timeFrom} - ${h.timeTo}` },
          { key: 'days', label: 'Dani', value: (h) => (h.weekdays.length ? h.weekdays.map((d: number) => DAYS[d]).join(', ') : 'svaki dan') },
          { key: 'target', label: 'Za', value: (h) => `${h.productId ? 'proizvod' : 'grupa'}: ${target(h)}` },
          { key: 'price', label: 'Cena', value: (h) => (h.kind === 'PRICE' ? fmt(h.value) : `-${Number(h.value)}%`), align: 'right' },
          { key: 'active', label: 'Status', value: (h) => (h.active ? 'Aktivno' : 'Isključeno'), filter: 'select',
            render: (h) => (h.active ? <span className="badge paid">Aktivno</span> : <span className="badge cancelled">Isključeno</span>) },
        ] as Column<any>[]} />
      )}
      {edit && <HappyForm h={edit === 'new' ? null : edit} cats={cats.data ?? []} prods={prods.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
    </div>
  );
}

function HappyForm({ h, cats, prods, onClose, onSaved }: { h: any; cats: Category[]; prods: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: h?.name ?? 'Happy hour', dateFrom: h?.dateFrom ?? today(), dateTo: h?.dateTo ?? today(), timeFrom: h?.timeFrom ?? '17:00', timeTo: h?.timeTo ?? '19:00',
    weekdays: (h?.weekdays ?? []) as number[], target: h?.productId ? 'P' : 'G', categoryId: h?.categoryId ?? cats[0]?.id ?? '', productId: h?.productId ?? '',
    kind: h?.kind ?? 'PERCENT', value: h ? String(Number(h.value)) : '20', active: h?.active ?? true,
  });
  const [error, setError] = useState<unknown>();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(undefined);
    const body = { name: f.name.trim(), dateFrom: f.dateFrom, dateTo: f.dateTo, timeFrom: f.timeFrom, timeTo: f.timeTo, weekdays: f.weekdays,
      categoryId: f.target === 'G' ? f.categoryId : null, productId: f.target === 'P' ? f.productId : null, kind: f.kind,
      value: Number(f.value.replace(',', '.')).toFixed(2), active: f.active };
    try {
      if (h) await api('PUT', `/happy-hours/${h.id}`, body); else await api('POST', '/happy-hours', body);
      onSaved();
    } catch (err) { setError(err); }
  };
  const remove = async () => { if (h && window.confirm('Obrisati?')) { await api('DELETE', `/happy-hours/${h.id}`); onSaved(); } };
  return (
    <Modal title={h ? `Happy hour: ${h.name}` : 'Novi happy hour'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <label>Naziv<input className="input" value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="grid2 tight">
          <label>Od datuma<input type="date" className="input" value={f.dateFrom} onChange={(e) => setF({ ...f, dateFrom: e.target.value })} /></label>
          <label>Do datuma<input type="date" className="input" value={f.dateTo} onChange={(e) => setF({ ...f, dateTo: e.target.value })} /></label>
          <label>Od vremena<input type="time" className="input" value={f.timeFrom} onChange={(e) => setF({ ...f, timeFrom: e.target.value })} /></label>
          <label>Do vremena<input type="time" className="input" value={f.timeTo} onChange={(e) => setF({ ...f, timeTo: e.target.value })} /></label>
        </div>
        <label>Dani u nedelji (prazno = svaki dan)
          <div className="day-chips">{DAYS.map((d, i) => (
            <button key={d} type="button" className={`chip ${f.weekdays.includes(i) ? 'on' : ''}`} onClick={() => setF({ ...f, weekdays: f.weekdays.includes(i) ? f.weekdays.filter((x) => x !== i) : [...f.weekdays, i] })}>{d}</button>
          ))}</div>
        </label>
        <div className="seg">
          <button type="button" className={`seg-btn ${f.target === 'G' ? 'on' : ''}`} onClick={() => setF({ ...f, target: 'G' })}>Za grupu</button>
          <button type="button" className={`seg-btn ${f.target === 'P' ? 'on' : ''}`} onClick={() => setF({ ...f, target: 'P' })}>Za proizvod</button>
        </div>
        {f.target === 'G'
          ? <label>Grupa<select className="input" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          : <label>Proizvod<select className="input" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}><option value="">izaberite…</option>{prods.map((p) => <option key={p.id} value={p.id}>{p.name} ({fmt(p.price)})</option>)}</select></label>}
        <div className="grid2 tight">
          <div className="seg">
            <button type="button" className={`seg-btn ${f.kind === 'PERCENT' ? 'on' : ''}`} onClick={() => setF({ ...f, kind: 'PERCENT' })}>Popust %</button>
            <button type="button" className={`seg-btn ${f.kind === 'PRICE' ? 'on' : ''}`} onClick={() => setF({ ...f, kind: 'PRICE' })}>Nova cena</button>
          </div>
          <input className="input num" inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        </div>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aktivno</label>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions">
          <button className="btn primary">Sačuvaj</button>
          {h && <button type="button" className="btn danger-ghost" onClick={remove}>Obriši</button>}
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Spajanje / podela smene

/** Spajanje dve zatvorene smene (npr. Ponedeljak + Ponedeljak1) i podela smene u vreme preseka (npr. 05:00). */
export function ShiftTools() {
  const toast = useToast();
  const [month, setMonth] = useState(today().slice(0, 7));
  const days = useLoad(() => api<any[]>('GET', `/business-days?month=${month}`), [month]);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [splitDay, setSplitDay] = useState('');
  const nowLocal = () => { const d = new Date(); const p = (x: number) => String(x).padStart(2, '0'); return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` }; };
  const [cutDate, setCutDate] = useState(nowLocal().date);
  const [cutTime, setCutTime] = useState(nowLocal().time);
  const [busy, setBusy] = useState(false);
  const fmtD = (s: string) => s.split('-').reverse().join('.') + '.';
  const label = (d: any) => `${d.name || ''} ${fmtD(d.date)} ${d.status === 'OPEN' ? '(otvorena)' : ''}`;
  const list = useMemo(() => [...(days.data ?? [])].filter((d) => d.id).sort((x, y) => (y.openedAt ?? y.date).localeCompare(x.openedAt ?? x.date)), [days.data]);
  const closed = list.filter((d) => d.status === 'CLOSED');
  const da = list.find((d) => d.id === a), db = list.find((d) => d.id === b);
  // ostaje početna (ranije otvorena) smena - isto pravilo kao na serveru
  const keep = da && db ? ((da.openedAt ?? da.date) <= (db.openedAt ?? db.date) ? da : db) : null;
  const gone = keep ? (keep === da ? db : da) : null;
  const merge = async () => {
    if (!keep || !gone || !window.confirm(`Spojiti smene? Ostaje „${label(keep).trim()}“, a „${label(gone).trim()}“ prestaje da postoji (svi računi prelaze u prvu).`)) return;
    setBusy(true);
    try { await api('POST', '/business-days/merge', { targetId: keep.id, sourceId: gone.id }); toast('ok', `Smene su spojene u ${keep.name || fmtD(keep.date)}`); setA(''); setB(''); days.reload(); }
    catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  const sd = list.find((d) => d.id === splitDay);
  const at = `${cutDate}T${cutTime}`;
  const split = async () => {
    if (!sd || !window.confirm(`Podeliti „${label(sd).trim()}“? Sve od ${fmtD(cutDate)} ${cutTime} ide u novu smenu sa datumom ${fmtD(cutDate)}.`)) return;
    setBusy(true);
    try {
      const r = await api('POST', `/business-days/${splitDay}/split`, { at });
      toast('ok', `Nova smena: ${r.after.name} ${fmtD(r.after.date)}${r.after.status === 'OPEN' ? ' (otvorena)' : ''}`);
      setSplitDay(r.after.status === 'OPEN' ? r.after.id : ''); // sledeća podela (npr. petak) kreće od nove smene
      const n = nowLocal(); setCutDate(n.date); setCutTime(n.time);
      days.reload();
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  return (
    <div className="page shift-tools">
      <div className="toolbar"><label>Mesec<input type="month" className="input" value={month} onChange={(e) => setMonth(e.target.value)} /></label></div>
      {days.loading && !days.data ? <Spinner /> : days.error ? <ErrorBox error={days.error} /> : (
        <>
          <section className="card">
            <h3>Spajanje smena</h3>
            <p className="muted small">Kada je smena greškom zatvorena pa otvorena nova (Ponedeljak + Ponedeljak1). Obe moraju biti zatvorene. <b>Ostaje početna (ranije otvorena) smena</b> - Ponedeljak + Ponedeljak1 = Ponedeljak.</p>
            <div className="grid2 tight">
              <label>Prva smena<select className="input" value={a} onChange={(e) => setA(e.target.value)}><option value="">izaberite…</option>{closed.filter((d) => d.id !== b).map((d) => <option key={d.id} value={d.id}>{label(d)}</option>)}</select></label>
              <label>Druga smena<select className="input" value={b} onChange={(e) => setB(e.target.value)}><option value="">izaberite…</option>{closed.filter((d) => d.id !== a).map((d) => <option key={d.id} value={d.id}>{label(d)}</option>)}</select></label>
            </div>
            {keep && gone && <p className="notice">Ostaje: <b>{label(keep)}</b> · spaja se i nestaje: {label(gone)}</p>}
            <button className="btn primary" disabled={busy || !keep} onClick={merge}>Spoji smene</button>
          </section>
          <section className="card">
            <h3>Podela smene</h3>
            <p className="muted small">Kada smena nije zatvorena na vreme. Primer: sreda nije zatvorena, a danas je petak - podelite sredu sa datumom <b>četvrtak</b> i vremenom pre otvaranja u četvrtak; sve od tog trenutka postaje smena „Četvrtak“. Zatim istu (novu) smenu podelite sa datumom <b>petak</b>. Nezatvorena smena ostaje otvorena kao poslednja.</p>
            <label>Smena koja se deli<select className="input" value={splitDay} onChange={(e) => setSplitDay(e.target.value)}><option value="">izaberite…</option>{list.map((d) => <option key={d.id} value={d.id}>{label(d)}</option>)}</select></label>
            <div className="grid2 tight">
              <label>Datum nove smene (presek)<input type="date" className="input" value={cutDate} onChange={(e) => setCutDate(e.target.value)} /></label>
              <label>Vreme preseka<input type="time" className="input" value={cutTime} onChange={(e) => setCutTime(e.target.value)} /></label>
            </div>
            {sd && <p className="notice">Do {fmtD(cutDate)} {cutTime} ostaje u „{label(sd).trim()}“; od tada sve (računi, naplate, smene zaposlenih) ide u novu smenu sa datumom {fmtD(cutDate)}.</p>}
            <button className="btn primary" disabled={busy || !splitDay || !cutDate || !cutTime} onClick={split}>Podeli smenu</button>
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Izgled isečka

/** Logo za termalni štampač: umanjenje na najviše `maxWidth` tačaka, crno-belo (prag), bitovi po redovima (GS v 0). */
export async function toRaster(file: File, maxWidth: number) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('Fajl nije slika')); i.src = url; });
    const w = Math.min(maxWidth, Math.floor(img.width / 8) * 8 || 8);
    const width = Math.max(8, Math.floor(w / 8) * 8);
    const height = Math.min(400, Math.max(1, Math.round((img.height * width) / img.width)));
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); ctx.drawImage(img, 0, 0, width, height);
    const px = ctx.getImageData(0, 0, width, height).data;
    const bytes = new Uint8Array((width / 8) * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (lum < 140 && px[i + 3] > 60) bytes[y * (width / 8) + (x >> 3)] |= 0x80 >> (x & 7);
      ctx.fillStyle = lum < 140 && px[i + 3] > 60 ? '#000' : '#fff'; ctx.fillRect(x, y, 1, 1);
    }
    let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return { raster: { width, height, data: btoa(bin) }, preview: c.toDataURL('image/png') };
  } finally { URL.revokeObjectURL(url); }
}
