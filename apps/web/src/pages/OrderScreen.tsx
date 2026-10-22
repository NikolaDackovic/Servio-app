import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, Category, fmt, fmtQty, Order, OrderItem, Product, qtyAtMostOne, stepQty } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorBox, Keypad, Modal, Spinner, useLoad, useToast } from '../ui';
import { PaymentDialog } from './PaymentDialog';

const STATUS_LABEL = { OPEN: 'Otvoren', PAID: 'Plaćen', CANCELLED: 'Otkazan' } as const;
const METHOD: Record<string, string> = { CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Virman' };

/**
 * Ekran kucanja (ceo ekran): kategorije i artikli levo, račun desno.
 * Dodir na stavku je bira; brza dugmad (+1, −1, količina, napomena, ukloni/storno) rade nad izabranom stavkom.
 */
export function OrderScreen({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const order = useLoad(() => api<Order>('GET', `/orders/${orderId}`), [orderId]);
  const cats = useLoad(() => api<Category[]>('GET', '/categories'), []);
  const prods = useLoad(() => api<{ data: Product[] }>('GET', '/products?pageSize=500').then((r) => r.data), []);
  const [cat, setCat] = useState<string | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'void' | 'note' | 'qty' | 'exit'>(null);

  const o = order.data;
  const editable = o?.status === 'OPEN';
  const selected = o?.items.find((i) => i.id === selectedId && i.status !== 'VOIDED') ?? null;
  const newCount = o?.items.filter((i) => i.status === 'NEW').length ?? 0;

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
  const remove = async (i: OrderItem) => { if (await mutate((v) => api('DELETE', `/orders/${orderId}/items/${i.id}?expectedVersion=${v}`))) setSelectedId(null); };
  const send = () => mutate(async (v) => {
    const r = await api('POST', `/orders/${orderId}/send`, { expectedVersion: v });
    toast('ok', r.batch ? `Poslato u pripremu (tura ${r.batch}, ${r.sentItems.length} stavki)` : 'Nema novih stavki za slanje');
    return r.order;
  });
  const sendAndExit = async () => { if (newCount === 0 || (await send())) onBack(); };
  const sendAndPay = async () => { if (newCount === 0 || (await send())) setPaying(true); };
  const close = () => (editable && newCount > 0 ? setDialog('exit') : onBack());

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (dialog || paying) return;
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

  return (
    <div className="till">
      {/* Kategorije i artikli */}
      <section className="till-catalog">
        <div className="cat-grid">
          <button className={`cat-tile all ${cat === 'ALL' ? 'on' : ''}`} onClick={() => setCat('ALL')}>Svi artikli</button>
          {cats.data?.filter((c) => c.active).map((c) => (
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
          <div className="tt-title">{o.tableName ?? 'Brza prodaja'} <span>#{o.number}</span></div>
          <div className="tt-meta">{o.waiterName} · <span className={`badge ${o.status.toLowerCase()}`}>{STATUS_LABEL[o.status]}</span></div>
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
              </span>
              <span className="tt-sum">{fmt(i.lineTotal)}</span>
              <span className="tt-state" title={i.status === 'SENT' ? `Poslato, tura ${i.sendBatch}` : i.status === 'NEW' ? 'Nije poslato' : 'Stornirano'}>
                {i.status === 'SENT' ? `✓${i.sendBatch}` : i.status === 'NEW' ? '•' : '✕'}
              </span>
            </button>
          ))}
        </div>

        <div className="tt-total">
          {o.paidTotal !== '0.00' && <div className="row small"><span>Naplaćeno</span><span>{fmt(o.paidTotal)}</span></div>}
          <div className="row"><span>{o.paidTotal !== '0.00' ? 'Preostalo' : 'Ukupno'}</span><strong>{fmt(o.remaining)}</strong></div>
          {!editable && o.payments.map((p) => <div key={p.id} className="row small"><span>{METHOD[p.method]}{p.mode === 'TEST' ? ' (TEST)' : ''}</span><span>{fmt(p.amount)}</span></div>)}
        </div>

        {editable && (
          <div className="tt-tools">
            <button className="tool" disabled={busy || !selected || selected.status !== 'NEW'} onClick={() => selected && setQty(selected, stepQty(selected.quantity, 1))}>+1</button>
            <button className="tool" disabled={busy || !selected || selected.status !== 'NEW' || qtyAtMostOne(selected.quantity)} onClick={() => selected && setQty(selected, stepQty(selected.quantity, -1))}>−1</button>
            <button className="tool" disabled={busy || !selected || selected.status !== 'NEW'} onClick={() => setDialog('qty')} title="Unos količine">123</button>
            <button className="tool" disabled={busy || !selected || selected.status !== 'NEW'} onClick={() => setDialog('note')}>Nap.</button>
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
              <button className="act pay" disabled={busy || !canPay} onClick={sendAndPay}>Naplati <small>F9</small></button>
              <button className="act exit" disabled={busy} onClick={close}>Zatvori <small>Esc</small></button>
            </>
          ) : <button className="act pay wide" onClick={onBack}>Gotovo</button>}
        </div>
      </aside>

      {paying && <PaymentDialog order={o} onClose={() => setPaying(false)} onPaid={(next) => {
        order.setData(next);
        if (next.status === 'PAID') { setPaying(false); toast('ok', `Račun #${next.number} je zatvoren`); onBack(); }
      }} />}
      {dialog === 'void' && selected && <VoidDialog item={selected} onClose={() => setDialog(null)} onConfirm={(reason) => {
        setDialog(null);
        mutate((v) => api('POST', `/orders/${orderId}/items/${selected.id}/void`, { reason, expectedVersion: v }), 'Stavka stornirana');
      }} />}
      {dialog === 'note' && selected && <NoteDialog item={selected} onClose={() => setDialog(null)} onSave={(note) => {
        setDialog(null);
        mutate((v) => api('PATCH', `/orders/${orderId}/items/${selected.id}`, { note, expectedVersion: v }));
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

function QtyDialog({ item, onClose, onSave }: { item: OrderItem; onClose: () => void; onSave: (q: string) => void }) {
  const [v, setV] = useState('');
  const ok = /^\d{1,6}(\.\d{1,3})?$/.test(v) && Number(v) > 0;
  return (
    <Modal title={`Količina: ${item.name}`} onClose={onClose}>
      <div className="row big"><span>Trenutno {fmtQty(item.quantity)}</span><strong className="entered">{v ? v.replace('.', ',') : '—'}</strong></div>
      <Keypad value={v} onChange={(x) => {
        // dozvoljene do 3 decimale (npr. 0,25 l)
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

function VoidDialog({ item, onClose, onConfirm }: { item: OrderItem; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const presets = ['Gost odustao', 'Pogrešno uneto', 'Reklamacija'];
  return (
    <Modal title={`Storniranje: ${item.name}`} onClose={onClose}>
      <p className="muted">Stavka je već poslata u pripremu. Storniranje ostaje zabeleženo sa razlogom i vašim imenom.</p>
      <div className="chips">{presets.map((p) => <button key={p} className={`chip ${reason === p ? 'on' : ''}`} onClick={() => setReason(p)}>{p}</button>)}</div>
      <input className="input" placeholder="Razlog storniranja" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Odustani</button>
        <button className="btn danger" disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>Storniraj</button>
      </div>
    </Modal>
  );
}

function NoteDialog({ item, onClose, onSave }: { item: OrderItem; onClose: () => void; onSave: (note: string) => void }) {
  const [note, setNote] = useState(item.note ?? '');
  const presets = ['Bez leda', 'Bez šećera', 'Dobro pečeno', 'Bez luka', 'Ljuto'];
  return (
    <Modal title={`Napomena: ${item.name}`} onClose={onClose}>
      <div className="chips">{presets.map((p) => <button key={p} className="chip" onClick={() => setNote((n) => (n ? `${n}, ${p}` : p))}>{p}</button>)}</div>
      <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Napomena za pripremu" />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Odustani</button>
        <button className="btn primary" onClick={() => onSave(note.trim())}>Sačuvaj</button>
      </div>
    </Modal>
  );
}
