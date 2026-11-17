import { useState } from 'react';
import { api, ApiError, fmt, fmtQty, newIdempotencyKey, storage } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, KeypadDialog, Spinner, useLoad, useToast } from '../ui';

type View = 'staff' | 'sales';
const amount = (byMethod: any[], m: string) => byMethod.find((x) => x.method === m)?.amount ?? '0.00';

/** Kraj dana: šifra kasira ili menadžera, pa izveštaji. */
export function EndOfDay({ onClose }: { onClose: () => void }) {
  const { me } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const approve = async (pin: string) => {
    setBusy(true); setError(null);
    try {
      const r = await api('POST', '/auth/pin', { deviceId: storage.deviceId ?? me?.user.deviceId, pin });
      if (!r.user.permissions.includes('day.manage')) throw new ApiError(403, 'FORBIDDEN', `${r.user.fullName} nema pravo na kraj dana`);
      setToken(r.accessToken);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (!token) return <KeypadDialog title="Kraj dana" hint="Šifra kasira ili menadžera" secret minLen={1} busy={busy} error={error} onConfirm={approve} onClose={onClose} />;
  return <EndOfDayReports token={token} onClose={onClose} />;
}

/**
 * Dva dugmeta: Razduživanje (pazar svih zaposlenih: gotovina, kartica, virman, reprezentacija) i
 * Prodaja (ukupno, pa Šank, pa Kuhinja… jedno ispod drugog; štampa se kao jedan isečak).
 */
function EndOfDayReports({ token, onClose }: { token: string; onClose: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<View>('staff');
  const [busy, setBusy] = useState(false);
  const r = useLoad(() => api('GET', '/business-days/current/end-of-day', undefined, token), [token]);
  const d = r.data;

  const printAll = async () => {
    setBusy(true);
    try {
      const p = await api('POST', '/business-days/current/print-staff', { idempotencyKey: newIdempotencyKey('razd') }, token);
      toast('ok', `Pazar poslat na štampač za ${p.jobs.length} zaposlenih`);
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };

  const stations = d?.stations ?? [];
  const sumQ = (items: any[]) => items.reduce((a, i) => a + Number(i.quantity), 0);
  const sumA = (items: any[]) => items.reduce((a, i) => a + Number(i.gross ?? 0), 0);
  const allItems = stations.flatMap((s: any) => s.items);
  const printSales = async () => {
    setBusy(true);
    try { await api('POST', '/business-days/current/print-sales', { idempotencyKey: newIdempotencyKey('prodaja') }, token); toast('ok', 'Prodaja poslata na štampač'); }
    catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  return (
    <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="k-eod" role="dialog" aria-modal="true" aria-label="Kraj dana">
        <div className="kp-title">Kraj dana{d?.day ? `: ${d.day.name || ''} ${d.day.date.split('-').reverse().join('.')}.` : ''}</div>
        <div className="k-eod-btns">
          <button className={`k-eod-btn ${view === 'staff' ? 'on' : ''}`} onClick={() => setView('staff')}>RAZDUŽIVANJE<small>pazar svih zaposlenih</small></button>
          <button className={`k-eod-btn ${view === 'sales' ? 'on' : ''}`} onClick={() => setView('sales')}>PRODAJA<small>ukupno, pa šank i kuhinja</small></button>
        </div>
        <div className="k-eod-body">
          {r.loading && !d ? <Spinner /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !d ? null : view === 'staff' ? (
            d.staff.length === 0 ? <div className="kp-hint">Danas još nema smena zaposlenih.</div> : (
              <table className="bw-table">
                <thead><tr><td>Zaposleni</td><td className="num">Gotovina</td><td className="num">Kartica</td><td className="num">Virman</td><td className="num">Reprezentacija</td><td className="num">Ukupno</td><td>Po delu lokala</td></tr></thead>
                <tbody>
                  {d.staff.map((s: any) => (
                    <tr key={s.id}>
                      <td>{s.summary.fullName}{s.summary.openOrders?.length ? <small className="bw-warn"> (otvorenih: {s.summary.openOrders.length})</small> : null}</td>
                      <td className="num">{fmt(amount(s.summary.collected.byMethod, 'CASH'))}</td>
                      <td className="num">{fmt(amount(s.summary.collected.byMethod, 'CARD'))}</td>
                      <td className="num">{fmt(amount(s.summary.collected.byMethod, 'TRANSFER'))}</td>
                      <td className="num">{fmt(amount(s.summary.collected.byMethod, 'REPRESENTATION'))}</td>
                      <td className="num"><b>{fmt(s.summary.collected.total)}</b></td>
                      <td className="bw-small">{(s.summary.byStation ?? []).map((st: any) => `${st.name} ${fmt(st.amount)}`).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : stations.length === 0 ? <div className="kp-hint">Danas još nema prodaje.</div> : (
            <div className="bw-sales">
              <div className="bw-total"><span>UKUPNO PRODATO</span><b>{fmtQty(String(sumQ(allItems)))} kom · {fmt(sumA(allItems).toFixed(2))}</b></div>
              {stations.map((s: any) => (
                <div key={s.id} className="bw-cols">
                  <div className="bw-cols-title"><span>{s.name}</span><span>{fmtQty(String(sumQ(s.items)))} kom · {fmt(sumA(s.items).toFixed(2))}</span></div>
                  {s.items.map((i: any) => <div key={i.name} className="bw-qty"><span>{i.name}</span><b>{fmtQty(i.quantity)}</b></div>)}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="kp-actions">
          {view === 'staff'
            ? <button className="kp-btn ok" disabled={busy || !d?.staff.length} onClick={printAll}>{busy ? '...' : 'Štampaj razduženje svima'}</button>
            : <button className="kp-btn ok" disabled={busy || !stations.length} onClick={printSales}>{busy ? '...' : 'Štampaj prodaju'}</button>}
          <button className="kp-btn cancel" onClick={onClose}>Zatvori</button>
        </div>
      </div>
    </div>
  );
}
