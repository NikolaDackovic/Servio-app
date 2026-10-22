import { useCallback, useEffect, useState } from 'react';
import { api, newIdempotencyKey, storage } from './api';
import { useAuth } from './auth';
import { Spinner, useToast } from './ui';
import { DeviceSetup, Login } from './pages/Login';
import { Tables } from './pages/Tables';
import { OrderScreen } from './pages/OrderScreen';
import { Orders } from './pages/Orders';
import { MyShift } from './pages/MyShift';
import { Day } from './pages/Day';

type View = 'tables' | 'orders' | 'myshift' | 'day';

/**
 * KASA — samo kucanje i računi. Raspored za touch ekran: radna površina levo,
 * vertikalni panel akcija desno (F1 novi račun, F2 pregled računa, F11 ceo ekran).
 * Administracija (artikli, izveštaji, kalendar) je posebna aplikacija ADMIN.
 */
export function App() {
  const { me, loading, can, logout } = useAuth();
  const toast = useToast();
  const [view, setView] = useState<View>('tables');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [skipDevice, setSkipDevice] = useState(false);
  const [clock, setClock] = useState(() => new Date());

  // Svaka nova prijava (npr. smena konobara na istoj kasi) počinje od stolova — bez ekrana prethodnog korisnika.
  const userId = me?.user.userId;
  useEffect(() => { setView('tables'); setOrderId(null); }, [userId]);
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 15_000); return () => clearInterval(t); }, []);

  const quickSale = useCallback(async () => {
    try { setOrderId((await api('POST', '/orders', { idempotencyKey: newIdempotencyKey('open') })).id); }
    catch (e: any) { toast('err', e.message); }
  }, [toast]);
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast('err', 'Pregledač ne dozvoljava ceo ekran'));
  };

  useEffect(() => {
    if (!me || orderId) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F1' && can('order.write')) { e.preventDefault(); quickSale(); }
      if (e.key === 'F2') { e.preventDefault(); setView('orders'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [me, orderId, can, quickSale]);

  if (loading) return <Spinner label="Pokrećem…" />;
  if (!me) return <Login />;
  if (!me.user.deviceId && !storage.deviceId && !skipDevice && can('user.manage')) {
    return <DeviceSetup onSkip={() => setSkipDevice(true)} />;
  }

  // Ekran kucanja zauzima ceo ekran i ima sopstvene akcije.
  if (orderId) return <OrderScreen orderId={orderId} onBack={() => setOrderId(null)} />;

  const device = me.devices.find((d) => d.id === me.user.deviceId)?.name ?? 'bez kase';

  return (
    <div className="kasa">
      <main className="kasa-main">
        {view === 'tables' ? <Tables onOpenOrder={setOrderId} onGoToDay={() => setView('day')} /> :
          view === 'orders' ? <Orders onOpen={setOrderId} /> :
          view === 'myshift' ? <MyShift onOpenOrder={setOrderId} /> :
          <Day />}
      </main>
      <aside className="rail" aria-label="Akcije kase">
        <div className="rail-head">
          <div className="rail-user">{me.user.fullName}</div>
          <div className="rail-meta">{device} · {clock.toLocaleTimeString('sr-Latn-RS', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        {can('order.write') && <RailButton icon="＋" label="Novi račun" hint="F1" accent onClick={quickSale} />}
        <RailButton icon="▦" label="Stolovi" active={view === 'tables'} onClick={() => setView('tables')} />
        <RailButton icon="≡" label="Pregled računa" hint="F2" active={view === 'orders'} onClick={() => setView('orders')} />
        {can('order.write') && <RailButton icon="◷" label="Moja smena" active={view === 'myshift'} onClick={() => setView('myshift')} />}
        <RailButton icon="▣" label="Dan i kasa" active={view === 'day'} onClick={() => setView('day')} />
        <div className="rail-spacer" />
        <RailButton icon="⤢" label="Ceo ekran" hint="F11" onClick={fullscreen} />
        <RailButton icon="⏻" label="Odjava" danger onClick={logout} />
      </aside>
    </div>
  );
}

function RailButton({ icon, label, hint, onClick, active, accent, danger }: {
  icon: string; label: string; hint?: string; onClick: () => void; active?: boolean; accent?: boolean; danger?: boolean;
}) {
  return (
    <button className={`rail-btn ${active ? 'on' : ''} ${accent ? 'accent' : ''} ${danger ? 'danger' : ''}`} onClick={onClick}>
      <span className="rail-icon" aria-hidden>{icon}</span>
      <span className="rail-label">{label}{hint && <small>{hint}</small>}</span>
    </button>
  );
}
