import { useEffect, useMemo, useRef, useState } from 'react';
import { addMoney, api, ApiError, Category, fmt, fmtQty, newIdempotencyKey, Order, OrderItem, Product, productImageUrl, qtyAtMostOne, stepQty, storage, time } from '../api';
import { useAuth } from '../auth';
import { useRealtime } from '../realtime';
import { Empty, ErrorBox, KeypadDialog, Modal, Spinner, useLoad, useNarrow, useRefresh, useToast } from '../ui';
import { pinApproval } from './ShiftQuick';
import { CashCalc, Checkout, Part } from './Checkout';

import { StornoFlow, TransferFlow } from './QtyFlows';
import { tableLabel } from './Tables';
import { fetchComputer, useComputer } from '../computer';


/** "BRZI": najčešće kucani artikli na ovom uređaju (brojač u pregledaču, bez servera). */
const QUICK_KEY = 'pos.quick';
const readQuick = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(QUICK_KEY) ?? '{}'); } catch { return {}; } };
const bumpQuick = (id: string) => {
  try { const q = readQuick(); q[id] = (q[id] ?? 0) + 1; localStorage.setItem(QUICK_KEY, JSON.stringify(q)); } catch { /* privatni režim */ }
};

type Dialog = null | 'void' | 'qty' | 'pendingQty' | 'exit' | 'options' | 'move' | 'merge' | 'mergeInto' | 'transfer' | 'voidAll' | 'newTab' | 'rename' | 'clearAll' | 'prev' | 'storno';

/**
 * Ekran kucanja: kategorije (dva reda pločica) i artikli sa slikama levo, račun desno.
 * Desno gore: sto / prethodne porudžbine / pregled / naplata. Gore u računu su nove (neposlate) stavke,
 * ispod "Na stolu do sada" sve što je već poslato. Crvena traka = iznos nove porudžbine.
 * Ture (podračuni) istog stola su tabovi ispod zaglavlja.
 */
export function OrderScreen({ orderId: initialId, onBack: exit }: { orderId: string; onBack: () => void }) {
  const toast = useToast();
  const { can, me } = useAuth();
  const { key } = useRefresh();
  const [orderId, setOrderId] = useState(initialId);
  const order = useLoad(() => api<Order>('GET', `/orders/${orderId}`), [orderId]);
  useRealtime({
    onEvent: (e) => {
      if ((e.type === 'order.prep.updated' || e.type === 'order.updated') && e.data?.orderId === orderId) {
        // starija verzija (odgovor koji je zakasnio) ne sme da pregazi noviji prikaz
        api<Order>('GET', `/orders/${orderId}`).then((n) => order.setData((cur) => (cur && cur.id === n.id && cur.version > n.version ? cur : n))).catch(() => undefined);
      }
    },
    onReconnect: () => { api<Order>('GET', `/orders/${orderId}`).then(order.setData).catch(() => undefined); },
  });
  const cats = useLoad(() => api<(Category & { prepStationId?: string | null })[]>('GET', '/categories'), [key]);
  // kategorije (pripremne pozicije: Šank, Kuhinja…) - uvek gore i uvek istim redom, grupe ispod poređane po kategoriji
  const stations = useLoad(() => api<{ id: string; name: string }[]>('GET', '/prep-stations').catch(() => []), [key]);
  const [station, setStation] = useState('');
  // BRZI: redosled se zamrzava pri otvaranju stola (inače bi se artikli pomerali posle svakog kucanja)
  const [quickSnap] = useState(readQuick);
  const comp = useComputer();
  // Cene na pločicama: cenovnik ove kase i happy hour (server ih isto primenjuje pri kucanju); van cenovnika se ne prikazuje.
  const prods = useLoad(async () => {
    const [r, k, comp, allCats] = await Promise.all([
      api<{ data: Product[] }>('GET', '/products?pageSize=5000&sellable=true'),
      api<{ prices: Record<string, string>; hidden: string[]; happy: string[] }>('GET', '/price-lists/kasa/prices').catch(() => null),
      fetchComputer(),
      api<(Category & { forSale?: boolean })[]>('GET', '/categories'),
    ]);
    // grupe skrivene na ovoj kasi (ADMIN → Računari) i grupe koje nisu za prodaju (sirovine) se ne prikazuju ni u pretrazi
    const groups = new Set([...comp.hiddenGroups, ...allCats.filter((c) => c.forSale === false).map((c) => c.id)]);
    r.data = r.data.filter((x) => !groups.has(x.categoryId));
    if (!k) return r.data;
    const hidden = new Set(k.hidden), happy = new Set(k.happy);
    return r.data.filter((x) => !hidden.has(x.id)).map((x) => ({ ...x, price: k.prices[x.id] ?? x.price, happy: happy.has(x.id) }));
  }, [key]);
  const o = order.data;
  const tabs = useLoad(() => (o?.tableId
    ? api<any[]>('GET', `/orders?status=OPEN&tableId=${o.tableId}&pageSize=50`).then((l) => [...l].sort((a, b) => a.number - b.number))
    : Promise.resolve([])), [o?.tableId, o?.version, key]);
  const [cat, setCat] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingQty, setPendingQty] = useState<string | null>(null);
  const [optionsFor, setOptionsFor] = useState<Product | null>(null);
  // Telefon / tablet uspravno: ARTIKLI i RAČUN kao dva taba, ostale radnje u meniju ☰ i donjoj traci.
  const narrow = useNarrow();
  const [mTab, setMTab] = useState<'items' | 'ticket'>('items');
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 20_000); return () => clearInterval(t); }, []);

  // Uvek poslednja poznata verzija računa i zaštita od duplog klika (stanje u ref-u, ne u closure-u).
  const oRef = useRef(o);
  oRef.current = o;
  const busyRef = useRef(false);

  /** Izlazak sa stola: račun bez ijedne stavke (ušao na sto i izašao) se zatvara - ne ostaje sto sa 0 RSD. */
  const onBack = () => {
    const cur = oRef.current;
    if (cur && cur.status === 'OPEN' && cur.items.length === 0 && cur.paidTotal === '0.00') {
      void api('POST', `/orders/${cur.id}/cancel`, { reason: 'Prazan račun - sto napušten', expectedVersion: cur.version }).catch(() => undefined).finally(exit);
    } else exit();
  };

  const editable = o?.status === 'OPEN';
  const live = o?.items.filter((i) => i.status !== 'VOIDED') ?? [];
  const fresh = o?.items.filter((i) => i.status === 'NEW') ?? [];
  const sent = o?.items.filter((i) => i.status !== 'NEW') ?? [];
  const selected = live.find((i) => i.id === selectedId) ?? null;
  const newCount = fresh.length;
  const newTotal = addMoney('0.00', ...fresh.map((i) => i.lineTotal));
  const sentTotal = addMoney('0.00', ...sent.filter((i) => i.status === 'SENT').map((i) => i.lineTotal));
  useEffect(() => { setSelectedId(null); setPendingQty(null); }, [orderId]);

  /** Svaka izmena šalje verziju koju korisnik vidi → server odbija ako je neko drugi u međuvremenu menjao. */
  const mutate = async (fn: (version: number) => Promise<Order>, okMsg?: string): Promise<Order | null> => {
    const cur = oRef.current;
    if (!cur || busyRef.current) return null;
    busyRef.current = true; setBusy(true);
    try {
      const next = await fn(cur.version);
      oRef.current = next;
      order.setData(next);
      if (okMsg) toast('ok', okMsg);
      return next;
    } catch (e) {
      const err = e as ApiError;
      toast('err', err.message);
      if (err.code === 'STALE_ORDER') order.reload();
      return null;
    } finally { busyRef.current = false; setBusy(false); }
  };

  /** Artikal sa opcijama izmene (iz ADMIN-a) prvo otvara prozor sa opcijama; ostali se dodaju odmah. */
  const add = (p: Product) => {
    if (p.noteOptions?.length) { setOptionsFor(p); return; }
    void addItem(p, '');
  };
  /** Isti artikal sa istom napomenom se sabira u postojeću neposlatu stavku; "Unesi količinu" pre artikla zadaje količinu. */
  const addItem = async (p: Product, note: string) => {
    const q = pendingQty ?? '1';
    setPendingQty(null);
    const same = oRef.current?.items.find((i) => i.status === 'NEW' && i.productId === p.id && (i.note ?? '') === note);
    const before = new Set(oRef.current?.items.map((i) => i.id));
    const next = same
      ? await mutate((v) => api('PATCH', `/orders/${orderId}/items/${same.id}`, { quantity: addQty(same.quantity, q), expectedVersion: v }))
      : await mutate((v) => api('POST', `/orders/${orderId}/items`, { productId: p.id, quantity: q, ...(note ? { note } : {}), expectedVersion: v }));
    if (!next) return;
    bumpQuick(p.id);
    setSelectedId(same ? same.id : (next.items.find((i) => !before.has(i.id))?.id ?? null));
  };

  /**
   * Polje iznad računa: "*espresso" traži artikle po nazivu/šifri; barkod ili tačna šifra + Enter dodaje artikal;
   * svaki drugi tekst + Enter je napomena (izmena) za izabranu ili poslednju neposlatu stavku - ide na bon u pripremi.
   * "-" + Enter briše napomenu.
   */
  const isSearch = search.startsWith('*');
  const noteTarget = (selected?.status === 'NEW' ? selected : null) ?? fresh[fresh.length - 1] ?? null;
  const onInputEnter = async () => {
    const text = search.trim();
    if (!text) return;
    if (isSearch) {
      if (visible.length === 1 && editable) { add(visible[0]); setSearch(''); }
      return;
    }
    const exact = prods.data?.find((p) => p.barcode === text || p.code.toLowerCase() === text.toLowerCase());
    if (exact && editable) { add(exact); setSearch(''); return; }
    if (!noteTarget) { toast('err', 'Prvo otkucajte artikal - napomena se upisuje na neposlatu stavku'); return; }
    const note = text === '-' ? '' : noteTarget.note ? `${noteTarget.note}, ${text}` : text;
    if (note.length > 200) { toast('err', 'Napomena je predugačka (najviše 200 znakova)'); return; }
    if (await setNote(noteTarget, note)) { setSearch(''); setSelectedId(noteTarget.id); }
  };
  const setQty = (i: OrderItem, q: string) => mutate((v) => api('PATCH', `/orders/${orderId}/items/${i.id}`, { quantity: q, expectedVersion: v }));
  const setNote = (i: OrderItem, note: string) => mutate((v) => api('PATCH', `/orders/${orderId}/items/${i.id}`, { note, expectedVersion: v }));
  const remove = async (i: OrderItem) => { if (await mutate((v) => api('DELETE', `/orders/${orderId}/items/${i.id}?expectedVersion=${v}`))) setSelectedId(null); };
  const clearAll = async () => {
    setDialog(null);
    for (const i of oRef.current?.items.filter((x) => x.status === 'NEW') ?? []) {
      if (!(await mutate((v) => api('DELETE', `/orders/${orderId}/items/${i.id}?expectedVersion=${v}`)))) break;
    }
    setSelectedId(null);
  };
  const send = () => mutate(async (v) => {
    const r = await api('POST', `/orders/${orderId}/send`, { expectedVersion: v });
    toast('ok', r.batch ? `Poslato u pripremu (tura ${r.batch}, ${r.sentItems.length} stavki)` : 'Nema novih stavki za slanje');
    return r.order;
  });
  /** SAČUVAJ: pošalji i nazad na mapu. SAČUVAJ I NOVI (brzi račun): pošalji i odmah otvori novi brzi račun. */
  // Brzi račun: SAČUVAJ odmah otvara naplatu (nema stola na koji bi se vratio).
  const save = async () => {
    const cur = oRef.current;
    if (cur && !cur.tableId && cur.items.length > 0) { if (newCount === 0 || (await send())) setPaying(true); return; }
    if (newCount === 0 || (await send())) onBack();
  };
  const saveAndNew = async () => {
    if (!oRef.current?.items.length) return toast('err', 'Nema stavki na računu');
    if (newCount > 0 && !(await send())) return;
    try {
      const n = await api<Order>('POST', '/orders', { idempotencyKey: newIdempotencyKey('open') });
      setSelectedId(null); setCat('ALL'); setSearch(''); setOrderId(n.id);
    } catch (e: any) { toast('err', e.message); }
  };
  // naplata ne kreće dok prozor izmena artikla (bez luka…) čeka odluku
  const sendAndPay = async () => { if (optionsFor) return; if (newCount === 0 || (await send())) setPaying(true); };
  const close = () => (editable && newCount > 0 ? setDialog('exit') : onBack());
  const newTab = async (tabName: string) => {
    setDialog(null);
    try {
      const n = await api<Order>('POST', '/orders', { tableId: o!.tableId, tabName: tabName || undefined, idempotencyKey: newIdempotencyKey('open') });
      setOrderId(n.id); tabs.reload();
    } catch (e: any) { toast('err', e.message); }
  };

  // + : neposlata stavka +1; poslata stavka → još jedna ista (nova porudžbina). − : −1, a na 1 uklanja stavku.
  const plus = () => {
    const i = selected ?? fresh[fresh.length - 1];
    if (!i) return;
    if (i.status === 'NEW') return setQty(i, stepQty(i.quantity, 1));
    const p = prods.data?.find((x) => x.id === i.productId);
    if (p) void add(p); else toast('err', 'Artikal više nije u ponudi');
  };
  const minus = () => {
    const i = selected ?? fresh[fresh.length - 1];
    if (!i || i.status !== 'NEW') return;
    if (qtyAtMostOne(i.quantity)) void remove(i); else void setQty(i, stepQty(i.quantity, -1));
  };
  /** Obriši stavku: izabrana neposlata (ili poslednja neposlata) se briše; poslata → storniranje (uz PIN). */
  const deleteSelected = () => {
    const i = selected ?? fresh[fresh.length - 1];
    if (!i) return toast('err', 'Nema neposlatih stavki - poslate se storniraju (STORNIRANJE)');
    if (i.status === 'NEW') return void remove(i);
    setDialog('storno');
  };
  const clearAllAsk = () => (newCount === 0 ? toast('err', 'Nema neposlatih stavki za brisanje') : setDialog('clearAll'));

  /** Brza naplata sa ekrana stola: GOTOVINA (mali kalkulator račun/dao/kusur) i KARTICA (ceo iznos odmah). */
  const [quickCash, setQuickCash] = useState(false);
  const [payKey, setPayKey] = useState(() => newIdempotencyKey('pay'));
  const [payError, setPayError] = useState<unknown>();
  const handlePaid = (next: Order) => {
    order.setData(next);
    if (next.status !== 'PAID') return;
    setPaying(false); setQuickCash(false);
    toast('ok', `Račun #${next.number} je zatvoren`);
    // fiskalni račun odmah na štampač ove kase (ADMIN → Podešavanje računara → Štampa)
    if (comp.print?.autoReceipt !== false) {
      api('POST', `/orders/${next.id}/print-receipt`, { idempotencyKey: newIdempotencyKey('auto') })
        .catch((e: ApiError) => { if (e.code !== 'NO_RECEIPT_PRINTER') toast('err', `Račun nije poslat na štampu: ${e.message}`); });
    }
    const rest = (tabs.data ?? []).filter((t: any) => t.id !== next.id);
    if (rest.length) { setOrderId(rest[0].id); tabs.reload(); } else exit();
  };
  const settle = async (parts: Part[]) => {
    const cur = oRef.current;
    if (!cur || busyRef.current) return;
    busyRef.current = true; setBusy(true); setPayError(undefined);
    try {
      const r = await api('POST', `/orders/${cur.id}/settle`, { parts, idempotencyKey: payKey, expectedVersion: cur.version });
      setPayKey(newIdempotencyKey('pay'));
      const ch = r.payments.find((p: any) => p.change !== '0.00')?.change;
      if (ch) toast('ok', `Vratiti kusur: ${fmt(ch)}`);
      handlePaid(r.order);
    } catch (e) {
      setPayError(e); toast('err', (e as ApiError).message);
      if ((e as ApiError).code === 'STALE_ORDER') { order.reload(); setPayKey(newIdempotencyKey('pay')); }
    } finally { busyRef.current = false; setBusy(false); }
  };
  const quickPay = async (method: 'CASH' | 'CARD') => {
    if (!can('payment.create')) return toast('err', 'Nemate pravo naplate');
    if (!oRef.current?.items.length) return toast('err', 'Nema stavki na računu');
    if (newCount > 0 && !(await send())) return;
    if ((oRef.current?.remaining ?? '0.00') === '0.00') return toast('err', 'Nema ništa za naplatu');
    if (method === 'CASH') { setPayError(undefined); setQuickCash(true); } else void settle([{ method: 'CARD' }]);
  };
  const enterQty = () => (selected?.status === 'NEW' ? setDialog('qty') : setDialog('pendingQty'));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (dialog || paying || optionsFor || quickCash || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'F9' && editable) { e.preventDefault(); sendAndPay(); }
      if (e.key === '+' && editable) { e.preventDefault(); plus(); }
      if (e.key === '-' && editable) { e.preventDefault(); minus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const stOrder = (id: string | null | undefined) => { const i = (stations.data ?? []).findIndex((x) => x.id === id); return i < 0 ? 999 : i; };
  const allActive = useMemo(() => (cats.data ?? []).filter((c) => c.active && prods.data?.some((p) => p.categoryId === c.id))
    .map((c, i) => ({ c, i })).sort((a, b) => stOrder(a.c.prepStationId) - stOrder(b.c.prepStationId) || a.i - b.i).map((x) => x.c), [cats.data, prods.data, stations.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const usedStations = (stations.data ?? []).filter((x) => allActive.some((c) => c.prepStationId === x.id));
  const activeCats = station ? allActive.filter((c) => c.prepStationId === station) : allActive;
  const visible = useMemo(() => {
    const all = prods.data ?? [];
    const term = search.startsWith('*') ? search.slice(1).trim().toLowerCase() : '';
    if (term) return all.filter((p) => p.name.toLowerCase().includes(term) || p.code.toLowerCase().includes(term) || p.barcode === term);
    if (cat === 'QUICK') {
      const q = quickSnap;
      return all.filter((p) => q[p.id]).sort((a, b) => q[b.id] - q[a.id]).slice(0, 40);
    }
    if (cat !== 'ALL') return all.filter((p) => p.categoryId === cat);
    // SVE: prvo artikli prve kategorije (npr. Šank) po redu grupa, pa druge (Kuhinja) - pregledno, kao dugmad grupa
    const pos = new Map(activeCats.map((c, i) => [c.id, i]));
    return all.filter((p) => pos.has(p.categoryId)).map((p, i) => ({ p, i })).sort((x, y) => pos.get(x.p.categoryId)! - pos.get(y.p.categoryId)! || x.i - y.i).map((x) => x.p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prods.data, cat, search, o?.version, station, allActive]);

  if (order.loading && !o) return <Spinner label="Učitavam račun…" />;
  if (order.error) return <div className="page"><ErrorBox error={order.error} onRetry={order.reload} /><button className="btn" onClick={onBack}>Nazad</button></div>;
  if (!o) return null;

  const canPay = can('payment.create') && o.remaining !== '0.00';
  const isMine = o.waiterId === me?.user.userId;
  const otherTabs = (tabs.data ?? []).filter((t) => t.id !== o.id);
  const label = o.tableName ? tableLabel(o.tableName) : 'BRZI';
  const catColor = (id: string) => cats.data?.find((c) => c.id === id)?.color ?? undefined;

  return (
    <div className={`k-till ${narrow ? `mobile show-${mTab}` : ''}`}>
      {narrow && (
        <>
          <header className="k-mhead">
            <button className="k-mh-btn" onClick={close} aria-label="Zatvori sto">✕</button>
            <div className="k-mh-title"><b>{label}</b><small>{o.waiterName} · #{o.number}</small></div>
            <div className="k-mh-sum">{fmt(o.remaining)}</div>
            <button className="k-mh-btn" onClick={() => setMenu(true)} aria-label="Meni">☰</button>
          </header>
          <div className="k-mtabs" role="tablist">
            <button role="tab" aria-selected={mTab === 'items'} className={mTab === 'items' ? 'on' : ''} onClick={() => setMTab('items')}>ARTIKLI</button>
            <button role="tab" aria-selected={mTab === 'ticket'} className={mTab === 'ticket' ? 'on' : ''} onClick={() => setMTab('ticket')}>RAČUN{live.length ? ` (${live.length})` : ''}{newCount ? ` · novo ${newCount}` : ''}</button>
          </div>
        </>
      )}
      {/* Kategorije i artikli */}
      <section className="k-catalog">
        {usedStations.length > 1 && (
          <div className="k-stations">
            <button className={`k-station ${!station ? 'on' : ''}`} onClick={() => { setStation(''); if (cat !== 'QUICK') setCat('ALL'); }}>SVE</button>
            {usedStations.map((x) => <button key={x.id} className={`k-station ${station === x.id ? 'on' : ''}`} onClick={() => { setStation(x.id); setSearch(''); setCat('ALL'); }}>{x.name}</button>)}
          </div>
        )}
        <div className="k-cats">
          <button className={`k-cat plain ${cat === 'QUICK' && !isSearch ? 'on' : ''}`} onClick={() => { if (isSearch) setSearch(''); setCat('QUICK'); }}>BRZI</button>
          <button className={`k-cat plain ${cat === 'ALL' && !isSearch ? 'on' : ''}`} onClick={() => { if (isSearch) setSearch(''); setCat('ALL'); }}>SVI</button>
          {activeCats.map((c) => (
            <button key={c.id} className={`k-cat ${cat === c.id && !isSearch ? 'on' : ''}`} style={{ ['--tile' as any]: c.color ?? '#3b7bbf' }}
              onClick={() => { if (isSearch) setSearch(''); setCat(c.id); }}>{c.name}</button>
          ))}
        </div>
        <div className="k-products">
          {prods.loading && !prods.data ? <Spinner /> : prods.error ? <ErrorBox error={prods.error} onRetry={prods.reload} /> :
            visible.length === 0 ? <Empty>{cat === 'QUICK' && !isSearch ? 'Ovde se pojavljuju artikli koji se najčešće kucaju na ovoj kasi.' : 'Nema artikala.'}</Empty> : (
              <div className="k-pgrid">
                {visible.map((p) => {
                  const img = productImageUrl(p);
                  return (
                    <button key={p.id} className={`k-prod ${img ? 'img' : ''}`} disabled={!editable || busy} onClick={() => add(p)}
                      style={{ ['--bar' as any]: p.color ?? catColor(p.categoryId) ?? 'transparent' }}>
                      {img && <img src={img} alt="" loading="lazy" draggable={false} />}
                      <span className="k-prod-name">{p.name} <span className={`k-prod-price ${(p as any).happy ? 'happy' : ''}`}>({fmt(p.price)})</span></span>
                    </button>
                  );
                })}
              </div>
            )}
        </div>
        {editable && (
          <div className="k-actbar">
            {comp.on('cash') && <button className="k-act cash" disabled={busy || !can('payment.create')} onClick={() => quickPay('CASH')}>GOTOVINA</button>}
            {comp.on('card') && <button className="k-act kcard" disabled={busy || !can('payment.create')} onClick={() => quickPay('CARD')}>KARTICA</button>}
            {comp.on('transfer') && <button className="k-act move" disabled={busy || !editable} onClick={() => setDialog('move')}>PREBACIVANJE</button>}
            {comp.on('storno') && <button className="k-act void" disabled={busy} onClick={() => setDialog('storno')}>STORNIRANJE</button>}
          </div>
        )}
      </section>

      {/* Račun */}
      <aside className="k-ticket">
        <div className="k-top">
          <div className="k-topbtn k-table-label" title="Sto">{label}</div>
          <button className="k-topbtn" onClick={() => setDialog('prev')} disabled={sent.length === 0}>PRETH. PORUDŽ.</button>
          <button className="k-topbtn red" disabled={busy || !canPay || !editable} onClick={sendAndPay} title="F9">NAPLATA</button>
        </div>
        <button className="k-review" onClick={() => setDialog('options')} title="Prebacivanje, spajanje, ture, storno računa">PREGLED · opcije stola</button>
        <div className="k-search">
          <input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={120}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onInputEnter(); } else if (e.key === 'Escape') { e.preventDefault(); setSearch(''); } }}
            placeholder="Napomena (Enter)  ·  *naziv = pretraga" aria-label="Napomena za stavku ili pretraga artikala (počnite sa *)" />
          {search.trim() && (
            <div className={`k-search-hint ${isSearch ? 'find' : ''}`}>
              {isSearch ? `Pronađeno: ${visible.length}${visible.length === 1 ? ' - Enter dodaje artikal' : ''}`
                : noteTarget ? <>Enter → napomena za <b>{noteTarget.name}</b>{search.trim() === '-' ? ' (briše napomenu)' : ''}</>
                  : 'Prvo otkucajte artikal, pa napomenu'}
            </div>
          )}
          {pendingQty && <button className="k-pending" onClick={() => setPendingQty(null)} title="Poništi količinu">× {pendingQty.replace('.', ',')}</button>}
        </div>

        <div className="k-head">
          <div className="k-head-row"><span>{time(clock.toISOString())}</span>{o.status !== 'OPEN' && <span className="k-head-badge">{o.status === 'PAID' ? 'NAPLAĆEN' : o.status}</span>}</div>
          <div>{o.waiterName}{!isMine && <em> (nije vaš)</em>}</div>
          <div className="k-head-row"><strong>{label}{o.tabName ? ` · ${o.tabName}` : ''}</strong><span>#{o.number}</span></div>
        </div>
        {o.tableId && (otherTabs.length > 0 || editable) && (
          <div className="k-tabs" role="tablist" aria-label="Ture na stolu">
            {(tabs.data ?? [o]).map((t: any) => (
              <button key={t.id} role="tab" aria-selected={t.id === o.id} className={`k-tab ${t.id === o.id ? 'on' : ''}`}
                onClick={() => t.id !== o.id && setOrderId(t.id)} onDoubleClick={() => t.id === o.id && editable && setDialog('rename')}>
                {t.tabName || `#${t.number}`} <small>{fmt(t.total)}</small>
              </button>
            ))}
            {editable && <button className="k-tab add" onClick={() => setDialog('newTab')} title="Nova tura (podračun) na ovom stolu">+ Tura</button>}
          </div>
        )}

        <div className="k-lines" role="listbox" aria-label="Stavke računa">
          {fresh.map((i) => <Line key={i.id} i={i} sel={selectedId === i.id} onPick={() => setSelectedId(selectedId === i.id ? null : i.id)} />)}
          {fresh.length === 0 && sent.length === 0 && <div className="k-hint">Dodirnite artikal da ga dodate.</div>}
          {sent.length > 0 && (
            <>
              <div className="k-sent-head">Na stolu do sada</div>
              {sent.map((i) => <Line key={i.id} i={i} sent sel={selectedId === i.id} onPick={() => i.status !== 'VOIDED' && setSelectedId(selectedId === i.id ? null : i.id)} />)}
              <div className="k-sent-sum">
                <div><span>Ukupno:</span> <strong>{fmt(sentTotal)}</strong></div>
                {o.discountTotal !== '0.00' && <div><span>Popust {o.discountPercent.replace(/\.00$/, '')}%:</span> <strong>−{fmt(o.discountTotal)}</strong></div>}
                {o.paidTotal !== '0.00' && <div><span>Naplaćeno:</span> <strong>{fmt(o.paidTotal)}</strong></div>}
                {(o.discountTotal !== '0.00' || o.paidTotal !== '0.00' || newCount > 0) && <div><span>Za naplatu (sve):</span> <strong>{fmt(o.remaining)}</strong></div>}
              </div>
            </>
          )}
        </div>


        <div className="k-total" aria-label="Iznos nove porudžbine">{fmt(newTotal)}</div>

        {editable ? (
          <div className="k-keys">
            <button className="k-key black" disabled={busy || (!selected && !fresh.length)} onClick={plus} aria-label="Povećaj">+</button>
            <button className="k-key black" disabled={busy || !(selected ?? fresh[fresh.length - 1]) || (selected ? selected.status !== 'NEW' : false)} onClick={minus} aria-label="Smanji">−</button>
            <button className="k-key red" disabled={busy} onClick={deleteSelected}>{selected?.status === 'SENT' ? 'STORNO STAVKE' : 'OBRIŠI STAVKU'}</button>
            <button className="k-key red" disabled={busy} onClick={clearAllAsk}>OBRIŠI SVE</button>
            {!o.tableId && <button className="k-key blue" disabled={busy || o.items.length === 0} onClick={saveAndNew}>SAČUVAJ I NOVI</button>}
            <button className={`k-key blue ${o.tableId ? 'span2' : ''}`} disabled={busy} onClick={save}>SAČUVAJ</button>
            <button className="k-key red" disabled={busy} onClick={enterQty}>UNESI KOLIČINU</button>
            <button className="k-key red" disabled={busy} onClick={close}>ZATVORI</button>
          </div>
        ) : (
          <div className="k-keys"><button className="k-key blue wide" onClick={onBack}>NAZAD NA STOLOVE</button></div>
        )}
      </aside>

      {narrow && (
        <nav className="k-mbar" aria-label="Brze radnje">
          <button className="k-mb blue" disabled={busy || !editable} onClick={save}>SAČUVAJ</button>
          {comp.on('cash') && <button className="k-mb green" disabled={busy || !editable || !can('payment.create')} onClick={() => quickPay('CASH')}>GOTOVINA</button>}
          {comp.on('card') && <button className="k-mb blue" disabled={busy || !editable || !can('payment.create')} onClick={() => quickPay('CARD')}>KARTICA</button>}
          <button className="k-mb red" disabled={busy || !canPay || !editable} onClick={sendAndPay}>NAPLATA</button>
        </nav>
      )}
      {narrow && menu && (
        <div className="k-msheet-back" onMouseDown={(e) => e.target === e.currentTarget && setMenu(false)}>
          <div className="k-msheet" role="menu" aria-label="Meni stola">
            {[
              ['PRETHODNE PORUDŽBINE', () => setDialog('prev'), sent.length === 0],
              ...(comp.on('transfer') ? [['PREBACIVANJE', () => setDialog('move'), !editable]] : []),
              ...(comp.on('storno') ? [['STORNIRANJE', () => setDialog('storno'), !editable]] : []),
              ['UNESI KOLIČINU', enterQty, !editable],
              ['OBRIŠI SVE NEPOSLATO', clearAllAsk, !editable],
              ...(o.tableId ? [] : [['SAČUVAJ I NOVI', saveAndNew, !editable || o.items.length === 0]]),
              ['OPCIJE STOLA (ture, spajanje)', () => setDialog('options'), !editable],
              ['ZATVORI STO', close, false],
            ].map(([label, fn, dis]: any) => (
              <button key={label} role="menuitem" className="k-msheet-item" disabled={dis} onClick={() => { setMenu(false); fn(); }}>{label}</button>
            ))}
          </div>
        </div>
      )}
      {paying && <Checkout order={o} onClose={() => { setPaying(false); order.reload(); }} onPaid={handlePaid} />}
      {quickCash && <CashCalc mode="CASH" due={o.remaining} busy={busy} error={payError} onClose={() => setQuickCash(false)} onPay={settle} />}
      {dialog === 'storno' && <StornoFlow order={o} onClose={() => setDialog(null)} onDone={(next, msg) => { setDialog(null); order.setData(next); toast('ok', msg); }} />}

      {optionsFor && <OptionsDialog product={optionsFor} onClose={() => setOptionsFor(null)} onConfirm={(note) => { const p = optionsFor; setOptionsFor(null); void addItem(p, note); }} />}
      {dialog === 'options' && (
        <Modal title={`${o.tableName ?? 'Brzi račun'} - račun #${o.number}`} onClose={() => setDialog(null)}>
          <div className="opt-grid">
            <button className="opt" onClick={() => setDialog('move')} disabled={!editable}>
              <strong>Prebacivanje</strong><span>Ceo sto, pojedini artikli ili drugom konobaru (PIN)</span></button>
            {o.tableId && <button className="opt" onClick={() => setDialog('merge')} disabled={!editable || otherTabs.length === 0}>
              <strong>Spoji ture</strong><span>Druge ture ovog stola u ovaj račun</span></button>}
            <button className="opt" onClick={() => setDialog('mergeInto')} disabled={!editable || o.paidTotal !== '0.00'}>
              <strong>Spoji porudžbinu</strong><span>Ovaj račun (turu) spoji sa otvorenim računom drugog stola ili ture</span></button>
            {o.tableId && <button className="opt" onClick={() => setDialog('newTab')} disabled={!editable}>
              <strong>Nova tura</strong><span>Poseban podračun na istom stolu</span></button>}
            {o.tableId && <button className="opt" onClick={() => setDialog('rename')} disabled={!editable}>
              <strong>Naziv ture</strong><span>{o.tabName ?? 'npr. Pera, Mika'}</span></button>}
            <button className="opt danger" onClick={() => setDialog('voidAll')} disabled={!editable || o.paidTotal !== '0.00'}>
              <strong>Storno računa</strong><span>Stornira sve stavke - uz razlog i PIN</span></button>
          </div>
        </Modal>
      )}
      {dialog === 'prev' && <PrevOrders order={o} onClose={() => setDialog(null)} />}
      {dialog === 'clearAll' && (
        <Modal title="Brisanje nove porudžbine" onClose={() => setDialog(null)}>
          <p>Brišu se sve neposlate stavke ({newCount}). Poslate stavke ostaju na stolu.</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setDialog(null)}>Odustani</button>
            <button className="btn danger" onClick={clearAll}>Obriši sve</button>
          </div>
        </Modal>
      )}
      {dialog === 'pendingQty' && <NumberDialog title="Količina za sledeći artikal" onClose={() => setDialog(null)} onSave={(q) => { setDialog(null); setPendingQty(q); }} />}
      {dialog === 'move' && <TransferFlow order={o} onClose={() => setDialog(null)} onDone={async (msg) => {
        setDialog(null); toast('ok', msg);
        const n = await api<Order>('GET', `/orders/${o.id}`).catch(() => null);
        if (!n || n.status !== 'OPEN') return exit();
        order.setData(n); tabs.reload();
      }} />}
      {dialog === 'mergeInto' && <MergeIntoDialog order={o} onClose={() => setDialog(null)} onDone={(t) => {
        setDialog(null); toast('ok', `Porudžbina je spojena sa: ${t}`);
        if (otherTabs.length) { setOrderId(otherTabs[0].id); tabs.reload(); } else exit();
      }} />}
      {dialog === 'merge' && <MergeDialog order={o} tabs={otherTabs} onClose={() => setDialog(null)} onDone={(next) => {
        setDialog(null); order.setData(next); tabs.reload(); toast('ok', 'Ture su spojene');
      }} />}
      {dialog === 'voidAll' && <VoidDialog title={`Storno celog računa #${o.number}`} onClose={() => setDialog(null)} onConfirm={async (reason, token, who) => {
        setDialog(null);
        const r = await mutate((v) => api('POST', `/orders/${orderId}/void-all`, { reason, expectedVersion: v }, token), `Račun je storniran (odobrio: ${who})`);
        if (r) { if (otherTabs.length) setOrderId(otherTabs[0].id); else onBack(); }
      }} />}
      {(dialog === 'newTab' || dialog === 'rename') && <TabNameDialog initial={dialog === 'rename' ? o.tabName ?? '' : ''}
        title={dialog === 'rename' ? 'Naziv ture' : 'Nova tura na stolu'} onClose={() => setDialog(null)}
        onSave={async (name) => {
          if (dialog === 'newTab') return newTab(name);
          setDialog(null);
          await mutate(() => api('PATCH', `/orders/${orderId}`, { tabName: name }));
          tabs.reload();
        }} />}
      {dialog === 'void' && selected && <VoidDialog title={`Storno: ${selected.name}`} onClose={() => setDialog(null)} onConfirm={(reason, token, who) => {
        setDialog(null);
        mutate((v) => api('POST', `/orders/${orderId}/items/${selected.id}/void`, { reason, expectedVersion: v }, token), `Stavka stornirana (odobrio: ${who})`);
      }} />}
      {dialog === 'qty' && selected && <QtyDialog item={selected} onClose={() => setDialog(null)} onSave={(q) => { setDialog(null); setQty(selected, q); }} />}
      {dialog === 'exit' && (
        <Modal title="Neposlate stavke" onClose={() => setDialog(null)}>
          <p>Na računu ima {newCount} stavki koje nisu sačuvane (poslate u pripremu).</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setDialog(null)}>Odustani</button>
            <button className="btn" onClick={() => { setDialog(null); onBack(); }}>Izađi bez slanja</button>
            <button className="btn primary" onClick={() => { setDialog(null); save(); }}>Sačuvaj i izađi</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Zbir količina sa najviše 3 decimale (celobrojno u hiljaditim delovima). */
function addQty(a: string, b: string) {
  const m = (s: string) => Math.round(Number(s) * 1000);
  const t = m(a) + m(b);
  return (t / 1000).toFixed(3).replace(/\.?0+$/, '');
}

function Line({ i, sel, sent, onPick }: { i: OrderItem; sel: boolean; sent?: boolean; onPick: () => void }) {
  return (
    <button role="option" aria-selected={sel} className={`k-line ${sent ? 'sent' : ''} ${i.status === 'VOIDED' ? 'voided' : ''} ${sel ? 'sel' : ''}`}
      onClick={onPick} disabled={i.status === 'VOIDED'}>
      <span className="k-line-name">{i.name}
        {i.note && <small className="k-line-note">{i.note}</small>}
        {i.status === 'VOIDED' && <small className="k-line-void">storno: {i.voidReason}</small>}
        {i.status === 'SENT' && i.prepStationName && (
          <small className={`prep ${(i.prepStatus ?? 'new').toLowerCase()}`} title={`Pripremna pozicija: ${i.prepStationName}`}>
            {i.prepStationName}: {PREP_LABEL[i.prepStatus ?? 'NEW'] ?? i.prepStatus}
          </small>
        )}
      </span>
      <span className="k-line-qty">{fmtQty(i.quantity)}</span>
      <span className="k-line-sum">{fmt(i.lineTotal)}</span>
    </button>
  );
}

/** Prethodne porudžbine na stolu: poslate stavke po turama slanja. */
function PrevOrders({ order, onClose }: { order: Order; onClose: () => void }) {
  const batches = [...new Set(order.items.filter((i) => i.sendBatch).map((i) => i.sendBatch!))].sort((a, b) => b - a);
  return (
    <Modal title={`Prethodne porudžbine - ${order.tableName ?? 'Brzi račun'} #${order.number}`} onClose={onClose} wide>
      {batches.length === 0 ? <Empty>Još ništa nije poslato.</Empty> : batches.map((b) => {
        const items = order.items.filter((i) => i.sendBatch === b);
        return (
          <section key={b} className="card">
            <h3>Porudžbina {b}</h3>
            <table className="tbl"><tbody>
              {items.map((i) => (
                <tr key={i.id} className={i.status === 'VOIDED' ? 'voided' : ''}>
                  <td>{i.name}{i.note && <div className="muted small">{i.note}</div>}</td>
                  <td className="num">{fmtQty(i.quantity)}</td><td className="num">{fmt(i.lineTotal)}</td>
                  <td className="muted small">{i.status === 'VOIDED' ? `storno: ${i.voidReason}` : i.prepStationName ? `${i.prepStationName}: ${PREP_LABEL[i.prepStatus ?? 'NEW']}` : ''}</td>
                </tr>
              ))}
              <tr className="strong"><td>Ukupno</td><td /><td className="num">{fmt(addMoney('0.00', ...items.filter((i) => i.status !== 'VOIDED').map((i) => i.lineTotal)))}</td><td /></tr>
            </tbody></table>
          </section>
        );
      })}
    </Modal>
  );
}




function MergeDialog({ order, tabs, onClose, onDone }: { order: Order; tabs: any[]; onClose: () => void; onDone: (o: Order) => void }) {
  const [sel, setSel] = useState<string[]>(tabs.filter((t) => t.paidTotal === '0.00').map((t) => t.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async () => {
    setBusy(true); setError(undefined);
    try { onDone(await api<Order>('POST', `/orders/${order.id}/merge`, { fromOrderIds: sel })); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Spajanje tura u: ${order.tabName || `#${order.number}`}`} onClose={onClose}>
      <p className="muted">Sve stavke izabranih tura prelaze na ovaj račun, koji se zatim naplaćuje u celosti.</p>
      <div className="pick-list">
        {tabs.map((t) => (
          <label key={t.id} className={`pick ${sel.includes(t.id) ? 'on' : ''}`}>
            <input type="checkbox" disabled={t.paidTotal !== '0.00'} checked={sel.includes(t.id)}
              onChange={() => setSel((x) => (x.includes(t.id) ? x.filter((y) => y !== t.id) : [...x, t.id]))} />
            <span className="pick-main"><strong>{t.tabName || `#${t.number}`}</strong> · {t.waiterName}{t.paidTotal !== '0.00' ? ' - ima naplatu, ne može' : ''}</span>
            <span className="num">{fmt(t.total)}</span>
          </label>
        ))}
      </div>
      {error !== undefined && <ErrorBox error={error} />}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Odustani</button>
        <button className="btn primary" disabled={busy || sel.length === 0} onClick={submit}>Spoji ({sel.length})</button>
      </div>
    </Modal>
  );
}

/** Spoji porudžbinu: ova tura/račun prelazi u izabrani otvoren račun (drugi sto ili druga tura). */
function MergeIntoDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (target: string) => void }) {
  const list = useLoad(() => api<any[]>('GET', '/orders?status=OPEN&pageSize=500').then((l) => l.filter((x) => x.id !== order.id)), [order.id]);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const name = (t: any) => `${t.tableName ? tableLabel(t.tableName) : 'Brzi'}${t.tabName ? ` · ${t.tabName}` : ''} · #${t.number}`;
  const rows = [...(list.data ?? [])].sort((a, b) => String(a.tableName ?? '').localeCompare(String(b.tableName ?? ''), 'sr', { numeric: true }) || a.number - b.number);
  const submit = async () => {
    const t = rows.find((x) => x.id === sel); if (!t) return;
    setBusy(true); setError(undefined);
    try { await api('POST', `/orders/${t.id}/merge`, { fromOrderIds: [order.id] }); onDone(name(t)); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Spoji porudžbinu #${order.number}${order.tabName ? ` (${order.tabName})` : ''} sa…`} onClose={onClose}>
      <p className="muted">Sve stavke ovog računa prelaze na izabrani račun; ovaj se zatvara.</p>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox error={list.error} /> : (
        <div className="pick-list">
          {rows.length === 0 && <p className="muted">Nema drugih otvorenih računa.</p>}
          {rows.map((t) => (
            <label key={t.id} className={`pick ${sel === t.id ? 'on' : ''}`}>
              <input type="radio" name="mergeInto" checked={sel === t.id} onChange={() => setSel(t.id)} />
              <span className="pick-main"><strong>{name(t)}</strong> · {t.waiterName}</span>
              <span className="num">{fmt(t.total)}</span>
            </label>
          ))}
        </div>
      )}
      {error !== undefined && <ErrorBox error={error} />}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Odustani</button>
        <button className="btn primary" disabled={busy || !sel} onClick={submit}>Spoji</button>
      </div>
    </Modal>
  );
}

function TabNameDialog({ title, initial, onClose, onSave }: { title: string; initial: string; onClose: () => void; onSave: (n: string) => void }) {
  const [name, setName] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onSave(name.trim()); }}>
        <input className="input" autoFocus value={name} maxLength={40} placeholder="npr. Pera, Mika (opciono)" onChange={(e) => setName(e.target.value)} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
          <button className="btn primary">Potvrdi</button>
        </div>
      </form>
    </Modal>
  );
}



const PREP_LABEL: Record<string, string> = { NEW: 'primljeno', IN_PROGRESS: 'u pripremi', READY: 'spremno', DONE: 'izdato' };

const QTY_OK = (v: string) => /^\d{1,6}(\.\d{1,3})?$/.test(v) && Number(v) > 0;

function NumberDialog({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (q: string) => void }) {
  return <KeypadDialog title={title} hint="Unesite količinu, pa dodirnite artikal." decimal onClose={onClose} onConfirm={(v) => QTY_OK(v) && onSave(v)} />;
}

function QtyDialog({ item, onClose, onSave }: { item: OrderItem; onClose: () => void; onSave: (q: string) => void }) {
  return <KeypadDialog title={`Količina: ${item.name}`} hint={`Trenutno: ${fmtQty(item.quantity)}`} decimal onClose={onClose} onConfirm={(v) => QTY_OK(v) && onSave(v)} />;
}

/** Storno: razlog jednim dodirom i PIN zaposlenog koji ima pravo storniranja (može i prijavljeni). */
export function VoidDialog({ title, onClose, onConfirm }: { title: string; onClose: () => void; onConfirm: (reason: string, token: string, who: string) => void }) {
  const { me } = useAuth();
  const presets = ['Pogrešno uneto', 'Gost odustao', 'Reklamacija', 'Gost otišao'];
  const [reason, setReason] = useState(presets[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const confirm = async (pin: string) => {
    setBusy(true); setError(null);
    try {
      // ko ima pravo storniranja samo potvrđuje; ostali kucaju šifru nekoga ko ima pravo
      if (!pin && me?.user.permissions.includes('order.void')) { onConfirm(reason, storage.token!, me.user.fullName); return; }
      const a = await pinApproval(pin, 'order.void', storage.deviceId ?? me?.user.deviceId); onConfirm(reason, a.token, a.name);
    }
    catch (e) { setError(e); setBusy(false); }
  };
  return (
    <KeypadDialog title={title} hint={me?.user.permissions.includes('order.void') ? 'Imate pravo storniranja: razlog i Storniraj (šifra nije potrebna)' : 'Razlog storna, pa PIN (menadžer ili ko ima pravo storniranja)'} secret minLen={me?.user.permissions.includes('order.void') ? 0 : 1} busy={busy} error={error}
      confirmLabel="Storniraj" onClose={onClose} onConfirm={confirm}>
      <div className="kp-chips">
        {presets.map((p) => <button key={p} type="button" className={`kp-chip ${reason === p ? 'on' : ''}`} onClick={() => setReason(p)}>{p}</button>)}
      </div>
    </KeypadDialog>
  );
}

/**
 * Izmene artikla (definisane u ADMIN-u, npr. "bez leda", "bez voća", "bez čaše") - veliki prozor odmah po kucanju.
 * Izabrane izmene postaju napomena stavke i štampaju se na bonu u pripremi.
 */
function OptionsDialog({ product, onClose, onConfirm }: { product: Product; onClose: () => void; onConfirm: (note: string) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const toggle = (o: string) => setSel((s) => (s.includes(o) ? s.filter((x) => x !== o) : [...s, o]));
  const options = product.noteOptions ?? [];
  // izabrane idu redom kako su definisane u ADMIN-u
  const note = options.filter((o) => sel.includes(o)).join(', ');
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Enter') { e.preventDefault(); onConfirm(note); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  return (
    <div className="k-opt-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="k-opt" role="dialog" aria-modal="true" aria-label={`Izmene: ${product.name}`}>
        <div className="k-opt-title">{product.name} <span>({fmt(product.price)})</span></div>
        <div className="k-opt-grid">
          {options.map((o) => (
            <button key={o} type="button" className={`k-opt-btn ${sel.includes(o) ? 'on' : ''}`} aria-pressed={sel.includes(o)} onClick={() => toggle(o)}>{o}</button>
          ))}
        </div>
        <div className="k-opt-note">{note ? <>Napomena: <b>{note}</b></> : 'Izaberite izmene ili dodajte bez izmena.'}</div>
        <div className="k-opt-actions">
          <button type="button" className="kp-btn ok" onClick={() => onConfirm(note)}>Potvrdi{sel.length ? ` (${sel.length})` : ''}</button>
          <button type="button" className="kp-btn plain" onClick={() => onConfirm('')}>Bez izmena</button>
          <button type="button" className="kp-btn cancel" onClick={onClose}>Odustani</button>
        </div>
      </div>
    </div>
  );
}
