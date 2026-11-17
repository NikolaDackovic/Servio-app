import { useState } from 'react';
import { api, fmt, time } from '../api';
import { Empty, ErrorBox, Spinner, useLoad } from '../ui';
import { Specification } from './MyShift';

const MONTHS = ['Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun', 'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar'];
const DOW = ['Pon', 'Uto', 'Sre', 'Čet', 'Pet', 'Sub', 'Ned'];
const METHOD: Record<string, string> = { CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Virman', REPRESENTATION: 'Reprezentacija' };

const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date()).slice(0, 7);
function shift(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Kalendar poslovnih dana: promet po danu, klik na dan → detalji. */
export function Calendar({ onShowDay }: { onShowDay: (id: string) => void }) {
  const [month, setMonth] = useState(thisMonth());
  const r = useLoad(() => api<any[]>('GET', `/business-days?month=${month}`), [month]);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7; // ponedeljak = 0
  const byDate = new Map((r.data ?? []).map((d) => [d.date, d]));

  return (
    <div className="page">
      <div className="toolbar">
        <button className="btn" onClick={() => setMonth(shift(month, -1))}>‹</button>
        <h2 className="month-title">{MONTHS[m - 1]} {y}</h2>
        <button className="btn" onClick={() => setMonth(shift(month, 1))}>›</button>
        <button className="btn ghost" onClick={() => setMonth(thisMonth())}>Ovaj mesec</button>
      </div>
      {r.loading && !r.data ? <Spinner /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <div className="cal">
          {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
          {Array.from({ length: offset }, (_, i) => <div key={`e${i}`} className="cal-cell empty" />)}
          {Array.from({ length: daysIn }, (_, i) => {
            const date = `${month}-${String(i + 1).padStart(2, '0')}`;
            const d = byDate.get(date);
            return (
              <button key={date} className={`cal-cell ${d ? d.status.toLowerCase() : 'none'}`} disabled={!d} onClick={() => d && onShowDay(d.id)}>
                <span className="cal-num">{i + 1}</span>
                {d && (
                  <>
                    <span className="cal-gross">{fmt(d.gross)}</span>
                    <span className="cal-meta">{d.orders} rač. · {d.status === 'OPEN' ? 'otvoren' : 'zaključen'}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      )}
      {r.data && r.data.length === 0 && <Empty>U ovom mesecu nema poslovnih dana.</Empty>}
    </div>
  );
}

/** Detalji poslovnog dana: obračun, porez, kase, smene zaposlenih, link na račune. */
export function DayDetail({ dayId, onBack, onReceipts }: { dayId: string; onBack: () => void; onReceipts: (dayId: string) => void }) {
  const r = useLoad(() => api('GET', `/business-days/${dayId}`), [dayId]);
  if (r.loading && !r.data) return <Spinner />;
  if (r.error) return <div className="page"><ErrorBox error={r.error} onRetry={r.reload} /></div>;
  const { day, sales: s, cashShifts, staffShifts } = r.data;
  return (
    <div className="page">
      <div className="toolbar no-print">
        <button className="btn" onClick={onBack}>← Nazad</button>
        <button className="btn" onClick={() => onReceipts(day.id)}>Računi ovog dana</button>
        <button className="btn ghost" onClick={() => window.print()}>Štampaj (preko pregledača)</button>
      </div>
      <h2>Poslovni dan {day.date.split('-').reverse().join('.')}. <span className={`badge ${day.status === 'OPEN' ? 'open' : 'paid'}`}>{day.status === 'OPEN' ? 'Otvoren' : 'Zaključen'}</span></h2>
      <p className="muted small">Otvoren {new Date(day.openedAt).toLocaleString('sr-Latn-RS')}{day.closedAt ? ` · zaključen ${new Date(day.closedAt).toLocaleString('sr-Latn-RS')}` : ''}</p>
      {s.payments.containsTestPayments && <div className="test-banner">Dan sadrži TEST naplate - nisu fiskalni računi ni stvarne transakcije.</div>}
      <div className="stats">
        <div className="stat"><span>Promet</span><b>{fmt(s.sales.gross)}</b></div>
        <div className="stat"><span>Broj računa</span><b>{s.sales.orders}</b></div>
        <div className="stat"><span>Naplaćeno</span><b>{fmt(s.payments.total)}</b></div>
        <div className="stat"><span>Storna</span><b>{s.voids.count} · {fmt(s.voids.amount)}</b></div>
        <div className="stat"><span>Popusti</span><b>{s.discounts?.count ?? 0} · {fmt(s.discounts?.amount ?? '0.00')}</b></div>
      </div>
      <div className="grid2">
        <section className="card">
          <h3>Načini plaćanja</h3>
          <table className="tbl"><tbody>
            {s.payments.byMethod.map((p: any) => <tr key={p.method + p.mode}><td>{METHOD[p.method]}{p.mode === 'TEST' ? ' (TEST)' : ''}</td><td className="num">{p.count}</td><td className="num">{fmt(p.amount)}</td></tr>)}
          </tbody></table>
        </section>
        <section className="card">
          <h3>Porez</h3>
          <table className="tbl"><thead><tr><th>Oznaka</th><th className="num">Osnovica</th><th className="num">PDV</th><th className="num">Ukupno</th></tr></thead><tbody>
            {s.taxes.map((t: any) => <tr key={t.label}><td>{t.label} ({t.rate}%)</td><td className="num">{fmt(t.net)}</td><td className="num">{fmt(t.tax)}</td><td className="num">{fmt(t.gross)}</td></tr>)}
          </tbody></table>
        </section>
        <section className="card">
          <h3>Kase (gotovina)</h3>
          {cashShifts.length === 0 ? <Empty>Nije bilo smena kase.</Empty> : (
            <table className="tbl"><thead><tr><th>Otvorena</th><th className="num">Početno</th><th className="num">Očekivano</th><th className="num">Prebrojano</th><th className="num">Razlika</th></tr></thead><tbody>
              {cashShifts.map((c: any) => (
                <tr key={c.shift.id}><td>{time(c.shift.openedAt)}{c.shift.closedAt ? `-${time(c.shift.closedAt)}` : ' (otvorena)'}</td>
                  <td className="num">{fmt(c.shift.openingCash)}</td><td className="num">{fmt(c.shift.expectedCash ?? c.expectedCash)}</td>
                  <td className="num">{fmt(c.shift.countedCash)}</td><td className="num">{fmt(c.shift.difference)}</td></tr>
              ))}
            </tbody></table>
          )}
        </section>
        <section className="card">
          <h3>Po konobaru (zaključeni računi)</h3>
          <table className="tbl"><tbody>
            {s.byWaiter.map((w: any) => <tr key={w.waiterId}><td>{w.name}</td><td className="num">{w.orders}</td><td className="num">{fmt(w.gross)}</td></tr>)}
          </tbody></table>
        </section>
      </div>
      <h3>Smene zaposlenih</h3>
      {staffShifts.length === 0 ? <Empty>Nema smena zaposlenih.</Empty> : (
        <div className="grid2">{staffShifts.map((st: any) => <Specification key={st.id} summary={st} title={`${st.fullName} - ${st.status === 'OPEN' ? 'u toku' : 'završena'}`} />)}</div>
      )}
    </div>
  );
}
