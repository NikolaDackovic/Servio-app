import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtQty, time } from '../api';
import { useAuth } from '../auth';
import { useRealtime } from '../realtime';
import { ErrorBox, Spinner, useToast } from '../ui';

interface KdsItem { id: string; name: string; quantity: string; note: string | null; status: 'SENT' | 'VOIDED' | 'NEW'; readyAt: string | null; voidReason: string | null }
interface Ticket {
  id: string; orderId: string; stationId: string; station: string; batch: number; status: 'NEW' | 'IN_PROGRESS' | 'READY' | 'DONE';
  createdAt: string; startedAt: string | null; readyAt: string | null; doneAt: string | null;
  orderNumber: number; tabName: string | null; table: string | null; waiter: string; items: KdsItem[];
}
interface Station { id: string; name: string; kind: string }

const STATION_KEY = 'pos.kds.station';
const SOUND_KEY = 'pos.kds.sound';
const STATUS_LABEL: Record<Ticket['status'], string> = { NEW: 'Nova', IN_PROGRESS: 'U pripremi', READY: 'Spremno', DONE: 'Završeno' };

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } };

/** Kratak zvučni signal (Web Audio). Pregledač ga dozvoljava tek posle dodira korisnika — zato dugme "Uključi zvuk". */
function useBeep() {
  const ctx = useRef<AudioContext | null>(null);
  const [on, setOn] = useState(get(SOUND_KEY) === '1');
  const enable = () => {
    try {
      ctx.current = ctx.current ?? new AudioContext();
      void ctx.current.resume();
      setOn(true); set(SOUND_KEY, '1');
      beep(ctx.current);
    } catch { setOn(false); }
  };
  const disable = () => { setOn(false); set(SOUND_KEY, '0'); };
  const play = useCallback(() => {
    if (!on) return;
    try {
      ctx.current = ctx.current ?? new AudioContext();
      if (ctx.current.state === 'running') { beep(ctx.current); setTimeout(() => ctx.current && beep(ctx.current), 220); }
    } catch { /* bez zvuka */ }
  }, [on]);
  const blocked = on && ctx.current?.state !== 'running';
  return { on, enable, disable, play, blocked };
}
function beep(c: AudioContext) {
  const o = c.createOscillator(); const g = c.createGain();
  o.frequency.value = 880; o.type = 'square';
  g.gain.setValueAtTime(0.15, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.18);
  o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.2);
}

/** Minuti od trenutka, osvežava se svakih 15 s. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);
  return now;
}

export function Kds() {
  const { me, can, logout } = useAuth();
  const toast = useToast();
  const now = useNow();
  const [stations, setStations] = useState<Station[] | null>(null);
  const [stationId, setStationId] = useState<string | null>(get(STATION_KEY));
  const [view, setView] = useState<'active' | 'done'>('active');
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const sound = useBeep();

  useEffect(() => {
    api<Station[]>('GET', '/kds/stations').then((s) => {
      setStations(s);
      if (!stationId || !s.some((x) => x.id === stationId)) setStationId(s[0]?.id ?? null);
    }).catch(setError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!stationId) return;
    try {
      const t = await api<Ticket[]>('GET', `/kds/tickets?stationId=${stationId}&view=${view}`);
      setTickets(t); setError(undefined); setLoadedAt(Date.now());
    } catch (e) { setError(e); }
  }, [stationId, view]);
  useEffect(() => { setTickets(null); void load(); }, [load]);

  const rt = useRealtime({
    stationId,
    enabled: !!stationId,
    onEvent: (e) => {
      if (e.type === 'kds.ticket.created') sound.play();
      if (e.type.startsWith('kds.')) void load();
    },
    onReconnect: () => void load(),
  });
  // rezervno osvežavanje dok veza ne radi
  useEffect(() => {
    if (rt.status === 'open') return;
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [rt.status, load]);

  const act = async (id: string, fn: () => Promise<Ticket>) => {
    setBusy(id);
    try {
      const t = await fn();
      setTickets((list) => {
        if (!list) return list;
        const keep = view === 'active' ? t.status !== 'DONE' : t.status === 'DONE';
        return keep ? list.map((x) => (x.id === t.id ? t : x)) : list.filter((x) => x.id !== t.id);
      });
    } catch (e: any) { toast('err', e.message); void load(); } finally { setBusy(null); }
  };
  const setStatus = (t: Ticket, status: Ticket['status']) => act(t.id, () => api('POST', `/kds/tickets/${t.id}/status`, { status }));
  const toggleItem = (t: Ticket, i: KdsItem) => i.status !== 'VOIDED' && act(t.id, () => api('POST', `/kds/items/${i.id}/ready`, { ready: !i.readyAt }));

  if (!can('kds.use')) {
    return (
      <div className="login"><div className="login-card">
        <h2>KDS ekran</h2>
        <p>Korisnik <strong>{me?.user.fullName}</strong> nema pravo rada na KDS ekranu (kds.use).</p>
        <button className="btn primary block" onClick={logout}>Odjava</button>
      </div></div>
    );
  }

  const station = stations?.find((s) => s.id === stationId);
  const lostSec = rt.lostSince ? Math.round((Date.now() - rt.lostSince) / 1000) : 0;

  return (
    <div className="kds">
      <header className="kds-head">
        <div className="kds-stations">
          {stations?.map((s) => (
            <button key={s.id} className={`seg-btn ${s.id === stationId ? 'on' : ''}`} onClick={() => { setStationId(s.id); set(STATION_KEY, s.id); }}>{s.name}</button>
          ))}
          {stations && !stations.length && <span className="warn-text">Nema pripremnih pozicija sa KDS-om (ADMIN → Štampa i KDS).</span>}
        </div>
        <div className="kds-tools">
          <button className={`seg-btn ${view === 'active' ? 'on' : ''}`} onClick={() => setView('active')}>Aktivne{view === 'active' && tickets ? ` (${tickets.length})` : ''}</button>
          <button className={`seg-btn ${view === 'done' ? 'on' : ''}`} onClick={() => setView('done')}>Završene</button>
          {sound.on
            ? <button className="btn" onClick={sound.disable} title="Isključi zvuk">🔔 Zvuk uključen</button>
            : <button className="btn warn" onClick={sound.enable}>🔕 Uključi zvuk</button>}
          <span className={`conn ${rt.status}`} title="Veza sa serverom">{rt.status === 'open' ? '● Povezano' : rt.status === 'connecting' ? '● Povezivanje…' : '● Nema veze'}</span>
          <span className="muted small">{me?.user.fullName}</span>
          <button className="btn" onClick={logout}>Odjava</button>
        </div>
      </header>

      {rt.status === 'lost' && (
        <div className="kds-lost" role="alert">
          Veza sa serverom je prekinuta {lostSec > 0 ? `pre ${lostSec} s` : ''} — nove porudžbine možda NISU prikazane.
          Pokušavam ponovo; prikaz se osvežava na 10 s{loadedAt ? ` (poslednje učitavanje ${time(new Date(loadedAt).toISOString())})` : ''}.
        </div>
      )}
      {sound.on && sound.blocked && <div className="notice">Pregledač je blokirao zvuk — dodirnite „Zvuk uključen“ pa „Uključi zvuk“.</div>}
      {error !== undefined && <ErrorBox error={error} onRetry={load} />}

      {!tickets ? <Spinner label={station ? `Učitavam ${station.name}…` : 'Učitavam…'} /> : (
        <div className="kds-grid">
          {tickets.length === 0 && <div className="empty">{view === 'active' ? 'Nema porudžbina za pripremu.' : 'Nema završenih porudžbina.'}</div>}
          {tickets.map((t) => {
            const mins = Math.max(0, Math.floor((Math.max(now, Date.now()) - new Date(t.createdAt).getTime()) / 60000));
            const age = t.status === 'READY' || t.status === 'DONE' ? 'ok' : mins >= 20 ? 'late' : mins >= 10 ? 'warn' : 'fresh';
            const active = t.items.filter((i) => i.status !== 'VOIDED');
            return (
              <article key={t.id} className={`ticket st-${t.status.toLowerCase()} age-${age}`}>
                <div className="ticket-head">
                  <div>
                    <strong>{t.table ?? 'Brza prodaja'}{t.tabName ? ` · ${t.tabName}` : ''}</strong>
                    <div className="small">#{t.orderNumber} · tura {t.batch} · {t.waiter}</div>
                  </div>
                  <div className="ticket-time">
                    <strong>{mins}′</strong>
                    <div className="small">{time(t.createdAt)}</div>
                  </div>
                </div>
                <div className="ticket-status">{STATUS_LABEL[t.status]}{active.length === 0 ? ' · sve stornirano' : ''}</div>
                <ul className="ticket-items">
                  {t.items.map((i) => (
                    <li key={i.id} className={i.status === 'VOIDED' ? 'voided' : i.readyAt ? 'ready' : ''}>
                      <button disabled={busy === t.id || i.status === 'VOIDED' || view === 'done'} onClick={() => toggleItem(t, i)}>
                        <span className="q">{fmtQty(i.quantity)}×</span>
                        <span className="n">{i.name}{i.note && <em>{i.note}</em>}{i.status === 'VOIDED' && <em>STORNO{i.voidReason ? `: ${i.voidReason}` : ''}</em>}</span>
                        <span className="c">{i.status === 'VOIDED' ? '✕' : i.readyAt ? '✓' : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="ticket-actions">
                  {view === 'done' ? (
                    <button className="btn" disabled={busy === t.id} onClick={() => setStatus(t, 'READY')}>Vrati na ekran</button>
                  ) : (
                    <>
                      {t.status === 'NEW' && <button className="btn" disabled={busy === t.id} onClick={() => setStatus(t, 'IN_PROGRESS')}>Počni</button>}
                      {t.status !== 'READY' && <button className="btn primary" disabled={busy === t.id} onClick={() => setStatus(t, 'READY')}>Spremno</button>}
                      {t.status === 'READY' && <button className="btn" disabled={busy === t.id} onClick={() => setStatus(t, 'IN_PROGRESS')}>Nije spremno</button>}
                      <button className="btn primary" disabled={busy === t.id} onClick={() => setStatus(t, 'DONE')}>Završi ✓</button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
