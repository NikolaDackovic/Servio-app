import { useState } from 'react';
import { api, fmt, fmtQty } from '../api';
import { Empty, ErrorBox, Spinner, useLoad } from '../ui';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date());
const METHOD: Record<string, string> = { CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Virman' };

export function Report() {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const r = useLoad(() => api('GET', `/reports/sales?from=${from}&to=${to}`), [from, to]);
  const d = r.data;

  return (
    <div className="page">
      <div className="toolbar">
        <label>Od <input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Do <input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn" onClick={r.reload}>Osveži</button>
      </div>
      {r.loading && !d ? <Spinner /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : d && (
        <>
          {d.payments.containsTestPayments && <div className="test-banner">Period sadrži TEST naplate — nisu stvarne finansijske transakcije.</div>}
          <div className="stats">
            <div className="stat"><span>Promet (zatvoreni računi)</span><b>{fmt(d.sales.gross)}</b></div>
            <div className="stat"><span>Broj računa</span><b>{d.sales.orders}</b></div>
            <div className="stat"><span>Prosečan račun</span><b>{fmt(d.sales.averageOrder)}</b></div>
            <div className="stat"><span>Naplaćeno u periodu</span><b>{fmt(d.payments.total)}</b></div>
            <div className="stat"><span>Storna</span><b>{d.voids.count} · {fmt(d.voids.amount)}</b></div>
            <div className="stat"><span>Otvoreni računi sada</span><b>{d.openOrdersNow.count} · {fmt(d.openOrdersNow.total)}</b></div>
          </div>
          <div className="grid2">
            <section className="card">
              <h3>Načini plaćanja</h3>
              {d.payments.byMethod.length === 0 ? <Empty>Nema naplata.</Empty> : (
                <table className="tbl"><tbody>
                  {d.payments.byMethod.map((p: any) => <tr key={p.method + p.mode}><td>{METHOD[p.method] ?? p.method}{p.mode === 'TEST' ? ' (TEST)' : ''}</td><td className="num">{p.count}</td><td className="num">{fmt(p.amount)}</td></tr>)}
                </tbody></table>
              )}
            </section>
            <section className="card">
              <h3>Porez</h3>
              {d.taxes.length === 0 ? <Empty>Nema prometa.</Empty> : (
                <table className="tbl"><thead><tr><th>Oznaka</th><th className="num">Osnovica</th><th className="num">PDV</th><th className="num">Ukupno</th></tr></thead><tbody>
                  {d.taxes.map((t: any) => <tr key={t.label}><td>{t.label} ({t.rate}%)</td><td className="num">{fmt(t.net)}</td><td className="num">{fmt(t.tax)}</td><td className="num">{fmt(t.gross)}</td></tr>)}
                </tbody></table>
              )}
            </section>
            <section className="card">
              <h3>Prodaja po proizvodu</h3>
              {d.byProduct.length === 0 ? <Empty>Nema prodaje.</Empty> : (
                <table className="tbl"><tbody>
                  {d.byProduct.map((p: any) => <tr key={p.productId}><td>{p.name}</td><td className="num">{fmtQty(p.quantity)}</td><td className="num">{fmt(p.gross)}</td></tr>)}
                </tbody></table>
              )}
            </section>
            <section className="card">
              <h3>Po zaposlenom</h3>
              {d.byWaiter.length === 0 ? <Empty>Nema prodaje.</Empty> : (
                <table className="tbl"><tbody>
                  {d.byWaiter.map((w: any) => <tr key={w.waiterId}><td>{w.name}</td><td className="num">{w.orders}</td><td className="num">{fmt(w.gross)}</td></tr>)}
                </tbody></table>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
