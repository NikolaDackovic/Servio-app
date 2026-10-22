import { useState } from 'react';
import { api, newIdempotencyKey, storage } from './api';
import { useAuth } from './auth';
import { Spinner, useToast } from './ui';
import { DeviceSetup, Login } from './pages/Login';
import { Tables } from './pages/Tables';
import { OrderScreen } from './pages/OrderScreen';
import { Orders } from './pages/Orders';
import { Shift } from './pages/Shift';
import { Report } from './pages/Report';
import { Products } from './pages/Products';

type View = 'tables' | 'orders' | 'shift' | 'report' | 'products';

export function App() {
  const { me, loading, can, logout } = useAuth();
  const toast = useToast();
  const [view, setView] = useState<View>('tables');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [skipDevice, setSkipDevice] = useState(false);

  if (loading) return <Spinner label="Pokrećem…" />;
  if (!me) return <Login />;
  if (!me.user.deviceId && !storage.deviceId && !skipDevice && can('user.manage')) {
    return <DeviceSetup onSkip={() => setSkipDevice(true)} />;
  }

  const quickSale = async () => {
    try { setOrderId((await api('POST', '/orders', { idempotencyKey: newIdempotencyKey('open') })).id); }
    catch (e: any) { toast('err', e.message); }
  };

  const nav: { id: View; label: string; show: boolean }[] = [
    { id: 'tables', label: 'Stolovi', show: can('table.read') },
    { id: 'orders', label: 'Računi', show: can('order.read') },
    { id: 'shift', label: 'Smena', show: can('order.read') },
    { id: 'report', label: 'Izveštaj', show: can('report.read') },
    { id: 'products', label: 'Proizvodi', show: can('catalog.write') },
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="logo" /> POS</div>
        <nav>
          {nav.filter((n) => n.show).map((n) => (
            <button key={n.id} className={`nav-btn ${view === n.id && !orderId ? 'on' : ''}`} onClick={() => { setOrderId(null); setView(n.id); }}>{n.label}</button>
          ))}
          {can('order.write') && <button className="nav-btn accent" onClick={quickSale}>+ Brza prodaja</button>}
        </nav>
        <div className="who">
          <span>{me.user.fullName}</span>
          <span className="muted small">{me.devices.find((d) => d.id === me.user.deviceId)?.name ?? 'bez kase'}</span>
          <button className="btn ghost sm" onClick={logout}>Odjava</button>
        </div>
      </header>
      <main className="content">
        {orderId ? <OrderScreen orderId={orderId} onBack={() => setOrderId(null)} /> :
          view === 'tables' ? <Tables onOpenOrder={setOrderId} /> :
          view === 'orders' ? <Orders onOpen={setOrderId} /> :
          view === 'shift' ? <Shift /> :
          view === 'report' ? <Report /> :
          <Products />}
      </main>
    </div>
  );
}
