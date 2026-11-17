import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, fmt, newIdempotencyKey } from '../api';

interface Menu {
  store: string; table: string; isRoom: boolean;
  categories: { id: string; name: string; color: string | null }[];
  products: { id: string; name: string; price: string; categoryId: string; options: string[] }[];
}
interface Line { key: string; productId: string; name: string; price: string; qty: number; note: string }
type Product = Menu['products'][number];

const norm = (s: string) => s.toLocaleLowerCase('sr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'dj');
/** "8" → "Sto 8", "Sto 8" ostaje "Sto 8", "Terasa 2" ostaje (naziv stola često već sadrži reč Sto/Soba). */
export const placeLabel = (name: string, isRoom: boolean) => (/^[0-9]/.test(name) ? `${isRoom ? 'Soba' : 'Sto'} ${name}` : name);
const money = (n: number) => `${fmt(n.toFixed(2))} din`;

/**
 * Meni za gosta (QR kod na stolu, /m/<kod>): bira artikle, dodatke i napomenu, šalje porudžbinu.
 * Porudžbina ide u šank/kuhinju i na račun stola na kasi; plaća se kod konobara (gost ne može da naplati).
 */
export function GuestMenu({ token }: { token: string }) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const store = `pos.qr.${token}`;
  const [cart, setCart] = useState<Line[]>(() => { try { return JSON.parse(sessionStorage.getItem(store) ?? '[]'); } catch { return []; } });
  const [pick, setPick] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [guest, setGuest] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey('qr'));
  const [sent, setSent] = useState<number | null>(null);

  const load = () => api<Menu>('GET', `/public/qr/${encodeURIComponent(token)}`)
    .then((m) => { setMenu(m); setLoadErr(null); })
    .catch((e: ApiError) => setLoadErr(e.status === 404 ? 'Ovaj QR kod više ne važi. Pozovite konobara.' : e.message));
  useEffect(() => { void load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { sessionStorage.setItem(store, JSON.stringify(cart)); } catch { /* privatni režim */ } }, [cart, store]);
  useEffect(() => { document.title = menu ? `${menu.store} - meni` : 'Meni'; }, [menu]);

  const shown = useMemo(() => {
    if (!menu) return [];
    const t = norm(q.trim());
    return menu.products.filter((p) => (t ? norm(p.name).includes(t) : !cat || p.categoryId === cat));
  }, [menu, cat, q]);
  const count = cart.reduce((a, l) => a + l.qty, 0);
  const total = cart.reduce((a, l) => a + l.qty * Number(l.price), 0);
  const inCart = (id: string) => cart.filter((l) => l.productId === id).reduce((a, l) => a + l.qty, 0);

  const add = (p: Product, qty: number, note: string) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.productId === p.id && l.note === note);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty: Math.min(20, l.qty + qty) } : l));
      return [...c, { key: `${p.id}:${Date.now()}`, productId: p.id, name: p.name, price: p.price, qty, note }];
    });
    setKey(newIdempotencyKey('qr'));
  };
  const change = (k: string, d: number) => { setCart((c) => c.map((l) => (l.key === k ? { ...l, qty: Math.min(20, l.qty + d) } : l)).filter((l) => l.qty > 0)); setKey(newIdempotencyKey('qr')); };

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api('POST', `/public/qr/${encodeURIComponent(token)}/order`, {
        items: cart.map((l) => ({ productId: l.productId, quantity: l.qty, ...(l.note ? { note: l.note.slice(0, 120) } : {}) })),
        ...(guest.trim() ? { guest: guest.trim().slice(0, 60) } : {}), idempotencyKey: key,
      });
      setSent(count); setCart([]); setCartOpen(false); setKey(newIdempotencyKey('qr'));
    } catch (e: any) {
      setErr(e instanceof ApiError && e.code === 'NETWORK' ? 'Nema veze sa lokalom. Proverite da li ste na Wi-Fi mreži lokala i pokušajte ponovo.' : e.message);
    } finally { setBusy(false); }
  };

  if (loadErr) return <div className="gm"><div className="gm-state"><h2>Meni nije dostupan</h2><p>{loadErr}</p><button className="gm-btn" onClick={() => void load()}>Pokušaj ponovo</button></div></div>;
  if (!menu) return <div className="gm"><div className="gm-state">Učitavanje menija…</div></div>;
  if (sent !== null) {
    return (
      <div className="gm"><div className="gm-state ok">
        <div className="gm-check">✓</div>
        <h2>Porudžbina je poslata</h2>
        <p>{sent} {sent % 10 === 1 && sent % 100 !== 11 ? 'artikal' : [2, 3, 4].includes(sent % 10) && ![12, 13, 14].includes(sent % 100) ? 'artikla' : 'artikala'} za <b>{placeLabel(menu.table, menu.isRoom)}</b>. Konobar će uskoro doneti porudžbinu.</p>
        <p className="gm-muted">Plaćanje je kod konobara.</p>
        <button className="gm-btn primary" onClick={() => setSent(null)}>Naruči još</button>
      </div></div>
    );
  }

  return (
    <div className="gm">
      <header className="gm-head">
        <div><div className="gm-store">{menu.store}</div><div className="gm-table">{placeLabel(menu.table, menu.isRoom)}</div></div>
      </header>
      <div className="gm-bar">
        <input className="gm-search" value={q} placeholder="Pretraži meni…" onChange={(e) => setQ(e.target.value)} />
        {!q && (
          <nav className="gm-cats">
            <button className={!cat ? 'on' : ''} onClick={() => setCat(null)}>Sve</button>
            {menu.categories.map((c) => <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.name}</button>)}
          </nav>
        )}
      </div>
      <main className="gm-list">
        {shown.map((p) => (
          <button key={p.id} className="gm-item" onClick={() => setPick(p)}>
            <span className="gm-name">{p.name}</span>
            <span className="gm-price">{money(Number(p.price))}</span>
            <span className={`gm-add ${inCart(p.id) ? 'has' : ''}`}>{inCart(p.id) ? `${inCart(p.id)}×` : '+'}</span>
          </button>
        ))}
        {shown.length === 0 && <p className="gm-muted gm-empty">Nema artikala{q ? ` za „${q}“` : ''}.</p>}
        <div className="gm-powered"><img src="/servio-s.png" alt="" /> Servio</div>
      </main>

      {count > 0 && !cartOpen && (
        <button className="gm-cartbar" onClick={() => { setCartOpen(true); setErr(null); }}>
          <span>Porudžbina · {count}</span><b>{money(total)}</b><span>Pregled ›</span>
        </button>
      )}

      {pick && <PickSheet p={pick} onClose={() => setPick(null)} onAdd={(qty, note) => { add(pick, qty, note); setPick(null); }} />}

      {cartOpen && (
        <div className="gm-sheet-back" onClick={() => !busy && setCartOpen(false)}>
          <div className="gm-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Vaša porudžbina</h3>
            {cart.map((l) => (
              <div key={l.key} className="gm-line">
                <div><div className="gm-name">{l.name}</div>{l.note && <div className="gm-muted small">{l.note}</div>}</div>
                <div className="gm-step">
                  <button onClick={() => change(l.key, -1)} aria-label="Manje">−</button><b>{l.qty}</b><button onClick={() => change(l.key, 1)} aria-label="Više">+</button>
                </div>
                <div className="gm-price">{money(l.qty * Number(l.price))}</div>
              </div>
            ))}
            <div className="gm-total"><span>Ukupno</span><b>{money(total)}</b></div>
            <input className="gm-search" value={guest} maxLength={60} placeholder="Vaše ime ili napomena za konobara (opciono)" onChange={(e) => setGuest(e.target.value)} />
            {err && <div className="gm-err">{err}</div>}
            <button className="gm-btn primary big" disabled={busy || !cart.length} onClick={() => void submit()}>{busy ? 'Šaljem…' : 'Pošalji porudžbinu'}</button>
            <button className="gm-btn" disabled={busy} onClick={() => setCartOpen(false)}>Nazad na meni</button>
            <p className="gm-muted small">Porudžbina ide direktno u šank i kuhinju. Plaćanje je kod konobara.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function PickSheet({ p, onClose, onAdd }: { p: Product; onClose: () => void; onAdd: (qty: number, note: string) => void }) {
  const [qty, setQty] = useState(1);
  const [opts, setOpts] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const full = [...opts, note.trim()].filter(Boolean).join(', ');
  return (
    <div className="gm-sheet-back" onClick={onClose}>
      <div className="gm-sheet" onClick={(e) => e.stopPropagation()}>
        <h3>{p.name}</h3>
        <div className="gm-price big">{money(Number(p.price))}</div>
        {p.options.length > 0 && (
          <div className="gm-opts">
            {p.options.map((o) => <button key={o} className={opts.includes(o) ? 'on' : ''} onClick={() => setOpts(opts.includes(o) ? opts.filter((x) => x !== o) : [...opts, o])}>{o}</button>)}
          </div>
        )}
        <input className="gm-search" value={note} maxLength={80} placeholder="Napomena (npr. bez leda)" onChange={(e) => setNote(e.target.value)} />
        <div className="gm-step big">
          <button onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Manje">−</button><b>{qty}</b><button onClick={() => setQty(Math.min(20, qty + 1))} aria-label="Više">+</button>
        </div>
        <button className="gm-btn primary big" onClick={() => onAdd(qty, full)}>Dodaj · {money(qty * Number(p.price))}</button>
        <button className="gm-btn" onClick={onClose}>Odustani</button>
      </div>
    </div>
  );
}
