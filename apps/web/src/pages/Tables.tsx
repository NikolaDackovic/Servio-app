import { useEffect, useState } from 'react';
import { addMoney, api, fmt, newIdempotencyKey, Table, time } from '../api';
import { Empty, ErrorBox, Spinner, useLoad, useToast } from '../ui';

const STATUS: Record<Table['status'], string> = { FREE: 'Slobodan', OCCUPIED: 'Zauzet', PARTIALLY_PAID: 'Delimično plaćen' };

function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

export function Tables({ onOpenOrder }: { onOpenOrder: (id: string) => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api<Table[]>('GET', '/tables'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(reload, 15_000); return () => clearInterval(t); }, [reload]);

  const open = async (t: Table) => {
    if (t.openOrders.length === 1) return onOpenOrder(t.openOrders[0].id);
    if (t.openOrders.length > 1) return; // izbor računa prikazan ispod stola
    setBusy(t.id);
    try {
      const o = await api('POST', '/orders', { tableId: t.id, idempotencyKey: newIdempotencyKey('open') });
      onOpenOrder(o.id);
    } catch (e: any) { toast('err', e.message); } finally { setBusy(null); }
  };

  const newOnTable = async (t: Table) => {
    setBusy(t.id);
    try { onOpenOrder((await api('POST', '/orders', { tableId: t.id, idempotencyKey: newIdempotencyKey('open') })).id); }
    catch (e: any) { toast('err', e.message); } finally { setBusy(null); }
  };

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data?.length) return <Empty>Nema definisanih stolova za ovaj lokal.</Empty>;

  const areas = [...new Set(data.map((t) => t.area))];
  return (
    <div className="page">
      {areas.map((area) => (
        <section key={area}>
          <h3 className="area-title">{area}</h3>
          <div className="tables-grid">
            {data.filter((t) => t.area === area).map((t) => {
              const total = addMoney('0.00', ...t.openOrders.map((o) => o.total));
              const since = t.openOrders[0]?.openedAt;
              return (
                <div key={t.id} className={`table-card ${t.status.toLowerCase()}`}>
                  <button className="table-main" disabled={busy === t.id} onClick={() => open(t)}>
                    <span className="table-name">{t.name}</span>
                    <span className="table-status">{STATUS[t.status]}</span>
                    {t.openOrders.length > 0 && (
                      <>
                        <span className="table-total">{fmt(total)}</span>
                        <span className="table-meta">{t.openOrders[0].waiterName} · {minutesSince(since!)} min · od {time(since!)}</span>
                      </>
                    )}
                  </button>
                  {t.openOrders.length > 1 && (
                    <div className="table-orders">
                      {t.openOrders.map((o) => <button key={o.id} className="btn sm" onClick={() => onOpenOrder(o.id)}>#{o.number} · {fmt(o.total)}</button>)}
                    </div>
                  )}
                  {t.openOrders.length > 0 && <button className="btn ghost sm" onClick={() => newOnTable(t)}>+ Novi račun</button>}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
