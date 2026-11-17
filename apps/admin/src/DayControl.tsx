import { useState } from 'react';
import { api, fmt } from '@shared/api';
import { ErrorBox, Spinner, useLoad, useToast } from '@shared/ui';
import { useTab } from './tabs';

interface Day { id: string; date: string; name: string; status: string; openedAt: string }

/**
 * Otvaranje i zatvaranje smene (poslovnog dana) iz ADMIN-a - npr. konobar sa telefona.
 * Zatvaranje traži da su svi računi naplaćeni i smene kasa zatvorene (prebrojana gotovina) - to se radi na kasi.
 */
export function DayControl() {
  const toast = useToast();
  const tab = useTab();
  const cur = useLoad(() => api<{ day: Day | null; sales?: any }>('GET', '/business-days/current'), []);
  const next = useLoad(() => api<{ date: string; name: string }>('GET', '/business-days/next'), []);
  const [f, setF] = useState<{ date: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const v = f ?? next.data ?? { date: '', name: '' };
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true); setErr(undefined);
    try { await fn(); toast('ok', msg); cur.reload(); next.reload(); setF(null); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (cur.loading && !cur.data) return <Spinner />;
  const d = cur.data?.day;
  const total = cur.data?.sales?.payments?.total;
  return (
    <div className="page day-ctl">
      <section className="card">
        {d ? (
          <>
            <h3>Otvorena smena: {d.name} {d.date.split('-').reverse().join('.')}.</h3>
            <p className="muted">Otvorena {new Date(d.openedAt).toLocaleString('sr-Latn-RS')}{total ? ` · naplaćeno do sada ${fmt(total)}` : ''}.</p>
            <p className="small">Zatvaranje (kraj dana) je moguće kada su svi stolovi naplaćeni i kada su smene na kasama zatvorene (prebrojana gotovina na kasi).</p>
            <button className="btn danger" disabled={busy} onClick={() => window.confirm(`Zatvoriti smenu ${d.name}? Posle zatvaranja kasa ne radi do otvaranja nove smene.`) && void run(() => api('POST', '/business-days/current/close', {}), 'Smena je zatvorena')}>
              Zatvori smenu
            </button>
          </>
        ) : (
          <>
            <h3>Nema otvorene smene</h3>
            <p className="muted">Kasa ne radi dok se ne otvori smena.</p>
            <div className="day-ctl-form">
              <label>Datum<input type="date" className="input" value={v.date} onChange={(e) => setF({ ...v, date: e.target.value })} /></label>
              <label>Naziv smene<input className="input" value={v.name} maxLength={40} onChange={(e) => setF({ ...v, name: e.target.value })} /></label>
            </div>
            <button className="btn primary" disabled={busy || !v.date} onClick={() => void run(() => api('POST', '/business-days/open', { date: v.date, name: v.name.trim() || undefined }), 'Smena je otvorena')}>
              Otvori smenu
            </button>
          </>
        )}
        {err !== undefined && <ErrorBox error={err} />}
      </section>
      <div className="bar"><div className="bar-left" /><div className="bar-right"><button className="btn" onClick={cur.reload}>Osveži</button><button className="btn" onClick={tab.close}>Zatvori</button></div></div>
    </div>
  );
}
