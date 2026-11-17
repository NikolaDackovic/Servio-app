import { useState } from 'react';
import { api, ApiError, fmt, time } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Modal, Spinner, useLoad, useToast } from '../ui';
import { Shift } from './Shift';

/** Poslovni dan: otvaranje, stanje, zaključak - i smena kase (gotovina) ispod. */
export function Day({ onShowDay }: { onShowDay?: (id: string) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const cur = useLoad(() => api('GET', '/business-days/current'), []);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<ApiError | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const openDay = async () => {
    setBusy(true);
    try { await api('POST', '/business-days/open', {}); toast('ok', 'Poslovni dan je otvoren'); cur.reload(); }
    catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  const closeDay = async () => {
    setConfirmClose(false); setBusy(true);
    try {
      const d = await api('POST', '/business-days/current/close');
      toast('ok', `Dan ${d.date.split('-').reverse().join('.')}. je zaključen`);
      cur.reload();
      if (onShowDay) onShowDay(d.id);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'DAY_HAS_OPEN_ORDERS' || err.code === 'DAY_HAS_OPEN_CASH_SHIFTS') setBlocked(err);
      else toast('err', err.message);
    } finally { setBusy(false); }
  };

  if (cur.loading && !cur.data) return <Spinner />;
  if (cur.error) return <ErrorBox error={cur.error} onRetry={cur.reload} />;
  const d = cur.data.day;
  const s = cur.data.sales;

  return (
    <div className="page narrow">
      {!d ? (
        <div className="card">
          <h3>Poslovni dan nije otvoren</h3>
          <p className="muted">Otvaranjem dana počinje rad kase. Sav promet do zaključka pripada ovom danu, i posle ponoći.</p>
          {can('day.manage') ? <button className="btn primary lg" disabled={busy} onClick={openDay}>Otvori poslovni dan</button>
            : <p className="notice">Dan otvara kasir ili menadžer.</p>}
        </div>
      ) : (
        <div className="card">
          <div className="row-between">
            <h3>Poslovni dan {d.date.split('-').reverse().join('.')}.</h3>
            <span className="badge open">Otvoren od {time(d.openedAt)}</span>
          </div>
          <div className="stats compact">
            <div className="stat"><span>Promet</span><b>{fmt(s.sales.gross)}</b></div>
            <div className="stat"><span>Računa</span><b>{s.sales.orders}</b></div>
            <div className="stat"><span>Naplaćeno</span><b>{fmt(s.payments.total)}</b></div>
            <div className="stat"><span>Otvoreni računi</span><b>{s.openOrdersNow.count} · {fmt(s.openOrdersNow.total)}</b></div>
          </div>
          <div className="btn-row">
            {onShowDay && <button className="btn" onClick={() => onShowDay(d.id)}>Detalji dana</button>}
            {can('day.manage') && <button className="btn primary" disabled={busy} onClick={() => setConfirmClose(true)}>Zaključi dan…</button>}
          </div>
        </div>
      )}

      {d && <Shift />}

      {confirmClose && (
        <Modal title="Zaključak dana" onClose={() => setConfirmClose(false)}>
          <p>Zaključak čuva konačan obračun dana i zatvara smene svih zaposlenih. Posle toga se u ovaj dan više ne može kucati.</p>
          <p className="muted small">Uslovi: nema otvorenih računa i sve smene kasa su zatvorene (prebrojana gotovina).</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmClose(false)}>Odustani</button>
            <button className="btn primary" onClick={closeDay}>Zaključi dan</button>
          </div>
        </Modal>
      )}
      {blocked && (
        <Modal title="Dan još ne može da se zaključi" onClose={() => setBlocked(null)}>
          <p className="warn-text"><strong>{blocked.message}</strong></p>
          {(blocked.details as any)?.openOrders && (
            <table className="tbl"><tbody>
              {(blocked.details as any).openOrders.map((o: any) => (
                <tr key={o.id}><td>#{o.number}</td><td>{o.tableName ?? 'Brza prodaja'}</td><td>{o.waiterName}</td><td className="num">{fmt(o.total)}</td></tr>
              ))}
            </tbody></table>
          )}
          {(blocked.details as any)?.openShifts && (
            <ul>{(blocked.details as any).openShifts.map((s: any) => <li key={s.id}>{s.deviceName} - otvorena od {time(s.openedAt)}</li>)}</ul>
          )}
          <div className="modal-actions"><button className="btn primary" onClick={() => setBlocked(null)}>U redu</button></div>
        </Modal>
      )}
    </div>
  );
}
