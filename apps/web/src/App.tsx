import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, newIdempotencyKey, storage } from './api';
import { useAuth } from './auth';
import { ErrorBox, Keypad, Spinner, useLoad, useRefresh, useToast } from './ui';
import { DeviceSetup, Login } from './pages/Login';
import { Tables } from './pages/Tables';
import { OrderScreen } from './pages/OrderScreen';
import { Orders } from './pages/Orders';
import { MyShift } from './pages/MyShift';
import { Day } from './pages/Day';

type Overlay = null | 'receipts' | 'myshift' | 'shift' | 'pricelist';

/**
 * KASA — mapa stolova preko celog radnog prostora, panel akcija desno.
 * Ostali ekrani (pregled računa, moja smena, smena/dan) otvaraju se preko mape i zatvaraju na ✕.
 * Administracija (artikli, popusti, izveštaji) je posebna aplikacija ADMIN.
 */
export function App() {
  const { me, loading, can, logout } = useAuth();
  const toast = useToast();
  const { key, bump } = useRefresh();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [skipDevice, setSkipDevice] = useState(false);
  const [review, setReview] = useState<{ token: string; name: string } | null>(null);

  const userId = me?.user.userId;
  useEffect(() => { setOverlay(null); setOrderId(null); setReview(null); }, [userId]);

  const status = useLoad(async () => {
    if (!me) return null;
    const [day, shift] = await Promise.all([
      api('GET', '/business-days/current'),
      me.user.deviceId ? api('GET', '/shifts/current') : Promise.resolve({ shift: null }),
    ]);
    return { day: day.day as any, shiftOpen: !!shift.shift };
  }, [userId, key, overlay, orderId]);

  const quickSale = useCallback(async () => {
    try { setOrderId((await api('POST', '/orders', { idempotencyKey: newIdempotencyKey('open') })).id); }
    catch (e: any) { toast('err', e.message); }
  }, [toast]);
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast('err', 'Pregledač ne dozvoljava ceo ekran'));
  };
  const refresh = () => { bump(); toast('ok', 'Podaci osveženi (artikli, cene, popusti, stolovi)'); };

  useEffect(() => {
    if (!me || orderId) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F1' && can('order.write')) { e.preventDefault(); quickSale(); }
      if (e.key === 'F2') { e.preventDefault(); setOverlay('receipts'); }
      if (e.key === 'F5') { e.preventDefault(); refresh(); }
      if (e.key === 'Escape' && overlay) { setOverlay(null); setReview(null); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (loading) return <Spinner label="Pokrećem…" />;
  if (!me) return <Login />;
  if (!me.user.deviceId && !storage.deviceId && !skipDevice && can('user.manage')) {
    return <DeviceSetup onSkip={() => setSkipDevice(true)} />;
  }
  if (orderId) return <OrderScreen orderId={orderId} onBack={() => setOrderId(null)} />;

  const closeOverlay = () => { setOverlay(null); setReview(null); };
  const shiftOpen = status.data?.shiftOpen;
  const day = status.data?.day;
  const today = new Date().toLocaleDateString('sr-Latn-RS');

  return (
    <div className="kasa">
      <main className="kasa-main">
        <Tables onOpenOrder={setOrderId} onGoToDay={() => setOverlay('shift')} />
        {overlay && (
          <div className="overlay">
            <div className="overlay-head">
              <h2>{overlay === 'receipts' ? 'Pregled računa' : overlay === 'myshift' ? 'Moja smena' : overlay === 'shift' ? 'Smena i dan' : 'Cenovnik'}</h2>
              <button className="overlay-close" onClick={closeOverlay} aria-label="Zatvori">✕</button>
            </div>
            <div className="overlay-body">
              {overlay === 'receipts' && (review
                ? <Orders token={review.token} viewerName={review.name} />
                : <PinGate onOk={setReview} onCancel={closeOverlay} />)}
              {overlay === 'myshift' && <MyShift onOpenOrder={(id) => { closeOverlay(); setOrderId(id); }} />}
              {overlay === 'shift' && <Day />}
              {overlay === 'pricelist' && <PriceList />}
            </div>
          </div>
        )}
      </main>

      <aside className="rail" aria-label="Akcije kase">
        {can('order.write') && <RailButton icon="＋" label="Novi račun" hint="F1 · brzi račun" accent onClick={quickSale} />}
        <RailButton icon="≡" label="Pregled računa" hint="F2 · uz PIN" active={overlay === 'receipts'} onClick={() => { setReview(null); setOverlay('receipts'); }} />
        {can('order.write') && <RailButton icon="◷" label="Moja smena" hint="pazar, predaja stolova" active={overlay === 'myshift'} onClick={() => setOverlay('myshift')} />}
        <RailButton icon="₸" label="Cenovnik" active={overlay === 'pricelist'} onClick={() => setOverlay('pricelist')} />
        <RailButton icon={shiftOpen ? '🔒' : '🔓'} label={shiftOpen ? 'Zatvaranje smene' : 'Otvaranje smene'}
          hint={!day ? 'dan nije otvoren' : shiftOpen ? 'prebrojavanje kase' : 'početno stanje kase'}
          warn={!shiftOpen} active={overlay === 'shift'} onClick={() => setOverlay('shift')} />
        <div className="rail-spacer" />
        <div className="rail-pair">
          <button className="rail-mini" onClick={refresh} title="Osveži podatke (F5)">⟳<span>Osveži</span></button>
          <button className="rail-mini" onClick={fullscreen} title="Ceo ekran (F11)">⤢<span>Ceo ekran</span></button>
        </div>
        <RailButton icon="⏻" label="Odjava" danger onClick={logout} />
        <div className="rail-foot">
          <div>{day ? `Dan: ${day.date.split('-').reverse().join('.')}.` : `${today} · dan nije otvoren`}</div>
          <div>Cenovnik: Osnovni</div>
        </div>
      </aside>
    </div>
  );
}

function RailButton({ icon, label, hint, onClick, active, accent, danger, warn }: {
  icon: string; label: string; hint?: string; onClick: () => void; active?: boolean; accent?: boolean; danger?: boolean; warn?: boolean;
}) {
  return (
    <button className={`rail-btn ${active ? 'on' : ''} ${accent ? 'accent' : ''} ${danger ? 'danger' : ''} ${warn ? 'warn' : ''}`} onClick={onClick}>
      <span className="rail-icon" aria-hidden>{icon}</span>
      <span className="rail-label">{label}{hint && <small>{hint}</small>}</span>
    </button>
  );
}

/**
 * Pregled računa traži PIN: konobar vidi samo svoje račune, a kasir/menadžer/admin sve.
 * PIN se proverava na serveru; dobijeni pristup važi samo za ovaj pregled (bez odjave prijavljenog korisnika).
 */
function PinGate({ onOk, onCancel }: { onOk: (r: { token: string; name: string }) => void; onCancel: () => void }) {
  const { me } = useAuth();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async () => {
    const deviceId = storage.deviceId ?? me?.user.deviceId;
    if (!deviceId) return setError(new ApiError(0, 'DEVICE_REQUIRED', 'Kasa nije registrovana na ovom uređaju'));
    setBusy(true); setError(undefined);
    try {
      const r = await api('POST', '/auth/pin', { deviceId, pin });
      onOk({ token: r.accessToken, name: `${r.user.fullName}${r.user.permissions.includes('order.read_all') ? ' (svi računi)' : ' (samo svoji računi)'}` });
    } catch (e) { setError(e); setPin(''); } finally { setBusy(false); }
  };
  return (
    <div className="pin-gate">
      <h3>Unesite PIN za pregled računa</h3>
      <p className="muted small">Konobar vidi svoje račune; administrator, menadžer i kasir vide sve.</p>
      <div className="pin-dots">{Array.from({ length: Math.max(4, pin.length) }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}</div>
      <Keypad value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 8))} decimal={false} maxLen={8} />
      {error !== undefined && <ErrorBox error={error} />}
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>Odustani</button>
        <button className="btn primary" disabled={pin.length < 4 || busy} onClick={submit}>{busy ? 'Provera…' : 'Potvrdi'}</button>
      </div>
    </div>
  );
}

function PriceList() {
  return (
    <div className="page narrow">
      <div className="card">
        <h3>Aktivni cenovnik: Osnovni</h3>
        <p>Kasa koristi prodajne cene artikala iz ADMIN-a. Promena cene u ADMIN-u važi na kasi posle dugmeta <strong>Osveži</strong>; stavke koje su već na računima zadržavaju cenu iz trenutka dodavanja.</p>
        <p className="muted">Više cenovnika (po kasi, tipu prodaje) i vremenski cenovnici (npr. srećni sat) još nisu napravljeni — definisaće se u ADMIN-u i birati ovde.</p>
      </div>
    </div>
  );
}

