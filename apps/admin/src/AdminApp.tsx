import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '@shared/auth';
import { ErrorBox, Spinner } from '@shared/ui';
import { Calendar, DayDetail } from '@shared/pages/Calendar';
import { Report } from '@shared/pages/Report';
import { Products } from '@shared/pages/Products';
import { Orders } from '@shared/pages/Orders';
import { Discounts } from './Discounts';
import { Printing } from './Printing';
import { Fiscal } from './Fiscal';
import { Partners } from './Partners';
import { Balances, StockCard } from './StockPages';
import { Documents } from './Documents';
import { Recipes } from './Recipes';
import { ImportExport } from './ImportExport';

type View = 'calendar' | 'report' | 'receipts' | 'products' | 'discounts' | 'printing' | 'fiscal'
  | 'balances' | 'card' | 'documents' | 'recipes' | 'partners' | 'import';

/**
 * ADMIN / Backoffice — odvojena aplikacija (poseban port), samo za administraciju:
 * artikli i cene, pregled dana i računa, izveštaji. Kucanje i naplata su isključivo na KASI.
 */
export function AdminApp() {
  const { me, loading, can, logout } = useAuth();
  const [view, setView] = useState<View>('calendar');
  const [dayDetail, setDayDetail] = useState<string | null>(null);
  const [receiptsDay, setReceiptsDay] = useState<string | null>(null);
  const [cardFor, setCardFor] = useState<{ productId: string; warehouseId: string } | null>(null);
  const userId = me?.user.userId;
  useEffect(() => { setView('calendar'); setDayDetail(null); setReceiptsDay(null); }, [userId]);

  if (loading) return <Spinner label="Pokrećem…" />;
  if (!me) return <AdminLogin />;

  const all: { id: View; label: string; group: string; show: boolean }[] = [
    { id: 'calendar', label: 'Kalendar dana', group: 'Poslovanje', show: can('report.read') },
    { id: 'receipts', label: 'Računi', group: 'Poslovanje', show: can('order.read_all') },
    { id: 'report', label: 'Izveštaj prometa', group: 'Poslovanje', show: can('report.read') },
    { id: 'products', label: 'Artikli i cene', group: 'Šifarnici', show: can('catalog.write') },
    { id: 'discounts', label: 'Popusti', group: 'Šifarnici', show: can('discount.manage') },
    { id: 'balances', label: 'Stanje lagera', group: 'Robno', show: can('stock.read') },
    { id: 'documents', label: 'Robna dokumenta', group: 'Robno', show: can('stock.read') },
    { id: 'card', label: 'Kartica artikla', group: 'Robno', show: can('stock.read') },
    { id: 'recipes', label: 'Normativi', group: 'Robno', show: can('stock.read') },
    { id: 'partners', label: 'Partneri', group: 'Robno', show: can('stock.read') },
    { id: 'import', label: 'Uvoz i izvoz', group: 'Robno', show: can('stock.write') },
    { id: 'printing', label: 'Štampa i KDS', group: 'Podešavanja', show: can('settings.manage') },
    { id: 'fiscal', label: 'Fiskalizacija', group: 'Podešavanja', show: can('settings.manage') },
  ];
  const items = all.filter((i) => i.show);

  if (items.length === 0) {
    return (
      <div className="login"><div className="login-card">
        <h2>Nemate pristup administraciji</h2>
        <p className="muted">Nalog {me.user.fullName} nema prava za backoffice. Kucanje i naplata su na aplikaciji KASA.</p>
        <button className="btn" onClick={logout}>Odjava</button>
      </div></div>
    );
  }
  const current = items.some((i) => i.id === view) ? view : items[0].id;
  const go = (v: View) => { setDayDetail(null); if (v !== 'receipts') setReceiptsDay(null); setView(v); };
  const groups = [...new Set(items.map((i) => i.group))];

  return (
    <div className="admin">
      <aside className="admin-side">
        <div className="brand"><span className="logo" /> POS <span className="admin-tag">ADMIN</span></div>
        <nav aria-label="Administracija">
          {groups.map((g) => (
            <div key={g} className="side-group">
              <div className="side-title">{g}</div>
              {items.filter((i) => i.group === g).map((i) => (
                <button key={i.id} className={`side-item ${current === i.id && !dayDetail ? 'on' : ''}`} onClick={() => go(i.id)}>{i.label}</button>
              ))}
            </div>
          ))}
          <div className="side-group">
            <div className="side-title">U pripremi</div>
            <div className="side-soon">Zaposleni i uloge, više cenovnika — sledeće iteracije</div>
          </div>
        </nav>
        <div className="side-user">
          <div>{me.user.fullName}</div>
          <button className="btn ghost sm" onClick={logout}>Odjava</button>
        </div>
      </aside>
      <main className="admin-main">
        {dayDetail ? (
          <DayDetail dayId={dayDetail} onBack={() => setDayDetail(null)}
            onReceipts={(id) => { setDayDetail(null); setReceiptsDay(id); setView('receipts'); }} />
        ) : current === 'calendar' ? <Calendar onShowDay={setDayDetail} />
          : current === 'receipts' ? <Orders key={receiptsDay ?? 'all'} readOnly businessDayId={receiptsDay} onClearDay={() => setReceiptsDay(null)} />
          : current === 'report' ? <Report />
          : current === 'discounts' ? <Discounts />
          : current === 'printing' ? <Printing />
          : current === 'balances' ? <Balances onCard={(productId, warehouseId) => { setCardFor({ productId, warehouseId }); setView('card'); }} />
          : current === 'card' ? <StockCard key={cardFor ? cardFor.productId + cardFor.warehouseId : 'none'} initial={cardFor} />
          : current === 'documents' ? <Documents />
          : current === 'recipes' ? <Recipes />
          : current === 'partners' ? <Partners />
          : current === 'import' ? <ImportExport />
          : current === 'fiscal' ? <Fiscal />
          : <Products />}
      </main>
    </div>
  );
}

function AdminLogin() {
  const { loginPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await loginPassword(email, password); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="login-card form" onSubmit={submit}>
        <div className="brand"><span className="logo" /> POS <span className="admin-tag">ADMIN</span></div>
        <p className="muted">Administracija poslovanja. Za kucanje i naplatu koristite aplikaciju KASA.</p>
        <label>Email<input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Lozinka<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <button className="btn primary lg block" disabled={busy}>{busy ? 'Prijava…' : 'Prijava'}</button>
        {error !== undefined && <ErrorBox error={error} />}
      </form>
    </div>
  );
}
