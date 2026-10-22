import { useState } from 'react';
import { api, fmt, time } from '../api';
import { Empty, ErrorBox, Spinner, useLoad } from '../ui';

const LABEL = { OPEN: 'Otvoren', PAID: 'Plaćen', CANCELLED: 'Otkazan' } as const;

export function Orders({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState<'OPEN' | 'PAID' | 'CANCELLED'>('OPEN');
  const r = useLoad(() => api<any[]>('GET', `/orders?status=${status}&pageSize=100`), [status]);
  return (
    <div className="page">
      <div className="seg">
        {(['OPEN', 'PAID', 'CANCELLED'] as const).map((s) => <button key={s} className={`seg-btn ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>{LABEL[s]}</button>)}
      </div>
      {r.loading && !r.data ? <Spinner /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> :
        !r.data?.length ? <Empty>Nema računa u ovom statusu.</Empty> : (
          <table className="tbl clickable">
            <thead><tr><th>#</th><th>Sto</th><th>Konobar</th><th>Otvoren</th><th className="num">Iznos</th><th className="num">Naplaćeno</th></tr></thead>
            <tbody>
              {r.data.map((o) => (
                <tr key={o.id} onClick={() => onOpen(o.id)}>
                  <td>{o.number}</td><td>{o.tableName ?? 'Brza prodaja'}</td><td>{o.waiterName}</td><td>{time(o.openedAt)}</td>
                  <td className="num">{fmt(o.total)}</td><td className="num">{fmt(o.paidTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}
