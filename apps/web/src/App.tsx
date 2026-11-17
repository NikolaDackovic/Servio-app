import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, KDS_MODE, newIdempotencyKey, storage } from './api';
import { useAuth } from './auth';
import { KeypadDialog, Spinner, useLoad, useRefresh, useToast } from './ui';
import { DeviceSetup, Login } from './pages/Login';
import { tableLabel, Tables } from './pages/Tables';
import { OrderScreen } from './pages/OrderScreen';
import { ReceiptsHub, Viewer } from './pages/ReceiptsHub';
import { EndOfDay } from './pages/EndOfDay';
import { Kds } from './pages/Kds';
import { CloseShift, OpenShift } from './pages/ShiftQuick';
import { KasaPriceLists, PriceListPick } from './pages/PriceListPick';
import { useComputer } from './computer';
import { FirstRun } from './pages/FirstRun';
import { useRealtime } from './realtime';
import { LookDialog, useLook } from './look';

/** Kasa u programu Servio (Electron) - prozorom (ceo ekran, umanji, zatvori) upravlja program. */
const DESKTOP = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);

type Overlay = null | 'receipts';

/**
 * KASA - mapa stolova preko celog radnog prostora, panel akcija desno.
 * Ostali ekrani (pregled računa, moja smena, smena/dan) otvaraju se preko mape i zatvaraju na ✕.
 * Administracija (artikli, popusti, izveštaji) je posebna aplikacija ADMIN.
 */
export function App() {
  const { me, loading, can, logout, loginPin } = useAuth();
  // Instalirana kasa: dok nema firme u bazi, prikazuje se Prvo pokretanje.
  const setup = useLoad(() => api<{ needsSetup: boolean }>('GET', '/setup/status').catch(() => ({ needsSetup: false })), []);
  const toast = useToast();
  const { key, bump } = useRefresh();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [skipDevice, setSkipDevice] = useState(false);
  const [review, setReview] = useState<Viewer | null>(null);
  const [shiftQuick, setShiftQuick] = useState(false);
  const [endOfDay, setEndOfDay] = useState(false);
  const [openDlg, setOpenDlg] = useState(false);
  const [plDlg, setPlDlg] = useState(false);
  const comp = useComputer();
  // gost je naručio preko QR koda: obaveštenje i kratak zvuk na svakoj kasi
  useRealtime({
    enabled: !!me && !KDS_MODE,
    onEvent: (e) => {
      if (e.type !== 'qr.order') return;
      const d = e.data as { table: string; items: number };
      toast('info', `📱 Nova QR porudžbina - sto ${tableLabel(d.table)} (${d.items} art.) - poslato u šank/kuhinju`);
      try {
        const a = new AudioContext(); const o = a.createOscillator(); const g = a.createGain();
        o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.25);
      } catch { /* bez zvuka */ }
      bump();
    },
  });

  const userId = me?.user.userId;
  // Promena zaposlenog (PIN za sto) ne zatvara sto koji se upravo otvara - zatvaraju se samo preklopni ekrani.
  useEffect(() => { setOverlay(null); setReview(null); }, [userId]);

  const status = useLoad(async () => {
    if (!me) return null;
    const [day, shift] = await Promise.all([
      api('GET', '/business-days/current'),
      me.user.deviceId ? api('GET', '/shifts/current') : Promise.resolve({ shift: null }),
    ]);
    return { day: day.day as any, shiftOpen: !!shift.shift };
  }, [userId, key, overlay, orderId]);
  const settings = useLoad(() => (me ? api<{ pinPerTable: boolean; screensaverText: string; screensaverImage: string | null }>('GET', '/settings/kasa') : Promise.resolve(null)), [userId, key]);
  const priceLists = useLoad(() => (me ? api<KasaPriceLists>('GET', '/price-lists/kasa').catch(() => null) : Promise.resolve(null)), [userId, key]);

  /** PIN konobara pre ulaska na sto / brzi račun (ADMIN → Podešavanja → "PIN za svaki sto"). */
  const [pinFor, setPinFor] = useState<null | { title: string; run: (user: { id: string; permissions: string[] }) => void }>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<unknown>(null);
  // kasa sa podrazumevanim korisnikom (fast food): bez šifre i za stolove
  const pinOn = settings.data?.pinPerTable !== false && !(comp as any).defaultUserId;
  const withPin = (title: string, run: (user: { id: string; permissions: string[] }) => void) => {
    if (!pinOn) return run({ id: me!.user.userId, permissions: me!.user.permissions });
    setPinError(null); setPinFor({ title, run });
  };
  const confirmPin = async (pin: string) => {
    if (!pinFor) return;
    setPinBusy(true); setPinError(null);
    try {
      const user = await loginPin(pin);
      const { run } = pinFor;
      setPinFor(null);
      run(user);
    } catch (e) { setPinError(e); } finally { setPinBusy(false); }
  };

  const quickSale = useCallback(() => withPin('Brzi račun - šifra konobara', async () => {
    try { setOrderId((await api('POST', '/orders', { idempotencyKey: newIdempotencyKey('open') })).id); }
    catch (e: any) { toast('err', e.message); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [toast, pinOn, me]);
  // instalirana kasa (program Servio): prozorom upravlja program (servio://…); u pregledaču - fullscreen pregledača
  const fullscreen = () => {
    if (DESKTOP) { window.open('servio://fullscreen'); return; }
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast('err', 'Pregledač ne dozvoljava ceo ekran'));
  };
  // natpis dugmeta prati stanje prozora (ceo ekran ili prozor)
  const isFull = () => !!document.fullscreenElement || (window.innerWidth >= screen.width - 2 && window.innerHeight >= screen.height - 2);
  const [full, setFull] = useState(isFull);
  useEffect(() => {
    const h = () => setFull(isFull());
    window.addEventListener('resize', h); document.addEventListener('fullscreenchange', h);
    return () => { window.removeEventListener('resize', h); document.removeEventListener('fullscreenchange', h); };
  }, []);
  // F12: izgled kase (tekst kartica, boje, tema) za ovaj računar
  const lookCtl = useLook();
  const [lookOpen, setLookOpen] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'F12') { e.preventDefault(); setLookOpen((x) => !x); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  const refresh = () => { bump(); toast('ok', 'Podaci osveženi (artikli, cene, popusti, stolovi)'); };

  useEffect(() => {
    if (!me || orderId) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F1' && comp.on('quickSale') && can('order.write') && status.data?.day && status.data?.shiftOpen) { e.preventDefault(); quickSale(); }
      if (e.key === 'F2' && comp.on('receipts')) { e.preventDefault(); setOverlay('receipts'); }
      if (e.key === 'F5') { e.preventDefault(); refresh(); }
      if (e.key === 'Escape' && overlay) { setOverlay(null); setReview(null); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (loading) return <Spinner label="Pokrećem…" />;
  if (setup.data?.needsSetup) return <FirstRun onDone={setup.reload} />;
  if (!me) return <Login />;
  if (!me.user.deviceId && !storage.deviceId && !skipDevice && can('user.manage')) {
    return <DeviceSetup onSkip={() => setSkipDevice(true)} />;
  }
  // Uređaj registrovan kao KDS prikazuje samo ekran pripreme.
  const device = me.devices.find((d) => d.id === me.user.deviceId);
  if (device?.kind === 'KDS' || KDS_MODE) return <Kds />;
  if (orderId) return <div className="kx"><OrderScreen orderId={orderId} onBack={() => setOrderId(null)} /></div>;

  const closeOverlay = () => { setOverlay(null); setReview(null); };
  const shiftOpen = status.data?.shiftOpen;
  const day = status.data?.day;
  const dayDate = day ? new Date(`${day.date}T12:00:00`) : new Date();
  // Smena nije otvorena: umesto mape stoji prozor za otvaranje (datum, naziv, šifra); kucanje nije moguće.
  // Otvaranje i zatvaranje su isto dugme u desnoj koloni.
  if (!status.data) return <Spinner label="Učitavam…" />;
  const closed = !day || !shiftOpen;
  const openDone = () => { setOpenDlg(false); status.reload(); bump(); };

  return (
    <div className="kx kx-frame">
      <main className="kx-main">
        {closed ? (
          <Screensaver text={settings.data?.screensaverText} image={settings.data?.screensaverImage} onTap={() => comp.on('shift') && setOpenDlg(true)} />
        ) : (
          <Tables onOpenOrder={setOrderId} onGoToDay={() => status.reload()}
            guard={pinOn ? (t, go) => withPin(`Sto ${tableLabel(t.name)} - šifra konobara`, go) : undefined} />
        )}
        {overlay === 'receipts' && !review && <PinGate onOk={setReview} onCancel={closeOverlay} />}
        {overlay === 'receipts' && review && (
          <div className="overlay hub"><ReceiptsHub viewer={review} onClose={closeOverlay} onOpenOrder={(id) => { closeOverlay(); setOrderId(id); }} /></div>
        )}
      </main>

      <aside className="kx-rail" aria-label="Akcije kase">
        {can('order.write') && comp.on('quickSale') && <RailButton icon={<IcPlay />} label="Novi račun" keyHint="F1" dark disabled={closed} onClick={quickSale} />}
        {comp.on('receipts') && <RailButton icon={<IcSearch />} label="Pregled računa" keyHint="F2" dark active={overlay === 'receipts'} onClick={() => { setReview(null); setOverlay('receipts'); }} />}
        {comp.on('endOfDay') && <RailButton icon={<IcRegister />} label="Kraj dana" active={endOfDay} disabled={closed} onClick={() => setEndOfDay(true)} />}
        {comp.on('shift') && <RailButton icon={<IcLock />} label={closed ? 'Otvaranje smene' : 'Zatvaranje smene'} active={closed} warn={closed}
          onClick={() => (closed ? setOpenDlg(true) : setShiftQuick(true))} />}
        {/* "Postavi cenovnik" se prikazuje tek kada u ADMIN-u postoji aktivan cenovnik. */}
        {!!priceLists.data?.lists.length && comp.on('priceList') && <RailButton icon={<IcDoc />} label="Postavi cenovnik" active={!!priceLists.data.current} onClick={() => setPlDlg(true)} />}
        <RailButton icon={<IcRefresh />} label="Osveži podatke" keyHint="F5" blue onClick={refresh} />
        <RailButton icon={<IcClose />} label="Odjava" red onClick={logout} />
        <div className="kx-rail-spacer" />
        <button className="kx-full" onClick={fullscreen} title="Ceo ekran / prozor (F11)">{full ? '⤡ Smanji' : '⤢ Uvećaj'}</button>
        {lookOpen && <LookDialog look={lookCtl.look} onSave={lookCtl.save} onReset={lookCtl.reset} onClose={() => setLookOpen(false)} />}
        <div className="kx-foot">
          <div className="kx-shift">{day ? `Smena: ${day.name || DAYS[dayDate.getDay()]}` : 'Smena nije otvorena'}</div>
          <div className="kx-shift">{dayDate.toLocaleDateString('sr-Latn-RS')}</div>
          <div className="kx-user">{me.user.fullName}</div>
          {priceLists.data?.current && <div className="kx-shift kx-pl">Cenovnik: {priceLists.data.current.name}</div>}
          <img className="kx-logo small" src="/servio-logo.png" alt="Servio" />
        </div>
      </aside>
      {openDlg && closed && <OpenShift onClose={() => setOpenDlg(false)} onDone={openDone} />}
      {plDlg && priceLists.data && <PriceListPick data={priceLists.data} onClose={() => setPlDlg(false)} onDone={() => { setPlDlg(false); bump(); }} />}
      {endOfDay && <EndOfDay onClose={() => setEndOfDay(false)} />}
      {pinFor && <KeypadDialog title={pinFor.title} hint="Unesite svoju šifru" secret minLen={2} busy={pinBusy} error={pinError} onConfirm={confirmPin} onClose={() => setPinFor(null)} />}
      {shiftQuick && <CloseShift dayName={day?.name ?? ''} onOpenOrder={(id) => { setShiftQuick(false); setOrderId(id); }} onClose={() => setShiftQuick(false)} onDone={() => { setShiftQuick(false); setEndOfDay(false); status.reload(); bump(); }} />}
    </div>
  );
}

const DAYS = ['Nedelja', 'Ponedeljak', 'Utorak', 'Sreda', 'Četvrtak', 'Petak', 'Subota'];

function RailButton({ icon, label, keyHint, onClick, active, dark, blue, red, warn, disabled }: {
  icon: React.ReactNode; label: string; keyHint?: string; onClick: () => void; active?: boolean; dark?: boolean; blue?: boolean; red?: boolean; warn?: boolean; disabled?: boolean;
}) {
  return (
    <button className={`kx-btn ${active ? 'on' : ''} ${dark ? 'dark' : ''} ${blue ? 'blue' : ''} ${red ? 'red' : ''} ${warn ? 'warn' : ''}`} onClick={onClick} disabled={disabled}>
      <span className="kx-icon" aria-hidden>{icon}</span>
      <span className="kx-label">{label}{keyHint && <> {keyHint}</>}</span>
    </button>
  );
}

/* Jednostavne ikonice (SVG, bez spoljnih fontova) */
const Svg = ({ children }: { children: React.ReactNode }) => <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
const IcPlay = () => <Svg><path d="M6 4l14 8-14 8z" fill="currentColor" /></Svg>;
const IcSearch = () => <Svg><circle cx="10" cy="10" r="6" /><path d="M15 15l6 6" /></Svg>;
const IcDoc = () => <Svg><rect x="5" y="3" width="14" height="18" rx="1" /><path d="M8 8h8M8 12h8M8 16h5" /></Svg>;
const IcRegister = () => <Svg><rect x="3" y="11" width="18" height="9" rx="1" /><path d="M7 11V5h10v6M7 15h2M11 15h2M15 15h2" /></Svg>;
const IcLock = () => <Svg><rect x="5" y="11" width="14" height="10" rx="1" /><path d="M8 11V7a4 4 0 018 0v4" /></Svg>;
const IcRefresh = () => <Svg><path d="M20 11a8 8 0 00-14-5L4 8M4 4v4h4M4 13a8 8 0 0014 5l2-2M20 20v-4h-4" /></Svg>;
const IcClose = () => <Svg><path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z" /><path d="M9 9l6 6M15 9l-6 6" /></Svg>;


/**
 * Pregled računa traži PIN: konobar vidi samo svoje račune, a kasir/menadžer/admin sve.
 * PIN se proverava na serveru; dobijeni pristup važi samo za ovaj pregled (bez odjave prijavljenog korisnika).
 */



/**
 * Pregled računa traži PIN (mala tastatura): konobar vidi samo svoje račune, a kasir/menadžer/admin sve.
 * PIN se proverava na serveru; dobijeni pristup važi samo za ovaj pregled (bez odjave prijavljenog korisnika).
 */
function PinGate({ onOk, onCancel }: { onOk: (r: Viewer) => void; onCancel: () => void }) {
  const { me } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (pin: string) => {
    const deviceId = storage.deviceId ?? me?.user.deviceId;
    if (!deviceId) return setError(new ApiError(0, 'DEVICE_REQUIRED', 'Kasa nije registrovana na ovom uređaju'));
    setBusy(true); setError(null);
    try {
      const r = await api('POST', '/auth/pin', { deviceId, pin });
      onOk({ token: r.accessToken, userId: r.user.id, permissions: r.user.permissions, name: `${r.user.fullName}${r.user.permissions.includes('order.read_all') ? ' · svi računi' : ' · samo svoji računi'}` });
    } catch (e) { setError(e); setBusy(false); }
  };
  return <KeypadDialog title="Pregled računa" hint="Unesite PIN - konobar vidi svoje račune, menadžer i kasir sve." secret minLen={2}
    busy={busy} error={error} onConfirm={submit} onClose={onCancel} />;
}

/**
 * Čuvar ekrana dok smena nije otvorena (umesto mape stolova): sat, datum i poruka.
 * Dodir otvara prozor za otvaranje smene. Slika i tekst: ADMIN → Podešavanja → Kasa.
 */
function Screensaver({ text, image, onTap }: { text?: string; image?: string | null; onTap: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return (
    <button className={`kx-saver ${image ? 'img' : ''}`} style={image ? { ['--saver-img' as any]: `url("${image}")` } : undefined} onClick={onTap} aria-label="Otvaranje smene">
      <span className="kx-saver-time">{now.toLocaleTimeString('sr-Latn-RS', { hour: '2-digit', minute: '2-digit' })}</span>
      <span className="kx-saver-date">{DAYS[now.getDay()]}, {now.toLocaleDateString('sr-Latn-RS')}</span>
      {text && <span className="kx-saver-brand">{text}</span>}
      <img className={`kx-saver-logo ${text ? 'small' : ''}`} src="/servio-logo-dark.png" alt="Servio" />
      <span className="kx-saver-msg">Smena nije otvorena. Dodirnite ekran ili „Otvaranje smene“.</span>
    </button>
  );
}
