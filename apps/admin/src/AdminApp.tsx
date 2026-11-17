import { FormEvent, useEffect, useRef, useState } from 'react';
import { useAuth } from '@shared/auth';
import { ErrorBox, Spinner } from '@shared/ui';
import { Calendar, DayDetail } from '@shared/pages/Calendar';
import { Report } from '@shared/pages/Report';
import { AdminProducts } from './AdminProducts';
import { Computers } from './Computers';
import { ActivityLog } from './ActivityLog';
import { Discounts } from './Discounts';
import { Printing } from './Printing';
import { Fiscal } from './Fiscal';
import { Partners } from './Partners';
import { Balances, WarehousesPage } from './StockPages';
import { Documents } from './Documents';
import { DOC_KINDS, DocTab } from './DocScreen';
import { SoldItems } from './SoldItems';
import { AppSettings } from './AppSettings';
import { TabCtx } from './tabs';
import { DayControl } from './DayControl';
import { ServerInfo } from './ServerInfo';
import { Recipes } from './Recipes';
import { ImportExport } from './ImportExport';
import { TableMap } from './TableMap';
import { Roles, Users } from './Users';
import { Groups } from './Groups';
import { Categories, GroupPrinting } from './GroupPrinting';
import { AdminReceipts } from './AdminReceipts';
import { PrintDay } from './PrintDay';
import { CommandPalette } from './Home';
import { AdminLogin } from './AdminLogin';
import { Reorder } from './Reorder';
import { HelpDrawer, HelpPage } from './help/Help';
import { HappyHours, PriceLists, ProductCard, ShiftTools, StockAsOf, StockLevels } from './AdminMore';

/** Stranica: stalne ('products', 'receipts'…) i dokumenti ('doc:RECEIPT' = nov dokument te vrste, 'docid:<id>' = postojeći). */
type View = string;

/** Otvoren tab: stranica + ključ (ponovno otvaranje sa namerom, npr. "nova faktura", pravi svežu stranicu). */
interface Tab { view: View; key: number; intent?: string; dayDetail?: string | null; cardFor?: string; title?: string }

/**
 * ADMIN / Backoffice. Gore su celine (Proizvod, Smena, Korisnici, Popust i cenovnik, Štampanje, Mape stolova,
 * Podešavanja); svaka otvorena stranica je TAB (kao u pregledaču) - više stranica otvoreno odjednom, stanje
 * (filteri, otvoren dokument) ostaje dok se tab ne zatvori. Kucanje i naplata su isključivo na KASI.
 */
export function AdminApp() {
  const { me, loading, can, logout } = useAuth();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<View | null>(null);
  const [palette, setPalette] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpTopic, setHelpTopic] = useState<string | undefined>();
  const [open, setOpen] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const seq = useRef(0);
  const userId = me?.user.userId;
  useEffect(() => { setTabs([]); setActive(null); }, [userId]);
  // Ctrl+K - pretraga stranica
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((x) => !x); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (navRef.current && !navRef.current.contains(e.target as Node)) setOpen(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  if (loading) return <Spinner label="Pokrećem…" />;
  if (!me) return <AdminLogin />;

  const all: { id: View; label: string; group: string; show: boolean; keys?: string }[] = [
    { id: 'help', label: 'Uputstvo', group: 'Uputstvo', show: true, keys: 'pomoc help kako objasnjenje kasa kds' },
    { id: 'products', label: 'Pregled proizvoda', group: 'Proizvod', show: can('catalog.write'), keys: 'artikal artikli cena sirovina novi proizvod barkod' },
    { id: 'groups', label: 'Grupe', group: 'Proizvod', show: can('catalog.write'), keys: 'grupe kategorije boje sirovine za prodaju' },
    { id: 'categories', label: 'Kategorije (Šank, Kuhinja)', group: 'Proizvod', show: can('settings.manage') },
    { id: 'balances', label: 'Trenutno stanje robe', group: 'Proizvod', show: can('stock.read'), keys: 'lager zaliha stanje nabavna vrednost prodajna vrednost' },
    { id: 'asOf', label: 'Stanje robe na dan', group: 'Proizvod', show: can('stock.read') },
    { id: 'card', label: 'Kartica proizvoda', group: 'Proizvod', show: can('stock.read') },
    { id: 'levels', label: 'Zalihe', group: 'Proizvod', show: can('stock.read'), keys: 'minimalna zaliha nabavka' },
    { id: 'reorder', label: 'Predlog narudžbine', group: 'Proizvod', show: can('stock.read'), keys: 'naruciti narudzbina nabavka dobavljac fali nestaje' },
    { id: 'recipes', label: 'Normativi (pregled)', group: 'Proizvod', show: can('stock.read'), keys: 'normativ utrošak' },
    { id: 'calendar', label: 'Specifikacija pazara', group: 'Smena', show: can('report.read'), keys: 'pazar promet dan' },
    { id: 'sold', label: 'Specifikacija izdatih artikala', group: 'Smena', show: can('report.read'), keys: 'prodato artikli količina prodajna vrednost konobar sto popust' },
    { id: 'dayCtl', label: 'Otvaranje i zatvaranje smene', group: 'Smena', show: can('day.manage'), keys: 'otvori smenu zatvori smenu kraj dana poslovni dan' },
    { id: 'shiftTools', label: 'Spajanje i podela smene', group: 'Smena', show: can('day.manage') },
    { id: 'receipts', label: 'Pretraga računa', group: 'Smena', show: can('order.read_all'), keys: 'storno kopija način plaćanja kartica gotovina' },
    { id: 'report', label: 'Izveštaj prometa', group: 'Smena', show: can('report.read'), keys: 'promet izveštaj PDV' },
    { id: 'users', label: 'Korisnici', group: 'Korisnici', show: can('user.manage'), keys: 'PIN konobar kasir šifra radnik zaposleni kartica' },
    { id: 'roles', label: 'Uloge i prava', group: 'Korisnici', show: can('user.manage'), keys: 'prava dozvole' },
    { id: 'activity', label: 'Dnevnik aktivnosti', group: 'Korisnici', show: can('audit.read'), keys: 'ko je menjao log' },
    { id: 'discounts', label: 'Popusti', group: 'Popust i cenovnik', show: can('discount.manage'), keys: 'popust akcija' },
    { id: 'priceLists', label: 'Cenovnik', group: 'Popust i cenovnik', show: can('discount.manage'), keys: 'cene cenovnik' },
    { id: 'happy', label: 'Happy hour', group: 'Popust i cenovnik', show: can('discount.manage') },
    ...Object.entries(DOC_KINDS).map(([k, v]) => ({ id: `doc:${k}`, label: v.title, group: 'Dokumenta', show: can('stock.write'), keys: `${v.short} dokument novi` })),
    { id: 'documents', label: 'Pregled dokumenata', group: 'Dokumenta', show: can('stock.read'), keys: 'faktura UF ulazna otpremnica UO popis prijem robe nabavka otpis prenos lista' },
    { id: 'partners', label: 'Partneri (komitenti)', group: 'Dokumenta', show: can('stock.read'), keys: 'dobavljač kupac komitent' },
    { id: 'warehouses', label: 'Magacini', group: 'Dokumenta', show: can('stock.read'), keys: 'skladište magacin šank kuhinja' },
    { id: 'import', label: 'Uvoz i izvoz (Excel)', group: 'Dokumenta', show: can('stock.write'), keys: 'excel csv xlsx' },
    { id: 'groupPrinting', label: 'Štampanje grupa', group: 'Štampanje', show: can('settings.manage'), keys: 'štampač printer bixolon kuhinja šank porudžbina' },
    { id: 'fiscal', label: 'Fiskalizacija (red računa)', group: 'Štampanje', show: can('settings.manage'), keys: 'PFR greška račun' },
    { id: 'printing', label: 'Napredno (red štampe, Print Bridge, KDS)', group: 'Štampanje', show: can('settings.manage'), keys: 'Print Bridge KDS red štampe' },
    { id: 'tables', label: 'Mapa stolova', group: 'Mape stolova', show: can('table.write'), keys: 'sto stolovi sobe hotel sala bašta pozadina QR' },
    { id: 'appSettings', label: 'Podešavanje aplikacije', group: 'Podešavanja', show: can('settings.manage'), keys: 'PIB firma adresa logo isečak žiro račun telefon LPFR VPFR fiskalizacija tekst na kraju računa slika pin po stolu čuvar ekrana' },
    { id: 'computers', label: 'Podešavanje računara', group: 'Podešavanja', show: can('settings.manage'), keys: 'kasa računar LPFR VPFR PAK pfx PIN sertifikat štampač računa logo' },
  ];
  // sve stavke menija su vidljive; one za koje uloga nema pravo su posivljene i ne otvaraju se
  const menu = all.filter((i) => i.id !== 'help');
  const items = menu.filter((i) => i.show);
  const allowed = (v: View) => v === 'help' || v.startsWith('docid:') || all.some((i) => i.id === v && i.show);
  const label = (v: View) => tabs.find((t) => t.view === v)?.title ?? all.find((i) => i.id === v)?.label ?? v;
  // prvi ulazak: Proizvodi (ili prva dozvoljena stranica)
  const shown = tabs.length ? tabs : [{ view: items.some((i) => i.id === 'products') ? 'products' as View : items[0]?.id ?? 'help', key: 0 }];
  const current = active && shown.some((t) => t.view === active) ? active : shown[0].view;
  const patch = (v: View, p: Partial<Tab>) => setTabs((ts) => (ts.length ? ts : shown).map((t) => (t.view === v ? { ...t, ...p } : t)));
  /** otvori (ili prebaci na) tab; namera (nova faktura…) pravi svežu stranicu */
  const go = (v: View, intent?: string, extra: Partial<Tab> = {}) => {
    if (!allowed(v)) return;
    if (v.startsWith('doc:') && !extra.title) extra = { ...extra, title: DOC_KINDS[v.slice(4)]?.title };
    setOpen(null);
    setTabs((ts0) => {
      const ts = ts0.length ? ts0 : shown;
      const ex = ts.find((t) => t.view === v);
      if (ex && !intent && !Object.keys(extra).length) return ts;
      const t: Tab = { view: v, key: ++seq.current, intent, ...extra };
      return ex ? ts.map((x) => (x.view === v ? t : x)) : [...ts, t];
    });
    setActive(v);
  };
  /** novi naslov taba; dokument posle čuvanja dobija i svoju adresu (docid:…) pa meni ponovo otvara prazan dokument */
  const rekey = (key: number, title: string, view?: View) => {
    const t = shown.find((x) => x.key === key);
    if (!t) return;
    const nv = view && !shown.some((x) => x.view === view && x.key !== key) ? view : t.view;
    setTabs((ts0) => (ts0.length ? ts0 : shown).map((x) => (x.key === key ? { ...x, title, view: nv } : x)));
    if (nv !== t.view) setActive((a) => (a === t.view ? nv : a));
  };
  const close = (v: View) => {
    const ts = shown.filter((t) => t.view !== v);
    setTabs(ts);
    if (current === v) setActive(ts.length ? ts[Math.max(0, shown.findIndex((t) => t.view === v) - 1)].view : null);
  };
  const groups = [...new Set(menu.map((i) => i.group))];
  const currentGroup = menu.find((i) => i.id === current)?.group;

  const page = (t: Tab) => {
    switch (t.view) {
      case 'calendar': return t.dayDetail
        ? <><PrintDay dayId={t.dayDetail} /><DayDetail dayId={t.dayDetail} onBack={() => patch('calendar', { dayDetail: null })} onReceipts={() => go('receipts')} /></>
        : <Calendar onShowDay={(id) => patch('calendar', { dayDetail: id })} />;
      case 'reorder': return <Reorder onOpenDocuments={() => go('documents')} />;
      case 'help': return <HelpPage initial={helpTopic} />;
      case 'receipts': return <AdminReceipts />;
      case 'sold': return <SoldItems />;
      case 'dayCtl': return <DayControl />;
      case 'warehouses': return <WarehousesPage />;
      case 'appSettings': return <AppSettings />;
      case 'report': return <Report />;
      case 'discounts': return <Discounts />;
      case 'tables': return <TableMap />;
      case 'users': return <Users />;
      case 'roles': return <Roles />;
      case 'groups': return <Groups />;
      case 'categories': return <Categories />;
      case 'groupPrinting': return <GroupPrinting />;
      case 'printing': return <Printing />;
      case 'balances': return <Balances onCard={(productId) => go('card', undefined, { cardFor: productId })} />;
      case 'card': return <ProductCard key={t.cardFor ?? 'none'} initialProductId={t.cardFor} />;
      case 'levels': return <StockLevels />;
      case 'asOf': return <StockAsOf />;
      case 'priceLists': return <PriceLists />;
      case 'happy': return <HappyHours />;
      case 'shiftTools': return <ShiftTools />;
      case 'computers': return <Computers />;
      case 'activity': return <ActivityLog />;
      case 'documents': return <Documents />;
      case 'recipes': return <Recipes />;
      case 'partners': return <Partners />;
      case 'import': return <ImportExport />;
      case 'fiscal': return <Fiscal />;
      default:
        if (t.view.startsWith('doc:')) return <DocTab kind={t.view.slice(4)} />;
        if (t.view.startsWith('docid:')) return <DocTab id={t.view.slice(6)} />;
        return <AdminProducts autoNew={t.intent === 'new'} />;
    }
  };

  return (
    <div className="admin2">
      <header className="adm-top">
        <div className="brand"><span className="brand-logo"><img className="logo-l" src={`${import.meta.env.BASE_URL}servio-logo.png`} alt="Servio" /><img className="logo-d" src={`${import.meta.env.BASE_URL}servio-logo-dark.png`} alt="Servio" /></span> <span className="admin-tag">ADMIN</span></div>
        <nav ref={navRef} className="adm-nav" aria-label="Administracija">
          {groups.map((g) => (
            <div key={g} className={`adm-cat ${open === g ? 'open' : ''}`}>
              <button className={`adm-cat-btn ${currentGroup === g ? 'on' : ''}`} aria-expanded={open === g} onClick={() => setOpen(open === g ? null : g)}>
                {g} <span aria-hidden>▾</span>
              </button>
              {open === g && (
                <div className="adm-drop" role="menu">
                  {menu.filter((i) => i.group === g).map((i) => (
                    <button key={i.id} role="menuitem" className={`adm-sub ${current === i.id ? 'on' : ''} ${i.show ? '' : 'off'}`} aria-disabled={!i.show}
                      title={i.show ? undefined : 'Vaša uloga nema pravo na ovu stranicu (ADMIN → Korisnici → Uloge i prava)'} onClick={() => i.show && go(i.id)}>{i.label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="adm-user">
          <button className="adm-ico" onClick={() => setPalette(true)} title="Pretraga stranica (Ctrl+K)" aria-label="Pretraga"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg></button>
          <button className="adm-ico adm-help-btn" onClick={() => (current === 'help' ? undefined : setHelpOpen(true))} title="Uputstvo za ovu stranicu" aria-label="Uputstvo">?</button>
          <ThemeToggle />
          <ServerInfo compact />
          <span className="adm-name">{me.user.fullName}</span>
          <button className="btn sm adm-logout" onClick={logout}>Odjava</button>
        </div>
      </header>
      <div className="adm-tabs" role="tablist">
        {shown.map((t) => (
          <div key={t.view} role="tab" aria-selected={t.view === current} className={`adm-tab ${t.view === current ? 'on' : ''}`}
            onClick={() => setActive(t.view)} onAuxClick={(e) => { if (e.button === 1) close(t.view); }} title={label(t.view)}>
            <span>{label(t.view)}</span>
            {shown.length > 1 && <button aria-label="Zatvori tab" onClick={(e) => { e.stopPropagation(); close(t.view); }}>×</button>}
          </div>
        ))}
      </div>
      {palette && <CommandPalette items={all.filter((i) => i.show).map((i) => ({ id: i.id, label: i.label, group: `${i.group}${i.keys ? ` · ${i.keys}` : ''}` }))} go={(v) => go(v as View)} onClose={() => setPalette(false)} />}
      {helpOpen && <HelpDrawer page={current.startsWith('doc') ? 'documents' : current} onClose={() => setHelpOpen(false)} onOpenAll={(tp) => { setHelpOpen(false); setHelpTopic(tp); go('help', tp ?? 'all'); }} />}
      <main className="admin-main">
        {shown.map((t) => (
          <div key={t.key} className="adm-tabpage" hidden={t.view !== current}>
            <TabCtx.Provider value={{ close: () => close(t.view), open: (v, title) => go(v, undefined, title ? { title } : {}), retitle: (title, view) => rekey(t.key, title, view) }}>{page(t)}</TabCtx.Provider>
          </div>
        ))}
      </main>
    </div>
  );
}

const THEME_KEY = 'pos.admin.theme2';
/** Tema ADMIN-a sa prethodne posete (poziva se pre prvog iscrtavanja). */
export function applySavedTheme() {
  let t = 'kasa';
  try { t = localStorage.getItem(THEME_KEY) ?? 'kasa'; } catch { /* podrazumevano tamna */ }
  document.documentElement.dataset.theme = t;
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'kasa');
  const toggle = () => {
    const t = theme === 'dark' ? 'kasa' : 'dark';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* samo za ovu posetu */ }
    setTheme(t);
  };
  return (
    <button className="adm-ico adm-theme" onClick={toggle} title={theme === 'dark' ? 'Tema kase (svetla)' : 'Tamna tema'} aria-label="Promena teme">
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
