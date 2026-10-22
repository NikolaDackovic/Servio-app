import { useEffect, useMemo, useState } from 'react';
import { addMoney, api, fmt, newIdempotencyKey, Table, time } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorBox, Modal, Spinner, useLoad, useToast } from '../ui';

const STATUS: Record<Table['status'], string> = { FREE: 'Slobodan', OCCUPIED: 'Zauzet', PARTIALLY_PAID: 'Delimično plaćen' };
const TILE_W = 120;
const TILE_H = 96;

function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

/** Mapa lokala: prostorije kao tabovi, stolovi na svojim pozicijama, plus spisak. */
export function Tables({ onOpenOrder, onGoToDay }: { onOpenOrder: (id: string) => void; onGoToDay: () => void }) {
  const toast = useToast();
  const { me } = useAuth();
  const day = useLoad(() => api('GET', '/business-days/current'), []);
  const { data, error, loading, reload } = useLoad(() => api<Table[]>('GET', '/tables'), []);
  const [area, setArea] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [chooser, setChooser] = useState<Table | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(reload, 15_000); return () => clearInterval(t); }, [reload]);

  // Prirodno sortiranje: "Sto 2" pre "Sto 10"; prostorija sa najnižim stolom je prva (glavna sala).
  const natural = (a: string, b: string) => a.localeCompare(b, 'sr', { numeric: true });
  const sorted = useMemo(() => [...(data ?? [])].sort((a, b) => natural(a.name, b.name)), [data]);
  const areas = useMemo(() => [...new Set(sorted.map((t) => t.area))], [sorted]);
  const current = area || areas[0] || '';

  const openNew = async (t: Table) => {
    setBusy(t.id);
    try { onOpenOrder((await api('POST', '/orders', { tableId: t.id, idempotencyKey: newIdempotencyKey('open') })).id); }
    catch (e: any) { toast('err', e.message); } finally { setBusy(null); }
  };
  const open = (t: Table) => {
    if (t.openOrders.length === 1) return onOpenOrder(t.openOrders[0].id);
    if (t.openOrders.length > 1) return; // izbor računa je ispod stola
    openNew(t);
  };

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data?.length) return <Empty>Nema definisanih stolova za ovaj lokal.</Empty>;

  const dayOpen = !!day.data?.day;
  const inArea = current === '__list' ? sorted : sorted.filter((t) => t.area === current);
  const maxX = Math.max(...inArea.map((t) => t.posX)) + TILE_W + 24;
  const maxY = Math.max(...inArea.map((t) => t.posY)) + TILE_H + 60;

  return (
    <div className="page wide">
      {day.data && !dayOpen && (
        <div className="notice warn row-between">
          <span><strong>Poslovni dan nije otvoren.</strong> Računi i naplata nisu mogući dok se dan ne otvori.</span>
          {me?.user.permissions.includes('day.manage') && <button className="btn sm primary" onClick={onGoToDay}>Otvori dan</button>}
        </div>
      )}
      <div className="area-tabs">
        {areas.map((a) => <button key={a} className={`area-tab ${current === a ? 'on' : ''}`} onClick={() => setArea(a)}>{a}</button>)}
        <button className={`area-tab ${current === '__list' ? 'on' : ''}`} onClick={() => setArea('__list')}>Spisak</button>
      </div>

      {current === '__list' ? (
        <table className="tbl clickable">
          <thead><tr><th>Sto</th><th>Prostorija</th><th>Status</th><th>Konobar</th><th>Otvoren</th><th className="num">Iznos</th></tr></thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.id} onClick={() => dayOpen && open(t)}>
                <td><strong>{t.name}</strong></td><td>{t.area}</td><td>{STATUS[t.status]}</td>
                <td>{t.openOrders.map((o) => o.waiterName).join(', ') || '—'}</td>
                <td>{t.openOrders[0] ? `${time(t.openOrders[0].openedAt)} (${minutesSince(t.openOrders[0].openedAt)} min)` : '—'}</td>
                <td className="num">{t.openOrders.length ? fmt(addMoney('0.00', ...t.openOrders.map((o) => o.total))) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="floor" style={{ minHeight: maxY, minWidth: Math.min(maxX, 2000) }}>
          {inArea.map((t) => {
            const total = addMoney('0.00', ...t.openOrders.map((o) => o.total));
            const since = t.openOrders[0]?.openedAt;
            return (
              <div key={t.id} className={`floor-table ${t.status.toLowerCase()}`} style={{ left: t.posX, top: t.posY, width: TILE_W }}>
                <button className="floor-main" style={{ height: TILE_H }} disabled={busy === t.id || !dayOpen}
                  onClick={() => (t.openOrders.length > 1 ? setChooser(t) : open(t))} aria-label={`${t.name}, ${STATUS[t.status]}`}>
                  <span className="ft-name">{t.name.replace(/^Sto\s*/, '')}</span>
                  {t.openOrders.length > 0 ? (
                    <>
                      <span className="ft-total">{fmt(total)}</span>
                      <span className="ft-meta">
                        {t.openOrders.length > 1 ? `${t.openOrders.length} računa` : t.openOrders[0].waiterName.split(' ')[0]} · {minutesSince(since!)}′
                      </span>
                    </>
                  ) : <span className="ft-meta">{t.seats} mesta</span>}
                </button>
                {t.openOrders.length > 0 && dayOpen && (
                  <button className="ft-add" onClick={() => openNew(t)} aria-label={`Novi račun za ${t.name}`} title="Novi račun na ovom stolu">+</button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {chooser && (
        <Modal title={`${chooser.name} — otvoreni računi`} onClose={() => setChooser(null)}>
          <div className="pick-list">
            {chooser.openOrders.map((o) => (
              <button key={o.id} className="pick" onClick={() => { setChooser(null); onOpenOrder(o.id); }}>
                <span className="pick-main"><strong>#{o.number}</strong> · {o.waiterName} · od {time(o.openedAt)}</span>
                <span className="num">{fmt(o.total)}</span>
              </button>
            ))}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setChooser(null)}>Zatvori</button>
            <button className="btn primary" onClick={() => { const t = chooser; setChooser(null); openNew(t); }}>+ Novi račun</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
