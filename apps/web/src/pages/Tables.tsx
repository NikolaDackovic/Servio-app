import { CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addMoney, api, fmt, newIdempotencyKey, Table, time } from '../api';
import { useRealtime } from '../realtime';
import { Empty, ErrorBox, Spinner, useLoad, useRefresh, useToast } from '../ui';

const STATUS: Record<Table['status'], string> = { FREE: 'Slobodan', OCCUPIED: 'Zauzet', PARTIALLY_PAID: 'Delimično plaćen' };

/** "Sto 8" → "008"; ostali nazivi (npr. "Šank 2", "S08") ostaju kakvi jesu. */
export function tableLabel(name: string) {
  const m = /^sto\s*(\d+)$/i.exec(name.trim());
  return m ? m[1].padStart(3, '0') : name;
}

function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

/** Kratko ime konobara za pločicu: "Goran Lazarević" → "Goran Laz." */
const shortName = (n: string) => { const [a, b] = n.split(' '); return b ? `${a} ${b.slice(0, 3)}.` : a; };

/** Sastavni deo mape: crtež stola (pločica) - koristi ga i editor u ADMIN-u. */
export function TableTile({ t, scale, style, onClick, disabled, children }: {
  t: Pick<Table, 'name' | 'shape' | 'width' | 'height' | 'seats'> & Partial<Pick<Table, 'status' | 'openOrders' | 'color'>>;
  scale: number; style?: CSSProperties; onClick?: () => void; disabled?: boolean; children?: React.ReactNode;
}) {
  const open = t.openOrders ?? [];
  const status = (t.status ?? 'FREE').toLowerCase();
  const total = addMoney('0.00', ...open.map((o) => o.total));
  const waiters = [...new Set(open.map((o) => o.waiterName))];
  const body = (
    <>
      <span className="k-chairs" aria-hidden />
      <span className="k-top-surface" aria-hidden />
      {open.length > 0 ? (
        <span className="k-card">
          <small>{waiters.map(shortName).join(', ')}</small>
          <b>{tableLabel(t.name)}</b>
          <em>{fmt(total)}{open.length > 1 ? ` · ${open.length} ture` : ''}</em>
        </span>
      ) : <span className="k-tnum">{tableLabel(t.name)}</span>}
      {children}
    </>
  );
  const cls = `k-table ${t.shape === 'ROUND' ? 'round' : 'rect'} ${t.width < t.height ? 'tall' : ''} ${status} ${t.color ? 'colored' : ''}`;
  const st = { ...style, width: t.width * scale, height: t.height * scale, ['--s' as any]: scale, ...(t.color ? { ['--tc' as any]: t.color } : {}) };
  return onClick
    ? <button type="button" className={cls} style={st} onClick={onClick} disabled={disabled}
        aria-label={`${t.name}, ${STATUS[t.status ?? 'FREE']}${open.length ? `, ${fmt(total)}` : ''}`}
        title={open.length ? `${t.name} · ${waiters.join(', ')} · otvoren ${time(open[0].openedAt)} (${minutesSince(open[0].openedAt)} min)` : `${t.name} · ${t.seats} mesta`}>{body}</button>
    : <div className={cls} style={st}>{body}</div>;
}

/** Stil podloge mape: slika pozadine prostorije iz ADMIN-a, ako postoji. */
export function floorBg(img?: string | null): { className: string; style: CSSProperties } {
  return img ? { className: 'k-floor bg', style: { ['--floor-bg' as any]: `url("${img}")` } } : { className: 'k-floor', style: {} };
}

/** Veličina mape (u jedinicama mape) za zadate stolove - ista u kasi i u editoru. */
export function floorSize(list: Pick<Table, 'posX' | 'posY' | 'width' | 'height'>[]) {
  return {
    w: Math.max(900, ...list.map((t) => t.posX + t.width + 60)),
    h: Math.max(520, ...list.map((t) => t.posY + t.height + 60)),
  };
}

/** Mapa lokala: prostorije kao plavi tabovi, stolovi kao pločice na svojim pozicijama (raspored iz ADMIN-a), plus spisak. */
export function Tables({ onOpenOrder, onGoToDay, guard }: {
  onOpenOrder: (id: string) => void; onGoToDay: () => void;
  /** PIN pre ulaska na sto (podešavanje kase); posle uspešnog PIN-a poziva `go` sa zaposlenim. */
  guard?: (t: Table, go: (user: { id: string; permissions: string[] }) => void) => void;
}) {
  const toast = useToast();
  const { key } = useRefresh();
  const day = useLoad(() => api('GET', '/business-days/current'), [key]);
  const { data, error, loading, reload, setData } = useLoad(() => api<Table[]>('GET', '/tables'), [key]);
  const backgrounds = useLoad(() => api<{ floorBackgrounds: Record<string, string> }>('GET', '/settings/kasa').then((s) => s.floorBackgrounds ?? {}), [key]);
  // Mapa se osvežava kada se bilo koji račun lokala promeni na drugom uređaju (tiho, bez treperenja).
  const silent = () => api<Table[]>('GET', '/tables').then(setData).catch(() => undefined);
  /** Otvoreni brzi računi (bez stola): imaju svoj tab BRZI, da ne ostanu nevidljivi i nenaplaćeni. */
  const quickL = useLoad(() => api<any[]>('GET', '/orders?status=OPEN&nonEmpty=true&pageSize=200').then((l) => l.filter((o) => !o.tableId)), [key]);
  const quick = quickL.data ?? [];
  useRealtime({
    onEvent: (e) => { if (e.type === 'order.updated') { void silent(); void quickL.reload(); } },
    onReconnect: () => { void silent(); void quickL.reload(); },
  });
  const [area, setArea] = useState<string>(() => { try { return localStorage.getItem('pos.area') ?? ''; } catch { return ''; } });
  const [busy, setBusy] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(reload, 15_000); return () => clearInterval(t); }, [reload]);

  const natural = (a: string, b: string) => a.localeCompare(b, 'sr', { numeric: true });
  const sorted = useMemo(() => [...(data ?? [])].sort((a, b) => natural(a.name, b.name)), [data]);
  const areas = useMemo(() => [...new Set(sorted.map((t) => t.area))], [sorted]);
  const current = area === '__list' || area === '__quick' || areas.includes(area) ? area : areas[0] || '';
  const pick = (a: string) => { setArea(a); try { localStorage.setItem('pos.area', a); } catch { /* ignore */ } };

  const openNew = async (t: Table) => {
    setBusy(t.id);
    try { onOpenOrder((await api('POST', '/orders', { tableId: t.id, idempotencyKey: newIdempotencyKey('open') })).id); }
    catch (e: any) { toast('err', e.message); } finally { setBusy(null); }
  };
  /**
   * Sto sa računima otvara prvu turu (ostale ture su tabovi u ekranu stola); prazan sto otvara novi račun.
   * Sa PIN-om za svaki sto (`guard`), sto se otvara kao konobar čiji je PIN; konobar bez prava na tuđe račune
   * ne ulazi na tuđi sto.
   */
  const go = async (t: Table, user?: { id: string; permissions: string[] }) => {
    if (!t.openOrders.length) return openNew(t);
    // porudžbina gosta preko QR koda: konobar koji otvori sto preuzima račun (posle ga naplaćuje kao svoj)
    const qr = t.openOrders.find((o: any) => o.qrGuest);
    if (qr) {
      try { await api('POST', `/orders/${qr.id}/claim-qr`); return onOpenOrder(qr.id); } catch { /* već preuzet - dalje kao obično */ }
    }
    if (user && !user.permissions.includes('order.read_all')) {
      const own = t.openOrders.find((o) => o.waiterId === user.id);
      if (!own) return toast('err', `Sto ${tableLabel(t.name)} vodi ${[...new Set(t.openOrders.map((o) => o.waiterName))].join(', ')}`);
      return onOpenOrder(own.id);
    }
    onOpenOrder(t.openOrders[0].id);
  };
  const open = (t: Table) => (guard ? guard(t, (user) => go(t, user)) : go(t));
  const openQuick = (o: any) => open({ name: `BRZI #${o.number}`, openOrders: [o] } as any);

  // Mapa se skalira tako da popuni raspoloživi prostor.
  const floorRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = floorRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  });

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data?.length) return <Empty>Nema definisanih stolova. Stolovi se dodaju u ADMIN-u → Mapa stolova.</Empty>;

  const dayOpen = !!day.data?.day;
  const inArea = sorted.filter((t) => t.area === current);
  const size = floorSize(inArea);
  // Mapa se uvek uklapa u ekran (bez skrolovanja); tekst na stolovima ima najmanju čitljivu veličinu (kasa.css).
  const scale = box.w && box.h ? Math.min(box.w / size.w, box.h / size.h) : 1;

  return (
    <div className="k-floor-page">
      <div className="k-areas">
        <button className={`k-area list ${current === '__list' ? 'on' : ''}`} onClick={() => pick('__list')}>SPISAK</button>
        {areas.map((a) => <button key={a} className={`k-area ${current === a ? 'on' : ''}`} onClick={() => pick(a)}>{a}</button>)}
        {quick.length > 0 && <button className={`k-area quick ${current === '__quick' ? 'on' : ''}`} onClick={() => pick('__quick')}>BRZI ({quick.length})</button>}
      </div>

      {current === '__quick' ? (
        <div className="k-list">
          {quick.map((o) => (
            <button key={o.id} className="k-list-item occupied" onClick={() => openQuick(o)}>
              <b>BRZI #{o.number}</b>
              <span className="k-list-area">brzi račun</span>
              <span>{o.waiterName}</span>
              <span className="k-list-meta">{time(o.openedAt)} · {minutesSince(o.openedAt)} min</span>
              <strong>{fmt(o.total)}</strong>
            </button>
          ))}
        </div>
      ) : current === '__list' ? (
        <div className="k-list">
          {sorted.map((t) => {
            const total = addMoney('0.00', ...t.openOrders.map((o) => o.total));
            return (
              <button key={t.id} className={`k-list-item ${t.status.toLowerCase()}`} disabled={!dayOpen || busy === t.id} onClick={() => open(t)}>
                <b>{tableLabel(t.name)}</b>
                <span className="k-list-area">{t.area}</span>
                {t.openOrders.length > 0 ? (
                  <>
                    <span>{[...new Set(t.openOrders.map((o) => o.waiterName))].join(', ')}</span>
                    <span className="k-list-meta">{time(t.openOrders[0].openedAt)} · {minutesSince(t.openOrders[0].openedAt)} min{t.openOrders.length > 1 ? ` · ${t.openOrders.length} ture` : ''}</span>
                    <strong>{fmt(total)}</strong>
                  </>
                ) : <span className="k-list-meta">slobodan · {t.seats} mesta</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="k-floor-wrap" ref={floorRef}>
          <div className={floorBg(backgrounds.data?.[current]).className} style={{ ...floorBg(backgrounds.data?.[current]).style, width: size.w * scale, height: size.h * scale }}>
            {inArea.map((t) => (
              <TableTile key={t.id} t={t} scale={scale} disabled={busy === t.id || !dayOpen} onClick={() => open(t)}
                style={{ position: 'absolute', left: t.posX * scale, top: t.posY * scale }} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
