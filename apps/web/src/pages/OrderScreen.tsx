import { useMemo, useState } from 'react';
import { api, ApiError, Category, fmt, fmtQty, Order, OrderItem, Product, qtyAtMostOne, stepQty } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorBox, Modal, Spinner, useLoad, useToast } from '../ui';
import { PaymentDialog } from './PaymentDialog';

const STATUS_LABEL = { OPEN: 'Otvoren', PAID: 'Plaćen', CANCELLED: 'Otkazan' } as const;

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
  const [voiding, setVoiding] = useState<OrderItem | null>(null);
  const [noteFor, setNoteFor] = useState<OrderItem | null>(null);

  const o = order.data;
  const editable = o?.status === 'OPEN';

  /** Svaka izmena šalje verziju koju korisnik vidi → server odbija ako je neko drugi u međuvremenu menjao. */
  const mutate = async (fn: (version: number) => Promise<Order>, okMsg?: string) => {
    if (!o || busy) return;
    setBusy(true);
    try {
      order.setData(await fn(o.version));
      if (okMsg) toast('ok', okMsg);
    } catch (e) {
      const err = e as ApiError;
      toast('err', err.message);
      if (err.code === 'STALE_ORDER') order.reload();
    } finally { setBusy(false); }
  };

  const add = (p: Product) => mutate((v) => api('POST', `/orders/${orderId}/items`, { productId: p.id, expectedVersion: v }));
  const setQty = (i: OrderItem, q: string) => mutate((v) => api('PATCH', `/orders/${orderId}/items/${i.id}`, { quantity: q, expectedVersion: v }));
  const remove = (i: OrderItem) => mutate((v) => api('DELETE', `/orders/${orderId}/items/${i.id}?expectedVersion=${v}`));
  const send = () => mutate(async (v) => {
    const r = await api('POST', `/orders/${orderId}/send`, { expectedVersion: v });
    toast('ok', r.batch ? `Poslato u pripremu (tura ${r.batch}, ${r.sentItems.length} stavki)` : 'Nema novih stavki za slanje');
    return r.order;
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

  const newCount = o.items.filter((i) => i.status === 'NEW').length;
  const catColor = (id: string) => cats.data?.find((c) => c.id === id)?.color ?? undefined;

  return (
    <div className="pos">
      {/* Katalog */}
      <section className="catalog">
        <div className="catalog-bar">
          <input className="input" placeholder="Pretraga: naziv, šifra, barkod" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="cat-tabs">
          <button className={`chip ${cat === 'ALL' ? 'on' : ''}`} onClick={() => setCat('ALL')}>Sve</button>
          {cats.data?.filter((c) => c.active).map((c) => (
            <button key={c.id} className={`chip ${cat === c.id ? 'on' : ''}`} style={{ ['--chip' as any]: c.color ?? undefined }} onClick={() => setCat(c.id)}>{c.name}</button>
          ))}
        </div>
        {prods.loading && !prods.data ? <Spinner /> : prods.error ? <ErrorBox error={prods.error} onRetry={prods.reload} /> :
          visible.length === 0 ? <Empty>Nema proizvoda za izabrani filter.</Empty> : (
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
      </section>

      {/* Račun */}
      <aside className="ticket">
        <header className="ticket-head">
          <button className="btn ghost sm" onClick={onBack}>← Nazad</button>
          <div>
            <div className="ticket-title">{o.tableName ?? 'Brza prodaja'} · #{o.number}</div>
            <div className="muted small">{o.waiterName} · <span className={`badge ${o.status.toLowerCase()}`}>{STATUS_LABEL[o.status]}</span></div>
          </div>
        </header>

        <div className="ticket-items">
          {o.items.length === 0 ? <Empty>Dodajte proizvode dodirom na dugme.</Empty> : o.items.map((i) => (
            <div key={i.id} className={`line ${i.status.toLowerCase()}`}>
              <div className="line-main">
                <span className="line-name">{i.name}</span>
                <span className="line-total">{fmt(i.lineTotal)}</span>
              </div>
              <div className="line-sub">
                <span>{fmtQty(i.quantity)} × {fmt(i.unitPrice)}</span>
                {i.status === 'SENT' && <span className="tag">Poslato · tura {i.sendBatch}</span>}
                {i.status === 'VOIDED' && <span className="tag danger">Stornirano: {i.voidReason}</span>}
                {i.note && <span className="tag note">{i.note}</span>}
              </div>
              {editable && i.status === 'NEW' && (
                <div className="line-actions">
                  <button className="btn sm" disabled={busy || qtyAtMostOne(i.quantity)} onClick={() => setQty(i, stepQty(i.quantity, -1))} aria-label="Smanji">−</button>
                  <button className="btn sm" disabled={busy} onClick={() => setQty(i, stepQty(i.quantity, 1))} aria-label="Povećaj">+</button>
                  <button className="btn sm" disabled={busy} onClick={() => setNoteFor(i)}>Napomena</button>
                  <button className="btn sm danger-ghost" disabled={busy} onClick={() => remove(i)}>Ukloni</button>
                </div>
              )}
              {editable && i.status === 'SENT' && can('order.void') && (
                <div className="line-actions"><button className="btn sm danger-ghost" disabled={busy} onClick={() => setVoiding(i)}>Storniraj</button></div>
              )}
            </div>
          ))}
        </div>

        <footer className="ticket-foot">
          {o.taxSummary.map((t) => (
            <div key={t.label} className="row muted small"><span>PDV {t.label} {t.rate}%</span><span>{fmt(t.tax)}</span></div>
          ))}
          {o.paidTotal !== '0.00' && <div className="row small"><span>Naplaćeno</span><span>{fmt(o.paidTotal)}</span></div>}
          <div className="row total"><span>{o.paidTotal !== '0.00' ? 'Preostalo' : 'Ukupno'}</span><span>{fmt(o.remaining)}</span></div>
          {editable ? (
            <div className="ticket-buttons">
              <button className="btn lg" disabled={busy || newCount === 0} onClick={send}>Pošalji {newCount > 0 ? `(${newCount})` : ''}</button>
              <button className="btn primary lg" disabled={busy || o.remaining === '0.00' || !can('payment.create')} onClick={() => setPaying(true)}>Naplati</button>
            </div>
          ) : (
            <div className="paid-list">
              {o.payments.map((p) => <div key={p.id} className="row small"><span>{p.method}{p.mode === 'TEST' ? ' (TEST)' : ''}</span><span>{fmt(p.amount)}</span></div>)}
              <button className="btn lg block" onClick={onBack}>Gotovo</button>
            </div>
          )}
        </footer>
      </aside>

      {paying && <PaymentDialog order={o} onClose={() => setPaying(false)} onPaid={(next) => {
        order.setData(next);
        if (next.status === 'PAID') { setPaying(false); toast('ok', `Račun #${next.number} je zatvoren`); }
      }} />}
      {voiding && <VoidDialog item={voiding} onClose={() => setVoiding(null)} onConfirm={(reason) => {
        setVoiding(null);
        mutate((v) => api('POST', `/orders/${orderId}/items/${voiding.id}/void`, { reason, expectedVersion: v }), 'Stavka stornirana');
      }} />}
      {noteFor && <NoteDialog item={noteFor} onClose={() => setNoteFor(null)} onSave={(note) => {
        setNoteFor(null);
        mutate((v) => api('PATCH', `/orders/${orderId}/items/${noteFor.id}`, { note, expectedVersion: v }));
      }} />}
    </div>
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
