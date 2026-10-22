import { useState } from 'react';
import { api, fmt, fmtQty, Order, time } from '../api';
import { Empty, ErrorBox, Modal, Spinner, useLoad } from '../ui';

const LABEL = { OPEN: 'Otvoren', PAID: 'Plaćen', CANCELLED: 'Otkazan' } as const;
const METHOD: Record<string, string> = { CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Virman' };
const ACTION: Record<string, string> = {
  'order.open': 'Otvoren račun', 'order.item.add': 'Dodata stavka', 'order.item.update': 'Izmenjena stavka',
  'order.item.remove': 'Uklonjena stavka (neposlata)', 'order.send': 'Poslato u pripremu', 'order.item.void': 'STORNO stavke',
  'order.cancel': 'Otkazan račun', 'payment.create': 'Naplata', 'order.close': 'Račun zatvoren', 'order.transfer': 'Prebačen konobaru',
};

/** Pregled računa: filteri, detalji sa stavkama, plaćanjima, porezom i istorijom izmena. */
export function Orders({ onOpen, businessDayId, onClearDay, readOnly }: {
  onOpen?: (id: string) => void; businessDayId?: string | null; onClearDay?: () => void;
  /** Admin: svaki račun se otvara kao pregled (bez kucanja). */
  readOnly?: boolean;
}) {
  const [status, setStatus] = useState<'OPEN' | 'PAID' | 'CANCELLED'>(businessDayId ? 'PAID' : 'OPEN');
  const [scope, setScope] = useState<'today' | 'all'>('today');
  const cur = useLoad(() => api('GET', '/business-days/current'), []);
  const dayFilter = businessDayId ?? (scope === 'today' ? cur.data?.day?.id : undefined);
  const r = useLoad(() => {
    if (!businessDayId && scope === 'today' && cur.loading) return Promise.resolve([]);
    if (!businessDayId && scope === 'today' && !cur.data?.day) return Promise.resolve([]);
    return api<any[]>('GET', `/orders?status=${status}&pageSize=200${dayFilter ? `&businessDayId=${dayFilter}` : ''}`);
  }, [status, dayFilter, scope, cur.loading]);
  const [detail, setDetail] = useState<string | null>(null);

  return (
    <div className="page">
      <div className="toolbar">
        <div className="seg">
          {(['OPEN', 'PAID', 'CANCELLED'] as const).map((s) => <button key={s} className={`seg-btn ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>{LABEL[s]}</button>)}
        </div>
        {businessDayId ? (
          <button className="btn" onClick={onClearDay}>Izabrani poslovni dan ✕</button>
        ) : (
          <div className="seg">
            <button className={`seg-btn ${scope === 'today' ? 'on' : ''}`} onClick={() => setScope('today')}>Tekući dan</button>
            <button className={`seg-btn ${scope === 'all' ? 'on' : ''}`} onClick={() => setScope('all')}>Svi</button>
          </div>
        )}
      </div>
      {!businessDayId && scope === 'today' && cur.data && !cur.data.day && <div className="notice">Nema otvorenog poslovnog dana — izaberite „Svi“.</div>}
      {r.loading && !r.data ? <Spinner /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> :
        !r.data?.length ? <Empty>Nema računa za izabrani filter.</Empty> : (
          <table className="tbl clickable">
            <thead><tr><th>#</th><th>Sto</th><th>Konobar</th><th>Otvoren</th><th>Zatvoren</th><th className="num">Iznos</th><th className="num">Naplaćeno</th></tr></thead>
            <tbody>
              {r.data.map((o) => (
                <tr key={o.id} onClick={() => (o.status === 'OPEN' && !readOnly && onOpen ? onOpen(o.id) : setDetail(o.id))}>
                  <td>{o.number}</td><td>{o.tableName ?? 'Brza prodaja'}</td><td>{o.waiterName}</td><td>{time(o.openedAt)}</td>
                  <td>{o.closedAt ? time(o.closedAt) : '—'}</td>
                  <td className="num">{fmt(o.total)}</td><td className="num">{fmt(o.paidTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {detail && <ReceiptDetail orderId={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

export function ReceiptDetail({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const o = useLoad(() => api<Order>('GET', `/orders/${orderId}`), [orderId]);
  const h = useLoad(() => api<any[]>('GET', `/orders/${orderId}/history`), [orderId]);
  const [tab, setTab] = useState<'items' | 'history'>('items');
  return (
    <Modal title={o.data ? `Račun #${o.data.number} — ${o.data.tableName ?? 'Brza prodaja'}` : 'Račun'} onClose={onClose} wide>
      {o.loading ? <Spinner /> : o.error ? <ErrorBox error={o.error} /> : o.data && (
        <>
          <div className="test-banner">Interni pregled računa (TEST režim) — nije fiskalni račun.</div>
          <div className="muted small">
            Konobar: {o.data.waiterName} · otvoren {new Date(o.data.openedAt).toLocaleString('sr-Latn-RS')}
            {o.data.closedAt && ` · zatvoren ${new Date(o.data.closedAt).toLocaleString('sr-Latn-RS')}`} · <span className={`badge ${o.data.status.toLowerCase()}`}>{LABEL[o.data.status]}</span>
          </div>
          <div className="seg">
            <button className={`seg-btn ${tab === 'items' ? 'on' : ''}`} onClick={() => setTab('items')}>Stavke i plaćanja</button>
            <button className={`seg-btn ${tab === 'history' ? 'on' : ''}`} onClick={() => setTab('history')}>Istorija izmena</button>
          </div>
          {tab === 'items' ? (
            <>
              <table className="tbl">
                <thead><tr><th>Artikal</th><th className="num">Kol.</th><th className="num">Cena</th><th className="num">Iznos</th><th>PDV</th><th>Status</th></tr></thead>
                <tbody>
                  {o.data.items.map((i) => (
                    <tr key={i.id} className={i.status === 'VOIDED' ? 'voided' : ''}>
                      <td>{i.name}{i.note ? <div className="muted small">{i.note}</div> : null}</td>
                      <td className="num">{fmtQty(i.quantity)}</td><td className="num">{fmt(i.unitPrice)}</td><td className="num">{fmt(i.lineTotal)}</td>
                      <td>{i.taxLabel}</td>
                      <td>{i.status === 'VOIDED' ? <span className="warn-text">STORNO: {i.voidReason}</span> : i.status === 'SENT' ? `tura ${i.sendBatch}` : 'nije poslato'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="grid2">
                <table className="tbl"><thead><tr><th>Oznaka</th><th className="num">Osnovica</th><th className="num">PDV</th><th className="num">Ukupno</th></tr></thead><tbody>
                  {o.data.taxSummary.map((t) => <tr key={t.label}><td>{t.label} ({t.rate}%)</td><td className="num">{fmt(t.net)}</td><td className="num">{fmt(t.tax)}</td><td className="num">{fmt(t.gross)}</td></tr>)}
                  <tr className="strong"><td>Ukupno</td><td /><td /><td className="num">{fmt(o.data.total)}</td></tr>
                </tbody></table>
                <table className="tbl"><thead><tr><th>Plaćanje</th><th>Vreme</th><th className="num">Iznos</th></tr></thead><tbody>
                  {o.data.payments.length === 0 && <tr><td colSpan={3} className="muted">Nema plaćanja.</td></tr>}
                  {o.data.payments.map((p) => <tr key={p.id}><td>{METHOD[p.method]}{p.mode === 'TEST' ? ' (TEST)' : ''}{p.change !== '0.00' ? ` · kusur ${fmt(p.change)}` : ''}</td><td>{time(p.createdAt)}</td><td className="num">{fmt(p.amount)}</td></tr>)}
                </tbody></table>
              </div>
            </>
          ) : h.loading ? <Spinner /> : h.error ? <ErrorBox error={h.error} /> : (
            <ol className="timeline">
              {h.data!.map((e) => (
                <li key={e.id} className={e.action === 'order.item.void' ? 'void' : ''}>
                  <span className="t-time">{new Date(e.createdAt).toLocaleTimeString('sr-Latn-RS')}</span>
                  <span className="t-who">{e.userName ?? '—'}</span>
                  <span className="t-what">{ACTION[e.action] ?? e.action}{describe(e)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Modal>
  );
}

function describe(e: any): string {
  const d = e.data ?? {};
  switch (e.action) {
    case 'order.item.add': return `: ${d.product} × ${fmtQty(d.quantity)}`;
    case 'order.item.remove': return `: ${d.product}`;
    case 'order.item.void': return `: ${d.product} (${fmt(d.lineTotal)}) — razlog: ${d.reason}`;
    case 'order.send': return ` (tura ${d.batch}, ${d.itemIds?.length ?? 0} stavki)`;
    case 'payment.create': return `: ${METHOD[d.method] ?? d.method} ${fmt(d.amount)}${d.mode === 'TEST' ? ' (TEST)' : ''}`;
    case 'order.close': return `: ${fmt(d.total)}`;
    case 'order.transfer': return ` → ${d.toName}`;
    case 'order.cancel': return ` — razlog: ${d.reason}`;
    default: return '';
  }
}
