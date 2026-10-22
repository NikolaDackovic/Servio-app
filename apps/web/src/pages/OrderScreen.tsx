import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, Category, fmt, fmtQty, newIdempotencyKey, Order, OrderItem, Product, qtyAtMostOne, stepQty, Table } from '../api';
import { useAuth } from '../auth';
import { useRealtime } from '../realtime';
import { Empty, ErrorBox, Keypad, Modal, Spinner, useLoad, useRefresh, useToast } from '../ui';
import { Checkout } from './Checkout';
import { TransferDialog } from './MyShift';

const STATUS_LABEL = { OPEN: 'Otvoren', PAID: 'Plaćen', CANCELLED: 'Otkazan', MERGED: 'Spojen' } as const;
const NOTE_PRESETS = ['Bez leda', 'Sa ledom', 'Bez šećera', 'Sa limunom', 'Dobro pečeno', 'Bez luka', 'Ljuto', 'Za poneti'];

/**
 * Ekran stola / računa (ceo ekran): kategorije i artikli levo, račun desno.
 * Ture (podračuni) istog stola su tabovi; svaka tura se naplaćuje posebno, ili se spajaju.
 */
export function OrderScreen({ orderId: initialId, onBack }: { orderId: string; onBack: () => void }) {
  const toast = useToast();
  const { can, me } = useAuth();
  const { key } = useRefresh();
  const [orderId, setOrderId] = useState(initialId);
  const order = useLoad(() => api<Order>('GET', `/orders/${orderId}`), [orderId]);
  // Status pripreme (KDS) i izmene sa drugih uređaja stižu u realnom vremenu — tiho osvežavanje bez treperenja.
  useRealtime({
    onEvent: (e) => {
      if ((e.type === 'order.prep.updated' || e.type === 'order.updated') && e.data?.orderId === orderId) {
        // starija verzija (odgovor koji je zakasnio) ne sme da pregazi noviji prikaz
        api<Order>('GET', `/orders/${orderId}`).then((n) => order.setData((cur) => (cur && cur.id === n.id && cur.version > n.version ? cur : n))).catch(() => undefined);
      }
    },
    onReconnect: () => { api<Order>('GET', `/orders/${orderId}`).then(order.setData).catch(() => undefined); },
  });
  const cats = useLoad(() => api<Category[]>('GET', '/categories'), [key]);
  const prods = useLoad(() => api<{ data: Product[] }>('GET', '/products?pageSize=500&sellable=true').then((r) => r.data), [key]);
  const o = order.data;
  const tabs = useLoad(() => (o?.tableId
    ? api<any[]>('GET', `/orders?status=OPEN&tableId=${o.tableId}&pageSize=50`).then((l) => [...l].sort((a, b) => a.number - b.number))
    : Promise.resolve([])), [o?.tableId, o?.version, key]);
  const [cat, setCat] = useState<string | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'void' | 'qty' | 'exit' | 'options' | 'move' | 'merge' | 'transfer' | 'voidAll' | 'newTab' | 'rename'>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  const editable = o?.status === 'OPEN';
  const selected = o?.items.find((i) => i.id === selectedId && i.status !== 'VOIDED') ?? null;
  const newCount = o?.items.filter((i) => i.status === 'NEW').length ?? 0;
  useEffect(() => { setSelectedId(null); }, [orderId]);

  /** Svaka izmena šalje verziju koju korisnik vidi → server odbija ako je neko drugi u međuvremenu menjao. */
  const mutate = async (fn: (version: number) => Promise<Order>, okMsg?: string): Promise<Order | null> => {
    if (!o || busy) return null;
    setBusy(true);
    try {
      const next = await fn(o.version);
      order.setData(next);
      if (okMsg) toast('ok', okMsg);
      return next;
    } catch (e) {
      const err = e as ApiError;
      toast('err', err.message);
      if (err.code === 'STALE_ORDER') order.reload();
      return null;
    } finally { setBusy(false); }
  };

  const add = async (p: Product) => {
    const next = await mutate((v) => api('POST', `/orders/${orderId}/items`, { productId: p.id, expectedVersion: v }));
    if (next) setSelectedId(next.items[next.items.length - 1]?.id ?? null);
  };
  const setQty = (i: OrderItem, q: string) => mutate((v) => api('PATCH', `/orders/${orderId}/items/${i.id}`, { quantity: q, expectedVersion: v }));
  const setNote = (i: OrderItem, note: string) => mutate((v) => api('PATCH', `/orders/${orderId}/items/${i.id}`, { note, expectedVersion: v }));
  const remove = async (i: OrderItem) => { if (await mutate((v) => api('DELETE', `/orders/${orderId}/items/${i.id}?expectedVersion=${v}`))) setSelectedId(null); };
  const send = () => mutate(async (v) => {
    const r = await api('POST', `/orders/${orderId}/send`, { expectedVersion: v });
    toast('ok', r.batch ? `Poslato u pripremu (tura ${r.batch}, ${r.sentItems.length} stavki)` : 'Nema novih stavki za slanje');
    return r.order;
  });
  const sendAndExit = async () => { if (newCount === 0 || (await send())) onBack(); };
  const sendAndPay = async () => { if (newCount === 0 || (await send())) setPaying(true); };
  const close = () => (editable && newCount > 0 ? setDialog('exit') : onBack());
  const newTab = async (tabName: string) => {
    setDialog(null);
    try {
      const n = await api<Order>('POST', '/orders', { tableId: o!.tableId, tabName: tabName || undefined, idempotencyKey: newIdempotencyKey('open') });
      setOrderId(n.id); tabs.reload();
    } catch (e: any) { toast('err', e.message); }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (dialog || paying || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'F9' && editable) { e.preventDefault(); sendAndPay(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (prods.data ?? []).filter((p) =>
      (cat === 'ALL' || p.categoryId === cat) &&
      (!term || p.name.toLowerCase().includes(term) || p.code.toLowerCase().includes(term) || p.barcode === term));
  }, [prods.data, cat, search]);

  if (order.loading && !o) return <Spinner label="Učitavam račun…" />;
  if (order.error) return <div className="page"><ErrorBox error={order.error} onRetry={order.reload} /><button className="btn" onClick={onBack}>Nazad</button></div>;
  if (!o) return null;

  const catColor = (id: string) => cats.data?.find((c) => c.id === id)?.color ?? undefined;
  const canPay = can('payment.create') && o.remaining !== '0.00';
  const isMine = o.waiterId === me?.user.userId;
  const otherTabs = (tabs.data ?? []).filter((t) => t.id !== o.id);

  return (
    <div className="till">
      {/* Kategorije i artikli */}
      <section className="till-catalog">
        <div className="cat-grid">
          <button className={`cat-tile all ${cat === 'ALL' ? 'on' : ''}`} onClick={() => setCat('ALL')}>Svi artikli</button>
          {cats.data?.filter((c) => c.active && prods.data?.some((p) => p.categoryId === c.id)).map((c) => (
            <button key={c.id} className={`cat-tile ${cat === c.id ? 'on' : ''}`} style={{ ['--tile' as any]: c.color ?? '#5b6475' }}
              onClick={() => setCat(c.id)}>{c.name}</button>
          ))}
          <input className="input cat-search" placeholder="Pretraga / barkod" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="till-products">
          {prods.loading && !prods.data ? <Spinner /> : prods.error ? <ErrorBox error={prods.error} onRetry={prods.reload} /> :
            visible.length === 0 ? <Empty>Nema artikala za izabranu kategoriju.</Empty> : (
              <div className="product-grid">
                {visible.map((p) => (
                  <button key={p.id} className="product" disabled={!editable || busy} onClick={() => add(p)}
                    style={{ ['--accent-bar' as any]: p.color ?? catColor(p.categoryId) }}>
                    <span className="p-name">{p.name}</span>
                    <span className="p-price">{fmt(p.price)}</span>
                  </button>
                ))}
              </div>
            )}
        </div>
      </section>

      {/* Račun */}
      <aside className="till-ticket">
        <header className="tt-head">
          <div className="tt-head-row">
            <div>
              <div className="tt-title">{o.tableName ?? 'Brzi račun'} <span>#{o.number}</span></div>
              <div className="tt-owner" title="Vlasnik računa">👤 {o.waiterName}{!isMine && <em> (nije vaš)</em>} · <span className={`badge ${o.status.toLowerCase()}`}>{STATUS_LABEL[o.status]}</span></div>
            </div>
            {editable && <button className="tt-opt" onClick={() => setDialog('options')} aria-label="Opcije računa">Opcije ▾</button>}
          </div>
          {o.tableId && (
            <div className="tt-tabs" role="tablist" aria-label="Ture na stolu">
              {(tabs.data ?? [o]).map((t: any) => (
                <button key={t.id} role="tab" aria-selected={t.id === o.id} className={`tt-tab ${t.id === o.id ? 'on' : ''}`}
                  onClick={() => t.id !== o.id && setOrderId(t.id)} onDoubleClick={() => t.id === o.id && editable && setDialog('rename')}>
                  {t.tabName || `#${t.number}`}<small>{fmt(t.total)}</small>
                </button>
              ))}
              {editable && <button className="tt-tab add" onClick={() => setDialog('newTab')} title="Nova tura na ovom stolu">+ Tura</button>}
            </div>
          )}
        </header>

        <div className="tt-items" role="listbox" aria-label="Stavke računa">
          {o.items.length === 0 ? <Empty>Dodirnite artikal da ga dodate.</Empty> : o.items.map((i) => (
            <button key={i.id} role="option" aria-selected={selectedId === i.id}
              className={`tt-line ${i.status.toLowerCase()} ${selectedId === i.id ? 'sel' : ''}`}
              onClick={() => setSelectedId(selectedId === i.id ? null : i.id)} disabled={i.status === 'VOIDED'}>
              <span className="tt-qty">{fmtQty(i.quantity)}×</span>
              <span className="tt-name">{i.name}
                {i.note && <small className="tag note">{i.note}</small>}
                {i.status === 'VOIDED' && <small className="tag danger">storno: {i.voidReason}</small>}
                {i.status === 'SENT' && i.prepStationName && (
                  <small className={`prep ${(i.prepStatus ?? 'new').toLowerCase()}`} title={`Pripremna pozicija: ${i.prepStationName}`}>
                    {i.prepStationName}: {PREP_LABEL[i.prepStatus ?? 'NEW'] ?? i.prepStatus}
                  </small>
                )}
              </span>
              <span className="tt-sum">{fmt(i.lineTotal)}</span>
              <span className="tt-state" title={i.status === 'SENT' ? `Poslato, tura ${i.sendBatch}` : i.status === 'NEW' ? 'Nije poslato' : 'Stornirano'}>
                {i.status === 'SENT' ? `✓${i.sendBatch}` : i.status === 'NEW' ? '•' : '✕'}
              </span>
            </button>
          ))}
        </div>

        {/* Napomena za izabranu stavku — direktno u panelu */}
        {editable && selected && selected.status === 'NEW' && (
          <div className="tt-note">
            <div className="tt-note-head">Napomena: <strong>{selected.name}</strong></div>
            <NoteEditor key={selected.id} item={selected} inputRef={noteRef} disabled={busy} onSave={(n) => setNote(selected, n)} />
          </div>
        )}

        <div className="tt-total">
          {o.discountTotal !== '0.00' && <div className="row small"><span>Popust {o.discountPercent.replace(/\.00$/, '')}%</span><span>−{fmt(o.discountTotal)}</span></div>}
          {o.paidTotal !== '0.00' && <div className="row small"><span>Naplaćeno</span><span>{fmt(o.paidTotal)}</span></div>}
          <div className="row"><span>{o.paidTotal !== '0.00' ? 'Preostalo' : 'Ukupno'}</span><strong>{fmt(o.remaining)}</strong></div>
        </div>

        {editable && (
          <div className="tt-tools">
            <button className="tool" disabled={busy || !selected || selected.status !== 'NEW'} onClick={() => selected && setQty(selected, stepQty(selected.quantity, 1))}>+1</button>
            <button className="tool" disabled={busy || !selected || selected.status !== 'NEW' || qtyAtMostOne(selected.quantity)} onClick={() => selected && setQty(selected, stepQty(selected.quantity, -1))}>−1</button>
            <button className="tool" disabled={busy || !selected || selected.status !== 'NEW'} onClick={() => setDialog('qty')} title="Unos količine">123</button>
            <button className="tool" disabled={busy || !selected || selected.status !== 'NEW'} onClick={() => noteRef.current?.focus()}>Nap.</button>
            {selected?.status === 'SENT'
              ? <button className="tool danger" disabled={busy || !can('order.void')} onClick={() => setDialog('void')} title={can('order.void') ? '' : 'Storno zahteva pravo order.void'}>Storno</button>
              : <button className="tool danger" disabled={busy || !selected} onClick={() => selected && remove(selected)}>Ukloni</button>}
          </div>
        )}

        <div className="tt-actions">
          {editable ? (
            <>
              <button className="act" disabled={busy || newCount === 0} onClick={send}>Pošalji{newCount > 0 ? ` (${newCount})` : ''}</button>
              <button className="act" disabled={busy || newCount === 0} onClick={sendAndExit}>Pošalji i izađi</button>
              <button className="act pay" disabled={busy || !canPay} onClick={sendAndPay}>{o.tableId ? 'Naplati' : 'Sačuvaj i naplati'} <small>F9</small></button>
              <button className="act exit" disabled={busy} onClick={close}>Zatvori <small>Esc</small></button>
            </>
          ) : <button className="act pay wide" onClick={onBack}>Gotovo</button>}
        </div>
      </aside>

      {paying && <Checkout order={o} onClose={() => { setPaying(false); order.reload(); }} onPaid={(next) => {
        order.setData(next);
        if (next.status === 'PAID') {
          setPaying(false);
          toast('ok', `Račun #${next.number} je zatvoren`);
          const rest = otherTabs.filter((t) => t.id !== next.id);
          if (rest.length) { setOrderId(rest[0].id); tabs.reload(); } else onBack();
        }
      }} />}

      {dialog === 'options' && (
        <Modal title={`Opcije — ${o.tableName ?? 'Brzi račun'} #${o.number}`} onClose={() => setDialog(null)}>
          <div className="opt-grid">
            <button className="opt" onClick={() => setDialog('move')} disabled={o.items.every((i) => i.status === 'VOIDED')}>
              <strong>Prebaci stavke</strong><span>Izabrane stavke na drugu turu ili drugi sto</span></button>
            {o.tableId && <button className="opt" onClick={() => setDialog('merge')} disabled={otherTabs.length === 0}>
              <strong>Spoji ture</strong><span>Druge ture ovog stola u ovaj račun</span></button>}
            <button className="opt" onClick={() => setDialog('transfer')}>
              <strong>Predaj konobaru</strong><span>Ceo račun prelazi na drugog zaposlenog</span></button>
            {o.tableId && <button className="opt" onClick={() => setDialog('rename')}>
              <strong>Naziv ture</strong><span>{o.tabName ?? 'npr. Pera, Mika'}</span></button>}
            <button className="opt danger" onClick={() => setDialog('voidAll')} disabled={!can('order.void') || o.paidTotal !== '0.00'}>
              <strong>Storno računa</strong><span>{can('order.void') ? 'Stornira sve stavke, uz razlog' : 'Zahteva pravo storniranja'}</span></button>
          </div>
        </Modal>
      )}
      {dialog === 'move' && <MoveItemsDialog order={o} tabs={otherTabs} onClose={() => setDialog(null)} onDone={(to) => {
        setDialog(null); order.reload(); tabs.reload();
        toast('ok', `Stavke prebačene na #${to.number}${to.tabName ? ` (${to.tabName})` : ''}${to.tableName && to.tableName !== o.tableName ? ` — ${to.tableName}` : ''}`);
      }} />}
      {dialog === 'merge' && <MergeDialog order={o} tabs={otherTabs} onClose={() => setDialog(null)} onDone={(next) => {
        setDialog(null); order.setData(next); tabs.reload(); toast('ok', 'Ture su spojene');
      }} />}
      {dialog === 'transfer' && <TransferDialog orderIds={[o.id]} onClose={() => setDialog(null)} onDone={(_, name) => {
        setDialog(null); toast('ok', `Račun predat: ${name}`); onBack();
      }} />}
      {dialog === 'voidAll' && <VoidDialog title={`Storno celog računa #${o.number}`} onClose={() => setDialog(null)} onConfirm={async (reason) => {
        setDialog(null);
        const r = await mutate((v) => api('POST', `/orders/${orderId}/void-all`, { reason, expectedVersion: v }), 'Račun je storniran');
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
      {dialog === 'void' && selected && <VoidDialog title={`Storniranje: ${selected.name}`} onClose={() => setDialog(null)} onConfirm={(reason) => {
        setDialog(null);
        mutate((v) => api('POST', `/orders/${orderId}/items/${selected.id}/void`, { reason, expectedVersion: v }), 'Stavka stornirana');
      }} />}
      {dialog === 'qty' && selected && <QtyDialog item={selected} onClose={() => setDialog(null)} onSave={(q) => { setDialog(null); setQty(selected, q); }} />}
      {dialog === 'exit' && (
        <Modal title="Neposlate stavke" onClose={() => setDialog(null)}>
          <p>Na računu ima {newCount} stavki koje nisu poslate u pripremu.</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setDialog(null)}>Odustani</button>
            <button className="btn" onClick={() => { setDialog(null); onBack(); }}>Izađi bez slanja</button>
            <button className="btn primary" onClick={() => { setDialog(null); sendAndExit(); }}>Pošalji i izađi</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NoteEditor({ item, onSave, disabled, inputRef }: { item: OrderItem; onSave: (n: string) => void; disabled: boolean; inputRef: React.RefObject<HTMLInputElement> }) {
  const [note, setNote] = useState(item.note ?? '');
  const dirty = note.trim() !== (item.note ?? '');
  const add = (p: string) => setNote((n) => (n.toLowerCase().includes(p.toLowerCase()) ? n : n ? `${n}, ${p}` : p));
  return (
    <>
      <div className="note-chips">{NOTE_PRESETS.map((p) => <button key={p} type="button" className="note-chip" onClick={() => add(p)}>{p}</button>)}</div>
      <form className="note-row" onSubmit={(e) => { e.preventDefault(); onSave(note.trim()); }}>
        <input ref={inputRef} className="input" value={note} maxLength={200} placeholder="npr. bez leda" onChange={(e) => setNote(e.target.value)} />
        <button className="btn sm" type="button" disabled={disabled || !note} onClick={() => { setNote(''); onSave(''); }} aria-label="Obriši napomenu">✕</button>
        <button className="btn sm primary" disabled={disabled || !dirty}>Sačuvaj</button>
      </form>
    </>
  );
}

function MoveItemsDialog({ order, tabs, onClose, onDone }: { order: Order; tabs: any[]; onClose: () => void; onDone: (to: Order) => void }) {
  const tables = useLoad(() => api<Table[]>('GET', '/tables'), []);
  const items = order.items.filter((i) => i.status !== 'VOIDED');
  const [sel, setSel] = useState<string[]>([]);
  const [target, setTarget] = useState<string>(tabs[0]?.id ? `order:${tabs[0].id}` : 'newtab');
  const [tabName, setTabName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const toggle = (id: string) => setSel((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const submit = async () => {
    setBusy(true); setError(undefined);
    const body: any = { itemIds: sel };
    if (target.startsWith('order:')) body.toOrderId = target.slice(6);
    else if (target.startsWith('table:')) { body.toTableId = target.slice(6); body.toTabName = tabName.trim() || undefined; }
    else body.toTabName = tabName.trim();
    try { const r = await api('POST', `/orders/${order.id}/move-items`, body); onDone(r.to); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const sorted = (tables.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, 'sr', { numeric: true }));
  return (
    <Modal title="Prebacivanje stavki" onClose={onClose} wide>
      <div className="grid2">
        <div>
          <div className="row-between"><h3>Stavke</h3>
            <button className="btn sm" onClick={() => setSel(sel.length === items.length ? [] : items.map((i) => i.id))}>{sel.length === items.length ? 'Poništi' : 'Sve'}</button></div>
          <div className="pick-list">
            {items.map((i) => (
              <label key={i.id} className={`pick ${sel.includes(i.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={sel.includes(i.id)} onChange={() => toggle(i.id)} />
                <span className="pick-main">{fmtQty(i.quantity)}× {i.name}{i.status === 'SENT' ? ' ✓' : ''}</span>
                <span className="num">{fmt(i.lineTotal)}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <h3>Odredište</h3>
          <div className="pick-list">
            {tabs.map((t) => (
              <label key={t.id} className={`pick ${target === `order:${t.id}` ? 'on' : ''}`}>
                <input type="radio" name="tgt" checked={target === `order:${t.id}`} onChange={() => setTarget(`order:${t.id}`)} />
                <span className="pick-main">Tura <strong>{t.tabName || `#${t.number}`}</strong> (ovaj sto)</span>
              </label>
            ))}
            <label className={`pick ${target === 'newtab' ? 'on' : ''}`}>
              <input type="radio" name="tgt" checked={target === 'newtab'} onChange={() => setTarget('newtab')} />
              <span className="pick-main">Nova tura na ovom stolu</span>
            </label>
            <label className={`pick ${target.startsWith('table:') ? 'on' : ''}`}>
              <input type="radio" name="tgt" checked={target.startsWith('table:')} onChange={() => setTarget(`table:${sorted.find((t) => t.id !== order.tableId)?.id ?? ''}`)} />
              <span className="pick-main">Drugi sto:</span>
              <select className="input" value={target.startsWith('table:') ? target.slice(6) : ''} onChange={(e) => setTarget(`table:${e.target.value}`)}>
                {sorted.filter((t) => t.id !== order.tableId).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.area})</option>)}
              </select>
            </label>
            {(target === 'newtab' || target.startsWith('table:')) && (
              <input className="input" placeholder="Naziv ture (opciono), npr. Mika" value={tabName} maxLength={40} onChange={(e) => setTabName(e.target.value)} />
            )}
          </div>
        </div>
      </div>
      {error !== undefined && <ErrorBox error={error} />}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Odustani</button>
        <button className="btn primary" disabled={busy || sel.length === 0 || target === 'table:'} onClick={submit}>Prebaci ({sel.length})</button>
      </div>
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
            <span className="pick-main"><strong>{t.tabName || `#${t.number}`}</strong> · {t.waiterName}{t.paidTotal !== '0.00' ? ' — ima naplatu, ne može' : ''}</span>
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

function QtyDialog({ item, onClose, onSave }: { item: OrderItem; onClose: () => void; onSave: (q: string) => void }) {
  const [v, setV] = useState('');
  const ok = /^\d{1,6}(\.\d{1,3})?$/.test(v) && Number(v) > 0;
  return (
    <Modal title={`Količina: ${item.name}`} onClose={onClose}>
      <div className="row big"><span>Trenutno {fmtQty(item.quantity)}</span><strong className="entered">{v ? v.replace('.', ',') : '—'}</strong></div>
      <Keypad value={v} onChange={(x) => {
        const dot = x.indexOf('.');
        if (dot >= 0 && x.length - dot > 4) return;
        setV(x);
      }} />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Odustani</button>
        <button className="btn primary" disabled={!ok} onClick={() => onSave(v)}>Potvrdi</button>
      </div>
    </Modal>
  );
}

function VoidDialog({ title, onClose, onConfirm }: { title: string; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const presets = ['Gost odustao', 'Pogrešno uneto', 'Reklamacija', 'Gost otišao'];
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">Storniranje ostaje zabeleženo sa razlogom i vašim imenom.</p>
      <div className="chips">{presets.map((p) => <button key={p} className={`chip ${reason === p ? 'on' : ''}`} onClick={() => setReason(p)}>{p}</button>)}</div>
      <input className="input" placeholder="Razlog storniranja" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Odustani</button>
        <button className="btn danger" disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>Storniraj</button>
      </div>
    </Modal>
  );
}

const PREP_LABEL: Record<string, string> = { NEW: 'primljeno', IN_PROGRESS: 'u pripremi', READY: 'spremno', DONE: 'izdato' };
