import { useState } from 'react';
import { api, fmt } from '@shared/api';
import { Empty, ErrorBox, Spinner, useLoad, useToast } from '@shared/ui';

interface Row { id: string; orderId: string; orderNumber: number; total: string; provider: string; isTest: boolean; status: string; invoiceNumber: string | null; attempts: number; lastError: string | null; signedAt: string | null; createdAt: string }
const STATUS: Record<string, string> = { PENDING: 'Na čekanju', SIGNED: 'Potpisano', FAILED: 'Neuspešno', NOT_REQUIRED: 'Nije potrebno' };

/** Pregled fiskalnog reda. Stvarna fiskalizacija (PFR/ESIR) ne postoji — samo TEST adapter. */
export function Fiscal() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const list = useLoad(() => api<{ status: { provider: string; isTest: boolean; mode: string }; data: Row[] }>('GET', `/fiscal/receipts${status ? `?status=${status}` : ''}`), [status]);
  const retry = async (r: Row) => {
    try { const f = await api('POST', `/fiscal/receipts/${r.id}/retry`, {}); list.reload(); toast(f.status === 'SIGNED' ? 'ok' : 'err', f.status === 'SIGNED' ? `Potpisano: ${f.invoiceNumber}` : `Status: ${STATUS[f.status]}`); }
    catch (e: any) { toast('err', e.message); }
  };
  const st = list.data?.status;
  return (
    <div className="page">
      <div className="toolbar"><h2 style={{ margin: 0, flex: 1 }}>Fiskalizacija</h2></div>
      {st && (st.mode === 'TEST'
        ? <div className="test-banner">TEST REŽIM: fiskalni provajder je testni adapter. Brojevi računa počinju sa „TEST-“ i NISU fiskalni računi. Integracija sa PFR/ESIR sistemom Poreske uprave ne postoji.</div>
        : st.mode === 'DISABLED' ? <div className="notice warn">Fiskalizacija je isključena (FISCAL_PROVIDER=NONE). Računi se ne šalju nikome.</div> : null)}
      <p className="muted">Svaki naplaćen račun dobija zahtev u fiskalnom redu u istoj transakciji kao naplata. Naplata ne zavisi od fiskalnog sistema: ako on ne odgovori, zahtev ostaje „Na čekanju“ i ponavlja se automatski; posle trajne greške („Neuspešno“) potreban je ručni ponovni pokušaj.</p>
      <div className="toolbar">
        <select className="input" style={{ maxWidth: 220 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Svi statusi</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn" onClick={list.reload}>Osveži</button>
      </div>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Spinner /> : !list.data.data.length ? <Empty>Nema zahteva.</Empty> : (
        <table className="tbl">
          <thead><tr><th>Račun</th><th className="num">Iznos</th><th>Status</th><th>Broj</th><th className="num">Pokušaji</th><th>Vreme</th><th /></tr></thead>
          <tbody>{list.data.data.map((r) => (
            <tr key={r.id}>
              <td>#{r.orderNumber}</td><td className="num">{fmt(r.total)}</td>
              <td><span className={`badge ${r.status === 'FAILED' ? 'cancelled' : r.status === 'SIGNED' ? 'paid' : ''}`}>{STATUS[r.status] ?? r.status}</span>{r.isTest && <span className="badge"> TEST</span>}
                {r.lastError && <div className="warn-text small">{r.lastError}</div>}</td>
              <td><code>{r.invoiceNumber ?? '—'}</code></td>
              <td className="num">{r.attempts}</td>
              <td>{new Date(r.signedAt ?? r.createdAt).toLocaleString('sr-Latn-RS')}</td>
              <td>{r.status === 'FAILED' && <button className="btn sm" onClick={() => retry(r)}>Ponovi</button>}</td>
            </tr>))}
          </tbody>
        </table>
      )}
    </div>
  );
}
