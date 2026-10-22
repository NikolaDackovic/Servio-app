import { useState } from 'react';
import { api, fmt, time } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorBox, Modal, Spinner, useLoad, useToast } from '../ui';

const METHOD: Record<string, string> = { CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Virman', REPRESENTATION: 'Reprezentacija' };

/** Smena konobara: specifikacija pazara, prebacivanje otvorenih stolova, kraj smene. */
export function MyShift({ onOpenOrder }: { onOpenOrder: (id: string) => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const cur = useLoad(() => api('GET', '/staff-shifts/current'), []);
  const [selected, setSelected] = useState<string[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [ended, setEnded] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const end = async () => {
    setBusy(true);
    try { setEnded(await api('POST', '/staff-shifts/current/end')); cur.reload(); toast('ok', 'Smena je završena'); }
    catch (e: any) { toast('err', e.message); cur.reload(); }
    finally { setBusy(false); }
  };

  if (ended) {
    return (
      <div className="page narrow">
        <Specification summary={ended.summary} title="Specifikacija pazara — smena završena" />
        <div className="btn-row no-print">
          <button className="btn" onClick={() => window.print()}>Štampaj (preko pregledača)</button>
          <button className="btn primary" onClick={() => setEnded(null)}>U redu</button>
        </div>
      </div>
    );
  }
  if (cur.loading && !cur.data) return <Spinner />;
  if (cur.error) return <ErrorBox error={cur.error} onRetry={cur.reload} />;

  if (!cur.data.shift) {
    return (
      <div className="page narrow">
        <div className="card">
          <h3>{me?.user.fullName}: nemate otvorenu smenu</h3>
          <p className="muted">Smena počinje automatski prvim otvorenim računom ili naplatom u otvorenom poslovnom danu.</p>
          {cur.data.openOrdersCount > 0 && <p className="notice warn">Na vama je {cur.data.openOrdersCount} otvorenih računa iz ranije.</p>}
        </div>
      </div>
    );
  }

  const s = cur.data.summary;
  const toggle = (id: string) => setSelected((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  return (
    <div className="page narrow">
      <Specification summary={s} title={`Moja smena — od ${time(s.startedAt)}`} />

      <div className="card no-print">
        <div className="row-between">
          <h3>Otvoreni stolovi na meni ({s.openOrders.length})</h3>
          {s.openOrders.length > 0 && (
            <button className="btn sm" onClick={() => setSelected(selected.length === s.openOrders.length ? [] : s.openOrders.map((o: any) => o.id))}>
              {selected.length === s.openOrders.length ? 'Poništi izbor' : 'Izaberi sve'}
            </button>
          )}
        </div>
        {s.openOrders.length === 0 ? <Empty>Nema otvorenih stolova — smena može da se završi.</Empty> : (
          <div className="pick-list">
            {s.openOrders.map((o: any) => (
              <label key={o.id} className={`pick ${selected.includes(o.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                <span className="pick-main"><strong>{o.tableName ?? 'Brza prodaja'}</strong> · #{o.number} · od {time(o.openedAt)}</span>
                <span className="num">{fmt(o.total)}</span>
                <button type="button" className="btn xs ghost" onClick={(e) => { e.preventDefault(); onOpenOrder(o.id); }}>Otvori</button>
              </label>
            ))}
          </div>
        )}
        <div className="btn-row">
          <button className="btn" disabled={selected.length === 0} onClick={() => setTransferOpen(true)}>Prebaci izabrane ({selected.length})…</button>
          <button className="btn primary" disabled={busy || s.openOrders.length > 0} onClick={end}
            title={s.openOrders.length ? 'Prvo prebacite ili naplatite otvorene stolove' : ''}>Završi smenu</button>
          <button className="btn ghost" onClick={() => window.print()}>Štampaj specifikaciju</button>
        </div>
      </div>

      {transferOpen && <TransferDialog orderIds={selected} onClose={() => setTransferOpen(false)} onDone={(n, name) => {
        setTransferOpen(false); setSelected([]); cur.reload(); toast('ok', `Prebačeno ${n} računa na: ${name}`);
      }} />}
    </div>
  );
}

export function Specification({ summary: s, title }: { summary: any; title: string }) {
  return (
    <div className="card spec">
      <h3>{title}</h3>
      <div className="muted small">{s.fullName} · {new Date(s.startedAt).toLocaleString('sr-Latn-RS')}{s.endedAt ? ` – ${new Date(s.endedAt).toLocaleString('sr-Latn-RS')}` : ''}</div>
      <table className="tbl">
        <tbody>
          {s.collected.byMethod.length === 0 && <tr><td colSpan={3} className="muted">Nema naplata u ovoj smeni.</td></tr>}
          {s.collected.byMethod.map((m: any) => <tr key={m.method}><td>{METHOD[m.method] ?? m.method}</td><td className="num">{m.count}×</td><td className="num">{fmt(m.amount)}</td></tr>)}
          <tr className="strong"><td>Ukupno naplaćeno (novac)</td><td /><td className="num">{fmt(s.collected.total)}</td></tr>
        </tbody>
      </table>
      <div className="kv">
        <div className="strong"><span>Gotovina za predaju</span><b>{fmt(s.collected.cashToHandOver)}</b></div>
        <div><span>Zatvoreni računi</span><b>{s.closedReceipts.count} · {fmt(s.closedReceipts.amount)}</b></div>
        <div><span>Storna</span><b>{s.voids.count} · {fmt(s.voids.amount)}</b></div>
        <div><span>Otvoreni računi na zaposlenom</span><b>{s.openOrders.length}</b></div>
      </div>
      <p className="muted small">TEST režim naplate — nije fiskalni dokument.</p>
    </div>
  );
}

export function TransferDialog({ orderIds, onClose, onDone }: { orderIds: string[]; onClose: () => void; onDone: (n: number, name: string) => void }) {
  const { me } = useAuth();
  const list = useLoad(() => api<any[]>('GET', '/staff/waiters'), []);
  const [to, setTo] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError(undefined);
    try { const r = await api('POST', '/orders/transfer', { orderIds, toUserId: to }); onDone(r.moved.length, r.toName); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Prebacivanje ${orderIds.length} računa`} onClose={onClose}>
      {list.loading ? <Spinner /> : list.error ? <ErrorBox error={list.error} /> : (
        <div className="pick-list">
          {list.data!.filter((w) => w.id !== me?.user.userId).map((w) => (
            <label key={w.id} className={`pick ${to === w.id ? 'on' : ''}`}>
              <input type="radio" name="to" checked={to === w.id} onChange={() => setTo(w.id)} />
              <span className="pick-main"><strong>{w.fullName}</strong> · {w.roleName}</span>
            </label>
          ))}
        </div>
      )}
      {error !== undefined && <ErrorBox error={error} />}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Odustani</button>
        <button className="btn primary" disabled={!to || busy} onClick={submit}>{busy ? 'Prebacujem…' : 'Prebaci'}</button>
      </div>
    </Modal>
  );
}
