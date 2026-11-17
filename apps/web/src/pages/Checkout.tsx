import { useEffect, useState } from 'react';
import { api, ApiError, cmpMoney, Discount, fmt, fmtQty, newIdempotencyKey, Order, PaymentMethod, subMoney, fiscalText } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Keypad, Modal, Spinner, useLoad, useRefresh, useToast } from '../ui';

type Mode = 'CASH' | 'CARD' | 'TRANSFER' | 'REPRESENTATION' | 'MIX';
export type Part = { method: PaymentMethod; amount?: string; tendered?: string; note?: string };
/** Razlozi reprezentacije - štampaju se na računu. */
const REP_REASONS = ['Čast kuće', 'Osoblje', 'Reprezentacija'];
const MODES: { id: Mode; short: string; hint: string }[] = [
  { id: 'CASH', short: 'GOTOVINA', hint: 'Na NAPLATI iskače mali kalkulator: koliko je gost dao i kusur.' },
  { id: 'CARD', short: 'KARTICA', hint: 'Ceo iznos karticom.' },
  { id: 'MIX', short: 'MIKS', hint: 'Deo karticom, ostatak gotovinom - iznos kartice se unosi na NAPLATI.' },
  { id: 'TRANSFER', short: 'VIRMAN', hint: 'Prenos na račun.' },
  { id: 'REPRESENTATION', short: 'REPREZENTACIJA', hint: 'Ceo račun kao reprezentacija - evidentira se odvojeno od naplaćenog novca.' },
];

const normalize = (v: string) => { const [i, d = ''] = v.split('.'); return `${i || '0'}.${(d + '00').slice(0, 2)}`; };

/**
 * Naplata: levo popusti, desno iznos za naplatu sa kupcem (čovečuljak → PIB/JMBG), dole načini plaćanja.
 * Gotovina i miks otvaraju mali kalkulator (račun / dao / kusur); kartica, virman i reprezentacija se naplaćuju odmah.
 * TEST režim - nema terminala ni fiskalizacije. Svi delovi naplate idu u JEDNOJ transakciji.
 */
export function Checkout({ order: initial, onClose, onPaid }: { order: Order; onClose: () => void; onPaid: (o: Order) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const { key } = useRefresh();
  const [o, setO] = useState(initial);
  const discounts = useLoad(() => api<Discount[]>('GET', '/discounts'), [key]);
  const [mode, setMode] = useState<Mode>('CASH');
  const [calc, setCalc] = useState<null | 'CASH' | 'MIX'>(null);
  const [repOpen, setRepOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [buyerOpen, setBuyerOpen] = useState(false);
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey('pay'));
  useEffect(() => { setError(undefined); }, [mode]);

  const remaining = o.remaining;

  const applyDiscount = async (d: Discount | null) => {
    if (!can('order.discount')) return toast('err', 'Nemate pravo na popust');
    setBusy(true); setError(undefined);
    try {
      const next = await api<Order>('PUT', `/orders/${o.id}/discount`, { discountId: d?.id ?? null, expectedVersion: o.version });
      setO(next); setIdemKey(newIdempotencyKey('pay'));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const pay = async (parts: Part[]) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const r = await api('POST', `/orders/${o.id}/settle`, { parts, idempotencyKey: idemKey, expectedVersion: o.version });
      setCalc(null);
      const ch = r.payments.find((p: any) => p.change !== '0.00')?.change;
      // reprezentacija: bez poruke o fiskalnom/TEST statusu
      const fx = r.order.status === 'PAID' && !parts.every((p) => p.method === 'REPRESENTATION') ? fiscalText(r.order.fiscal) : null;
      if (ch) toast('ok', `Vratiti kusur: ${fmt(ch)}${fx ? ` · ${fx.text}` : ''}`);
      else if (fx) toast(fx.cls === 'failed' || fx.cls === 'pending' ? 'err' : 'ok', `Naplaćeno. ${fx.text}`);
      if (r.order.status !== 'PAID') { setO(r.order); setIdemKey(newIdempotencyKey('pay')); }
      onPaid(r.order);
    } catch (e) {
      setError(e);
      if ((e as ApiError).code === 'STALE_ORDER') {
        setO(await api<Order>('GET', `/orders/${o.id}`)); setIdemKey(newIdempotencyKey('pay'));
      }
    } finally { setBusy(false); }
  };

  /** Dodir na način plaćanja odmah naplaćuje ceo iznos; samo MIKS traži iznos kartice (ostatak je gotovina). */
  const naplati = (m: Mode) => {
    if (busy || remaining === '0.00') return;
    setMode(m);
    if (m === 'REPRESENTATION' && o.paidTotal !== '0.00') return setError(new ApiError(422, 'REPRESENTATION_WHOLE_ONLY', 'Reprezentacija je moguća samo za ceo račun bez prethodne naplate'));
    if (m === 'MIX') return setCalc('MIX');
    if (m === 'REPRESENTATION') return setRepOpen(true); // razlog: čast kuće, osoblje…
    void pay([{ method: m }]);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (calc || buyerOpen || (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const pct = (d: Discount) => `${Number(d.percent) % 1 === 0 ? Number(d.percent) : d.percent.replace('.', ',')}%`;
  const discLocked = busy || o.paidTotal !== '0.00' || !can('order.discount');

  return (
    <div className="k-co-back">
      <div className="k-co" role="dialog" aria-modal="true" aria-label={`Naplata računa #${o.number}`}>
        <section className="k-co-left">
          <div className="k-co-tabs"><div className="k-co-tab on">POPUSTI</div></div>
          <div className="k-co-grid">
            <button className={`k-co-opt ${!o.discountId ? 'on' : ''}`} disabled={discLocked} onClick={() => applyDiscount(null)}>Bez popusta</button>
            {discounts.loading && !discounts.data ? <Spinner /> : discounts.data?.map((d) => (
              <button key={d.id} className={`k-co-opt ${o.discountId === d.id ? 'on' : ''}`} disabled={discLocked} onClick={() => applyDiscount(d)}>
                <b>{pct(d)}</b><span>{d.name}</span>
              </button>
            ))}
          </div>
          {o.paidTotal !== '0.00' && <p className="k-co-note">Popust se ne menja posle delimične naplate.</p>}
          {!can('order.discount') && <p className="k-co-note">Nemate pravo da dajete popust.</p>}
        </section>

        <aside className="k-co-right">
          <div className="k-co-due"><span>{o.tableName ?? 'Brza prodaja'}{o.tabName ? `, ${o.tabName}` : ''}</span><strong>{fmt(remaining)}</strong></div>
          {/* Šta je na stolu: količina, artikal, iznos */}
          <div className="k-co-items">
            {o.items.filter((i) => i.status !== 'VOIDED').map((i) => (
              <div key={i.id}><span className="q">{fmtQty(i.quantity)}</span><span className="n">{i.name}</span><span className="s">{fmt(i.lineTotal)}</span></div>
            ))}
          </div>
          <div className="k-co-sums">
            {o.discountTotal !== '0.00' && <div className="disc"><span>Popust {o.discountPercent.replace(/\.00$/, '')}%</span><span>-{fmt(o.discountTotal)}</span></div>}
            {o.paidTotal !== '0.00' && <div><span>Već naplaćeno</span><span>{fmt(o.paidTotal)}</span></div>}
          </div>
          {error !== undefined && !calc && <ErrorBox error={error} />}
          <button className={`k-co-buyerbtn ${o.buyerId ? 'set' : ''}`} onClick={() => setBuyerOpen(true)} title="Kupac na računu (PIB, JMBG)">
            <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden><circle cx="12" cy="8" r="4" fill="currentColor" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" /></svg>
            <span>{o.buyerId ? <>{o.buyerIdLabel}: <b>{o.buyerId}</b>{o.buyerOptionalBasis ? <small>{o.buyerOptionalBasis}: {o.buyerOptionalValue}</small> : null}</> : <>KUPAC<small>PIB, JMBG</small></>}</span>
          </button>
        </aside>

        <div className="k-co-bottom">
          {MODES.map((m) => (
            <button key={m.id} className={`k-co-method m-${m.id.toLowerCase()} ${busy && mode === m.id ? 'on' : ''}`} disabled={busy || remaining === '0.00'}
              onClick={() => naplati(m.id)}>{busy && mode === m.id ? '...' : m.short}</button>
          ))}
          <span className="k-co-spacer" />
          <button className="k-co-close" disabled={busy} onClick={onClose}>OTKAŽI</button>
        </div>
      </div>

      {repOpen && (
        <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && setRepOpen(false)}>
          <div className="kp k-pl" role="dialog" aria-modal="true" aria-label="Reprezentacija">
            <div className="kp-title">Reprezentacija - {fmt(remaining)}</div>
            <div className="kp-hint">Regularan račun (u pazaru posebna stavka, ne u gotovini za predaju). Roba se skida sa stanja.</div>
            {REP_REASONS.map((r) => (
              <button key={r} className="k-eod-btn" disabled={busy} onClick={() => { setRepOpen(false); void pay([{ method: 'REPRESENTATION', note: r }]); }}>{r.toUpperCase()}</button>
            ))}
            <button className="kp-btn cancel" onClick={() => setRepOpen(false)}>Odustani</button>
          </div>
        </div>
      )}
      {calc && <CashCalc mode={calc} due={remaining} busy={busy} error={error} onClose={() => { setCalc(null); setError(undefined); }} onPay={pay} />}
      {buyerOpen && <BuyerDialog order={o} onClose={() => setBuyerOpen(false)} onSaved={(next) => { setO(next); setBuyerOpen(false); setIdemKey(newIdempotencyKey('pay')); }} />}
    </div>
  );
}

/**
 * Mali kalkulator naplate. Gotovina: Račun / Dao / Kusur (prazno "Dao" = tačan iznos; manje od računa = delimična naplata).
 * Miks: unosi se iznos kartice, ostatak je gotovina.
 */
export function CashCalc({ mode, due, busy, error, onClose, onPay }: {
  mode: 'CASH' | 'MIX'; due: string; busy: boolean; error: unknown; onClose: () => void; onPay: (parts: Part[]) => void;
}) {
  const [v, setV] = useState('');
  const entered = v === '' ? '' : normalize(v);
  let parts: Part[] = [];
  let problem: string | null = null;
  let change = '0.00';
  if (mode === 'CASH') {
    if (entered && cmpMoney(entered, due) < 0) parts = [{ method: 'CASH', amount: entered }];
    else { parts = [{ method: 'CASH', ...(entered ? { tendered: entered } : {}) }]; if (entered) change = subMoney(entered, due); }
  } else if (!entered || cmpMoney(entered, '0.00') <= 0) problem = 'Unesite iznos koji se plaća karticom';
  else if (cmpMoney(entered, due) >= 0) problem = 'Iznos kartice mora biti manji od računa - ostatak je gotovina';
  else parts = [{ method: 'CARD', amount: entered }, { method: 'CASH' }];
  const partial = mode === 'CASH' && entered && cmpMoney(entered, due) < 0;
  const ok = !busy && !problem && parts.length > 0;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (ok) onPay(parts); }
      else if (e.key === 'Backspace') { e.preventDefault(); setV((x) => x.slice(0, -1)); }
      else if (/^\d$/.test(e.key)) setV((x) => { const d = x.indexOf('.'); return x.length >= 10 || (d >= 0 && x.length - d > 2) ? x : x === '0' ? e.key : x + e.key; });
      else if (e.key === ',' || e.key === '.') setV((x) => (x.includes('.') ? x : (x || '0') + '.'));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  return (
    <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kp" role="dialog" aria-modal="true" aria-label={mode === 'CASH' ? 'Gotovina' : 'Miks'}>
        <div className="kp-title">{mode === 'CASH' ? 'Gotovina' : 'Miks - kartica + gotovina'}</div>
        <div className="kp-calc">
          <div><span>Račun</span><b>{fmt(due)}</b></div>
          <div className="in"><span>{mode === 'CASH' ? 'Dao' : 'Kartica'}</span><b>{entered ? fmt(entered) : <em>{mode === 'CASH' ? 'tačno' : '-'}</em>}</b></div>
          {mode === 'CASH'
            ? <div className={partial ? 'part' : 'chg'}><span>{partial ? 'Ostaje' : 'Kusur'}</span><b>{fmt(partial ? subMoney(due, entered) : change)}</b></div>
            : <div className="chg"><span>Gotovina</span><b>{entered && !problem ? fmt(subMoney(due, entered)) : '-'}</b></div>}
        </div>
        {mode === 'CASH' && (
          <div className="kp-chips">
            {['500', '1000', '2000', '5000'].map((x) => <button key={x} type="button" className="kp-chip" onClick={() => setV(x)}>{fmt(x + '.00')}</button>)}
          </div>
        )}
        {problem && entered && <div className="kp-hint bad">{problem}</div>}
        {error !== undefined && error !== null && <ErrorBox error={error} />}
        <Keypad value={v} onChange={setV} disabled={busy} />
        <div className="kp-actions">
          <button type="button" className="kp-btn go" disabled={!ok} onClick={() => onPay(parts)}>{busy ? '…' : partial ? 'Delimično' : 'Naplati'}</button>
          <button type="button" className="kp-btn cancel" onClick={onClose}>Odustani</button>
        </div>
      </div>
    </div>
  );
}

interface BuyerCodes { idTypes: { code: string; label: string; hint: string }[]; optionalBases: string[] }

/** Kupac na računu: vrsta i broj identifikacije (PIB, JMBG, diplomatska…), opciono polje (osnov + broj). */
export function BuyerDialog({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: (o: Order) => void }) {
  const codes = useLoad(() => api<BuyerCodes>('GET', '/fiscal/buyer-codes'), []);
  const [idType, setIdType] = useState(order.buyerIdType ?? '10');
  const [idValue, setIdValue] = useState(order.buyerId ?? '');
  const [basis, setBasis] = useState(order.buyerOptionalBasis ?? '');
  const [optValue, setOptValue] = useState(order.buyerOptionalValue ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const hint = codes.data?.idTypes.find((t) => t.code === idType)?.hint;
  // pretraga komitenata (naziv ili PIB) i ranijih kupaca - stari kupac se ne kuca ponovo
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ idType: string; idValue: string; name: string | null; note: string | null }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => { api<typeof found>('GET', `/buyers/search?q=${encodeURIComponent(q.trim())}`).then(setFound).catch(() => setFound([])); }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const save = async (clear = false) => {
    setBusy(true); setError(undefined);
    try {
      const body = clear ? { idType: null } : {
        idType, idValue: idValue.trim(),
        ...(basis ? { optionalBasis: basis, optionalValue: optValue.trim() } : {}),
      };
      onSaved(await api<Order>('PUT', `/orders/${order.id}/buyer`, body));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal title="Kupac na računu" onClose={onClose}>
      {codes.loading ? <Spinner /> : codes.error ? <ErrorBox error={codes.error} /> : (
        <div className="form">
          <label>Traži komitenta (naziv ili PIB)
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="npr. Delta ili 1012…" autoFocus />
          </label>
          {found.length > 0 && (
            <div className="buyer-found" role="listbox" aria-label="Pronađeni kupci">
              {found.map((b) => (
                <button key={b.idType + b.idValue} type="button" className={`buyer-hit ${b.idValue === idValue ? 'on' : ''}`} onClick={() => { setIdType(b.idType); setIdValue(b.idValue); setQ(''); setFound([]); }}>
                  <b>{b.name ?? b.idValue}</b><span>{b.name ? `PIB ${b.idValue}` : `šifra ${b.idType}`}{b.note ? ` · ${b.note}` : ''}</span>
                </button>
              ))}
            </div>
          )}
          {q.trim().length >= 2 && found.length === 0 && <small className="muted">Nema takvog komitenta - upišite ID kupca ispod.</small>}
          <label>ID kupca
            <div className="buyer-row">
              <select className="input buyer-type" value={idType} onChange={(e) => setIdType(e.target.value)}>
                {codes.data!.idTypes.map((t) => <option key={t.code} value={t.code}>{t.code} - {t.label}</option>)}
              </select>
              <input className="input" value={idValue} onChange={(e) => setIdValue(e.target.value)} placeholder="Broj" inputMode={idType === '10' || idType === '11' ? 'numeric' : 'text'} />
            </div>
            {hint && <small className="muted">{hint}</small>}
          </label>
          <label>Opciono polje kupca (npr. osnov za oslobođenje od PDV-a)
            <div className="buyer-row">
              <select className="input buyer-type" value={basis} onChange={(e) => setBasis(e.target.value)}>
                <option value="">- nema -</option>
                {codes.data!.optionalBases.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              <input className="input" value={optValue} onChange={(e) => setOptValue(e.target.value)} placeholder="Broj" disabled={!basis} />
            </div>
          </label>
          <p className="muted small">Šifre vrste identifikacije prate šifarnik eFiskalizacije. Osnov opcionog polja se mapira na zvaničnu šifru pri povezivanju sa fiskalnim uređajem.</p>
          {error !== undefined && <ErrorBox error={error} />}
          <div className="modal-actions">
            {order.buyerId && <button className="btn danger-ghost" disabled={busy} onClick={() => save(true)}>Ukloni kupca</button>}
            <button className="btn" onClick={onClose}>Otkaži</button>
            <button className="btn primary" disabled={busy || idValue.trim().length < 3} onClick={() => save()}>Potvrdi</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
