import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtQty, time } from '../api';
import { useAuth } from '../auth';
import { useRealtime } from '../realtime';
import { ErrorBox, Spinner, useToast } from '../ui';

interface KdsItem { id: string; name: string; quantity: string; note: string | null; status: 'SENT' | 'VOIDED' | 'NEW'; readyAt: string | null; voidReason: string | null; categoryId: string }
interface Ticket {
  id: string; orderId: string; stationId: string; station: string; batch: number; status: 'NEW' | 'IN_PROGRESS' | 'READY' | 'DONE';
  createdAt: string; startedAt: string | null; readyAt: string | null; doneAt: string | null;
  orderNumber: number; tabName: string | null; table: string | null; waiter: string; items: KdsItem[];
}
interface Station { id: string; name: string; kind: string; groups: { id: string; name: string }[] }

/** Podešavanja ovog KDS ekrana (čuvaju se na uređaju - svaki ekran u kuhinji/šanku može imati svoje). */
export interface KdsSettings {
  theme: 'dark' | 'light';
  /** Kartice u bojama statusa (nova zelena, u pripremi žuta, kasni crvena) ili klasične. */
  cards: 'color' | 'classic';
  font: number;                 // razmera slova (0.8 - 1.6)
  warnAfter: number;            // sekunde do žute boje
  lateAfter: number;            // sekunde do crvene boje
  columns: number;              // 0 = automatski
  flow: 'rows' | 'columns';     // redom levo-desno ili kolonama odozgo nadole
  groups: Record<string, string[] | null>; // pozicija → izabrane grupe (null = sve)
}
const DEFAULTS: KdsSettings = { theme: 'dark', cards: 'color', font: 1, warnAfter: 600, lateAfter: 1200, columns: 0, flow: 'rows', groups: {} };
const STATION_KEY = 'pos.kds.station';
const SOUND_KEY = 'pos.kds.sound';
const SETTINGS_KEY = 'pos.kds.settings';
const STATUS_LABEL: Record<Ticket['status'], string> = { NEW: 'Nova', IN_PROGRESS: 'U pripremi', READY: 'Spremno', DONE: 'Završeno' };

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } };
function loadSettings(): KdsSettings {
  try { return { ...DEFAULTS, ...JSON.parse(get(SETTINGS_KEY) ?? '{}') }; } catch { return DEFAULTS; }
}

/** Kratak zvučni signal (Web Audio). Pregledač ga dozvoljava tek posle dodira korisnika - zato dugme "Uključi zvuk". */
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

/** Trenutno vreme, osvežava se svakih 5 s (tajmeri mogu biti u sekundama). */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  return now;
}

/** "7′" do sat vremena, zatim "1h 05′". */
const fmtAge = (sec: number) => { const m = Math.floor(sec / 60); return m < 60 ? `${m}′` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}′`; };

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
  const [settings, setSettings] = useState<KdsSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const sound = useBeep();
  const save = (s: KdsSettings) => { setSettings(s); set(SETTINGS_KEY, JSON.stringify(s)); };

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

  // Filter grupa (podešavanja): kartica se prikazuje samo sa stavkama izabranih grupa.
  const allowed = stationId ? settings.groups[stationId] ?? null : null;
  const shown = useMemo(() => (tickets ?? [])
    .map((t) => (allowed ? { ...t, items: t.items.filter((i) => allowed.includes(i.categoryId)) } : t))
    .filter((t) => t.items.length > 0), [tickets, allowed]);

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
  const gridStyle: CSSProperties = settings.flow === 'columns'
    ? { columnCount: settings.columns || undefined, columnWidth: settings.columns ? undefined : '280px' }
    : { gridTemplateColumns: settings.columns ? `repeat(${settings.columns}, minmax(0, 1fr))` : undefined };

  return (
    <div className={`kds kds-${settings.theme} cards-${settings.cards}`} style={{ ['--kds-font' as any]: settings.font }}>
      <header className="kds-head">
        <div className="kds-stations">
          {stations?.map((s) => (
            <button key={s.id} className={`kds-tab ${s.id === stationId ? 'on' : ''}`} onClick={() => { setStationId(s.id); set(STATION_KEY, s.id); }}>
              {s.name}{settings.groups[s.id] ? <small> · {settings.groups[s.id]!.length} gr.</small> : null}
            </button>
          ))}
          {stations && !stations.length && <span className="warn-text">Nema pripremnih pozicija sa KDS-om (ADMIN → Štampanje).</span>}
        </div>
        <div className="kds-tools">
          <div className="kds-seg">
            <button className={view === 'active' ? 'on' : ''} onClick={() => setView('active')}>Aktivne{view === 'active' && tickets ? ` (${shown.length})` : ''}</button>
            <button className={view === 'done' ? 'on' : ''} onClick={() => setView('done')}>Završene</button>
          </div>
          {!sound.on && <button className="btn warn" onClick={sound.enable}>Uključi zvuk</button>}
          <span className={`conn ${rt.status}`} title="Veza sa serverom">{rt.status === 'open' ? '● Povezano' : rt.status === 'connecting' ? '● Povezivanje…' : '● Nema veze'}</span>
          <button className="btn kds-gear" onClick={() => setShowSettings(true)} aria-label="Podešavanja">⚙ Podešavanja</button>
          <button className="btn" onClick={logout} title={me?.user.fullName}>Odjava</button>
        </div>
      </header>

      {rt.status === 'lost' && (
        <div className="kds-lost" role="alert">
          Veza sa serverom je prekinuta {lostSec > 0 ? `pre ${lostSec} s` : ''} - nove porudžbine možda NISU prikazane.
          Pokušavam ponovo; prikaz se osvežava na 10 s{loadedAt ? ` (poslednje učitavanje ${time(new Date(loadedAt).toISOString())})` : ''}.
        </div>
      )}
      {sound.on && sound.blocked && <div className="notice">Pregledač je blokirao zvuk - dodirnite ekran ili otvorite Podešavanja i uključite zvuk.</div>}
      {error !== undefined && <ErrorBox error={error} onRetry={load} />}

      {!tickets ? <Spinner label={station ? `Učitavam ${station.name}…` : 'Učitavam…'} /> : (
        <div className={`kds-grid flow-${settings.flow}`} style={gridStyle}>
          {shown.length === 0 && <div className="empty">{view === 'active' ? 'Nema porudžbina za pripremu.' : 'Nema završenih porudžbina.'}</div>}
          {shown.map((t) => {
            const sec = Math.max(0, Math.floor((Math.max(now, Date.now()) - new Date(t.createdAt).getTime()) / 1000));
            const age = t.status === 'READY' || t.status === 'DONE' ? 'ok' : sec >= settings.lateAfter ? 'late' : sec >= settings.warnAfter ? 'warn' : 'fresh';
            const active = t.items.filter((i) => i.status !== 'VOIDED');
            return (
              <article key={t.id} className={`ticket st-${t.status.toLowerCase()} age-${age}`}>
                {/* Klik na zaglavlje sklanja karticu (u Završenim je vraća); klik na stavku je precrtava. */}
                <button type="button" className="ticket-head" disabled={busy === t.id}
                  title={view === 'done' ? 'Vrati karticu na ekran' : 'Skloni karticu (gotovo)'}
                  onClick={() => setStatus(t, view === 'done' ? 'READY' : 'DONE')}>
                  <div>
                    <strong>{t.table ?? 'Brza prodaja'}{t.tabName ? ` · ${t.tabName}` : ''}</strong>
                    <div className="small">#{t.orderNumber} · tura {t.batch} · {t.waiter}</div>
                  </div>
                  <div className="ticket-time">
                    <strong>{fmtAge(sec)}</strong>
                    <div className="small">{time(t.createdAt)}</div>
                  </div>
                </button>
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
              </article>
            );
          })}
        </div>
      )}
      {showSettings && <KdsSettingsPanel value={settings} stations={stations ?? []} sound={sound} onChange={save} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

/** Vreme u sekundama prikazano kao broj + jedinica (sek / min). */
function TimeField({ label, value, onChange }: { label: string; value: number; onChange: (sec: number) => void }) {
  const [unit, setUnit] = useState<'s' | 'm'>(value % 60 === 0 && value >= 60 ? 'm' : 's');
  const n = unit === 'm' ? value / 60 : value;
  return (
    <label className="kds-time">
      <span>{label}</span>
      <input className="input" inputMode="numeric" value={n} onChange={(e) => { const v = Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0); onChange(unit === 'm' ? v * 60 : v); }} />
      <div className="kds-seg sm">
        <button type="button" className={unit === 's' ? 'on' : ''} onClick={() => { setUnit('s'); }}>sek</button>
        <button type="button" className={unit === 'm' ? 'on' : ''} onClick={() => { setUnit('m'); onChange(Math.max(60, Math.round(value / 60) * 60)); }}>min</button>
      </div>
    </label>
  );
}

function KdsSettingsPanel({ value, stations, sound, onChange, onClose }: {
  value: KdsSettings; stations: Station[]; sound: ReturnType<typeof useBeep>; onChange: (s: KdsSettings) => void; onClose: () => void;
}) {
  const [openSt, setOpenSt] = useState<string | null>(stations[0]?.id ?? null);
  const v = value;
  const upd = (p: Partial<KdsSettings>) => onChange({ ...v, ...p });
  const st = stations.find((s) => s.id === openSt);
  const sel = st ? v.groups[st.id] ?? st.groups.map((g) => g.id) : [];
  const setGroups = (ids: string[]) => {
    if (!st) return;
    const all = ids.length === st.groups.length;
    upd({ groups: { ...v.groups, [st.id]: all ? null : ids } });
  };
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="kds-set-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="kds-set" role="dialog" aria-modal="true" aria-label="Podešavanja KDS ekrana">
        <header><h2>Podešavanja ekrana</h2><button className="btn" onClick={onClose}>Gotovo</button></header>
        <div className="kds-set-body">
          <section>
            <h3>Kategorije i grupe</h3>
            <p className="muted small">Izaberite kategoriju, pa grupe čije se stavke prikazuju na ovom ekranu.</p>
            <div className="kds-seg wrap">
              {stations.map((s) => <button key={s.id} className={openSt === s.id ? 'on' : ''} onClick={() => setOpenSt(s.id)}>{s.name}</button>)}
            </div>
            {st && (
              st.groups.length === 0 ? <p className="muted small">Kategorija {st.name} nema grupe.</p> : (
                <>
                  <div className="kds-groups">
                    {st.groups.map((g) => (
                      <label key={g.id} className={`kds-group ${sel.includes(g.id) ? 'on' : ''}`}>
                        <input type="checkbox" checked={sel.includes(g.id)} onChange={(e) => setGroups(e.target.checked ? [...sel, g.id] : sel.filter((x) => x !== g.id))} />
                        {g.name}
                      </label>
                    ))}
                  </div>
                  <div className="kds-row">
                    <button className="btn" onClick={() => setGroups(st.groups.map((g) => g.id))}>Izaberi sve</button>
                    <button className="btn" onClick={() => setGroups([])}>Poništi</button>
                  </div>
                </>
              )
            )}
          </section>

          <section>
            <h3>Izgled</h3>
            <div className="kds-seg">
              <button className={v.theme === 'dark' ? 'on' : ''} onClick={() => upd({ theme: 'dark' })}>Tamna pozadina</button>
              <button className={v.theme === 'light' ? 'on' : ''} onClick={() => upd({ theme: 'light' })}>Svetla pozadina</button>
            </div>
            <div className="kds-seg">
              <button className={v.cards === 'color' ? 'on' : ''} onClick={() => upd({ cards: 'color' })}>Kartice u boji statusa</button>
              <button className={v.cards === 'classic' ? 'on' : ''} onClick={() => upd({ cards: 'classic' })}>Klasične kartice</button>
            </div>
            <div className="kds-font">
              <span>Veličina slova</span>
              <button className="btn" disabled={v.font <= 0.8} onClick={() => upd({ font: Math.round((v.font - 0.1) * 10) / 10 })}>A−</button>
              <b>{Math.round(v.font * 100)}%</b>
              <button className="btn" disabled={v.font >= 1.6} onClick={() => upd({ font: Math.round((v.font + 0.1) * 10) / 10 })}>A+</button>
            </div>
          </section>

          <section>
            <h3>Raspored kartica</h3>
            <span className="kds-label">Kolona u redu</span>
            <div className="kds-seg wrap">
              {[0, 2, 3, 4, 5, 6].map((c) => <button key={c} className={v.columns === c ? 'on' : ''} onClick={() => upd({ columns: c })}>{c === 0 ? 'Auto' : c}</button>)}
            </div>
            <span className="kds-label">Redosled</span>
            <div className="kds-seg">
              <button className={v.flow === 'rows' ? 'on' : ''} onClick={() => upd({ flow: 'rows' })}>Po redovima →</button>
              <button className={v.flow === 'columns' ? 'on' : ''} onClick={() => upd({ flow: 'columns' })}>Po kolonama ↓</button>
            </div>
          </section>

          <section>
            <h3>Tajmer (boja kartice)</h3>
            <TimeField label="Žuto posle" value={v.warnAfter} onChange={(s) => upd({ warnAfter: s })} />
            <TimeField label="Crveno posle" value={v.lateAfter} onChange={(s) => upd({ lateAfter: s })} />
            {v.lateAfter <= v.warnAfter && <p className="warn-text small">Crveno treba da bude posle žutog.</p>}
          </section>

          <section>
            <h3>Zvuk</h3>
            <div className="kds-seg">
              <button className={sound.on ? 'on' : ''} onClick={sound.enable}>Uključen</button>
              <button className={!sound.on ? 'on' : ''} onClick={sound.disable}>Isključen</button>
            </div>
            <p className="muted small">Kratak signal kada stigne nova porudžbina.</p>
          </section>

          <button className="btn kds-reset" onClick={() => onChange({ ...DEFAULTS, groups: v.groups })}>Vrati podrazumevani izgled</button>
        </div>
      </aside>
    </div>
  );
}
