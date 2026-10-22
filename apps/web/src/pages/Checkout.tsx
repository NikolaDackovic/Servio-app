import { useEffect, useState } from 'react';
import { api, ApiError, cmpMoney, Discount, fmt, newIdempotencyKey, Order, PaymentMethod, subMoney } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Keypad, Modal, Spinner, useLoad, useRefresh, useToast } from '../ui';

type Mode = 'CASH' | 'CARD' | 'TRANSFER' | 'REPRESENTATION' | 'MIX';
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'CASH', label: 'Gotovina', hint: 'primljeno i kusur' },
  { id: 'CARD', label: 'Kartica', hint: 'ceo iznos' },
  { id: 'MIX', label: 'Mix', hint: 'deo kartica, ostatak gotovina' },
  { id: 'TRANSFER', label: 'Virman', hint: 'prenos na račun' },
  { id: 'REPRESENTATION', label: 'Reprezentacija', hint: 'ceo račun, nije naplata' },
];

const normalize = (v: string) => { const [i, d = ''] = v.split('.'); return `${i || '0'}.${(d + '00').slice(0, 2)}`; };

/**
 * Naplata preko celog ekrana. Levo (2fr): popusti i način plaćanja; desno (1fr): iznos, kupac, potvrda.
 * Iteracija 3: TEST režim — nema terminala ni fiskalizacije. Svi delovi naplate idu u JEDNOJ transakciji.
 */
export function Checkout({ order: initial, onClose, onPaid }: { order: Order; onClose: () => void; onPaid: (o: Order) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const { key } = useRefresh();
  const [o, setO] = useState(initial);
  const discounts = useLoad(() => api<Discount[]>('GET', '/discounts'), [key]);
  const [mode, setMode] = useState<Mode>('CASH');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [buyerOpen, setBuyerOpen] = useState(false);
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey('pay'));
  useEffect(() => { setInput(''); setError(undefined); }, [mode]);

  const remaining = o.remaining;
  const entered = input === '' ? '' : normalize(input);

  // Delovi naplate za izabrani način
  let parts: { method: PaymentMethod; amount?: string; tendered?: string }[] = [];
  let invalid: string | null = null;
  let change = '0.00';
  if (mode === 'CASH') {
    if (entered && cmpMoney(entered, remaining) < 0) {
      parts = [{ method: 'CASH', amount: entered }]; // delimično gotovinom
    } else {
      parts = [{ method: 'CASH', ...(entered ? { tendered: entered } : {}) }];
      if (entered) change = subMoney(entered, remaining);
    }
  } else if (mode === 'CARD' || mode === 'TRANSFER') {
    parts = [{ method: mode }];
  } else if (mode === 'REPRESENTATION') {
    parts = [{ method: 'REPRESENTATION' }];
    if (o.paidTotal !== '0.00') invalid = 'Reprezentacija je moguća samo za ceo račun bez prethodne naplate';
  } else if (mode === 'MIX') {
    if (!entered || cmpMoney(entered, '0.00') <= 0) invalid = 'Unesite iznos koji se plaća karticom';
    else if (cmpMoney(entered, remaining) >= 0) invalid = 'Iznos kartice mora biti manji od ukupnog — ostatak je gotovina';
    else parts = [{ method: 'CARD', amount: entered }, { method: 'CASH' }];
  }

  const applyDiscount = async (d: Discount | null) => {
    if (!can('order.discount')) return toast('err', 'Nemate pravo na popust');
    setBusy(true); setError(undefined);
    try {
      const next = await api<Order>('PUT', `/orders/${o.id}/discount`, { discountId: d?.id ?? null, expectedVersion: o.version });
      setO(next); setIdemKey(newIdempotencyKey('pay'));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true); setError(undefined);
    try {
      const r = await api('POST', `/orders/${o.id}/settle`, { parts, idempotencyKey: idemKey, expectedVersion: o.version });
      const ch = r.payments.find((p: any) => p.change !== '0.00')?.change;
      if (ch) toast('ok', `Vratiti kusur: ${fmt(ch)}`);
      onPaid(r.order);
    } catch (e) {
      setError(e);
      if ((e as ApiError).code === 'STALE_ORDER') {
        setO(await api<Order>('GET', `/orders/${o.id}`)); setIdemKey(newIdempotencyKey('pay'));
      }
    } finally { setBusy(false); }
  };

  const showKeypad = mode === 'CASH' || mode === 'MIX';
  const mixCash = mode === 'MIX' && entered && !invalid ? subMoney(remaining, entered) : null;

  return (
    <div className="checkout" role="dialog" aria-modal="true" aria-label={`Naplata računa #${o.number}`}>
      <section className="co-left">
        <div className="test-banner">TEST REŽIM — naplata se evidentira, ali nema platnog terminala ni fiskalizacije.</div>
        <h3 className="co-title">Popust na ceo račun</h3>
        <div className="co-discounts">
          <button className={`co-disc ${!o.discountId ? 'on' : ''}`} disabled={busy || o.paidTotal !== '0.00'} onClick={() => applyDiscount(null)}>Bez popusta</button>
          {discounts.loading && !discounts.data ? <Spinner /> : discounts.data?.map((d) => (
            <button key={d.id} className={`co-disc ${o.discountId === d.id ? 'on' : ''}`} disabled={busy || o.paidTotal !== '0.00' || !can('order.discount')}
              onClick={() => applyDiscount(d)}>
              <strong>{Number(d.percent) % 1 === 0 ? Number(d.percent) : d.percent.replace('.', ',')}%</strong><span>{d.name}</span>
            </button>
          ))}
        </div>
        {o.paidTotal !== '0.00' && <p className="muted small">Popust se ne menja posle delimične naplate.</p>}

        <h3 className="co-title">Način plaćanja</h3>
        <div className="co-methods">
          {MODES.map((m) => (
            <button key={m.id} className={`co-method ${mode === m.id ? 'on' : ''} m-${m.id.toLowerCase()}`} onClick={() => setMode(m.id)}>
              <strong>{m.label}</strong><span>{m.hint}</span>
            </button>
          ))}
        </div>

        {showKeypad && (
          <div className="co-entry">
            <div className="co-entry-info">
              <div className="row big"><span>{mode === 'CASH' ? 'Primljeno' : 'Kartica'}</span><strong className="entered">{entered ? fmt(entered) : '—'}</strong></div>
              {mode === 'CASH' && cmpMoney(change, '0.00') > 0 && <div className="row big change"><span>Kusur</span><strong>{fmt(change)}</strong></div>}
              {mode === 'CASH' && entered && cmpMoney(entered, remaining) < 0 && <div className="notice">Delimična naplata gotovinom: ostaje {fmt(subMoney(remaining, entered))}</div>}
              {mixCash && <div className="row big"><span>Gotovina (ostatak)</span><strong>{fmt(mixCash)}</strong></div>}
              {mode === 'CASH' && (
                <div className="chips">
                  {['500', '1000', '2000', '5000'].map((v) => <button key={v} className="chip" disabled={busy} onClick={() => setInput(v)}>{fmt(v + '.00')}</button>)}
                  <button className="chip" disabled={busy} onClick={() => setInput('')}>Tačan iznos</button>
                </div>
              )}
            </div>
            <Keypad value={input} onChange={setInput} disabled={busy} />
          </div>
        )}
        {mode === 'REPRESENTATION' && <div className="notice">Reprezentacija se evidentira odvojeno od naplaćenog novca (u smeni, danu i izveštaju).</div>}
      </section>

      <aside className="co-right">
        <div className="co-head">
          <div>
            <div className="co-order">Račun #{o.number}</div>
            <div className="muted small">{o.tableName ?? 'Brza prodaja'}{o.tabName ? ` · ${o.tabName}` : ''} · {o.waiterName}</div>
          </div>
          <button className={`co-buyer ${o.buyerId ? 'set' : ''}`} onClick={() => setBuyerOpen(true)} aria-label="Kupac na računu" title="Kupac na računu (PIB, JMBG…)">
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden><circle cx="12" cy="8" r="4" fill="currentColor" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" /></svg>
          </button>
        </div>
        {o.buyerId && (
          <div className="co-buyer-info">
            <span>{o.buyerIdLabel}: <strong>{o.buyerId}</strong></span>
            {o.buyerOptionalBasis && <span className="small">{o.buyerOptionalBasis}: {o.buyerOptionalValue}</span>}
          </div>
        )}
        <div className="co-sums">
          <div className="row"><span>Iznos</span><span>{fmt(o.subtotal)}</span></div>
          {o.discountTotal !== '0.00' && <div className="row disc"><span>Popust {o.discountPercent.replace(/\.00$/, '')}%</span><span>−{fmt(o.discountTotal)}</span></div>}
          {o.paidTotal !== '0.00' && <div className="row"><span>Već naplaćeno</span><span>{fmt(o.paidTotal)}</span></div>}
          {o.taxSummary.map((t) => <div key={t.label} className="row muted small"><span>PDV {t.label} {t.rate.replace(/\.00$/, '')}%</span><span>{fmt(t.tax)}</span></div>)}
        </div>
        <div className="co-total"><span>Za naplatu</span><strong>{fmt(remaining)}</strong></div>
        {invalid && <div className="notice warn">{invalid}</div>}
        {error !== undefined && <ErrorBox error={error} />}
        <div className="co-actions">
          <button className="act exit" disabled={busy} onClick={onClose}>Otkaži</button>
          <button className="act pay" disabled={busy || !!invalid || remaining === '0.00'} onClick={submit}>
            {busy ? 'Obrada…' : mode === 'REPRESENTATION' ? 'Evidentiraj' : 'Naplati'}
          </button>
        </div>
      </aside>

      {buyerOpen && <BuyerDialog order={o} onClose={() => setBuyerOpen(false)} onSaved={(next) => { setO(next); setBuyerOpen(false); setIdemKey(newIdempotencyKey('pay')); }} />}
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
          <label>ID kupca
            <div className="buyer-row">
              <select className="input buyer-type" value={idType} onChange={(e) => setIdType(e.target.value)}>
                {codes.data!.idTypes.map((t) => <option key={t.code} value={t.code}>{t.code} — {t.label}</option>)}
              </select>
              <input className="input" value={idValue} onChange={(e) => setIdValue(e.target.value)} placeholder="Broj" autoFocus inputMode={idType === '10' || idType === '11' ? 'numeric' : 'text'} />
            </div>
            {hint && <small className="muted">{hint}</small>}
          </label>
          <label>Opciono polje kupca (npr. osnov za oslobođenje od PDV-a)
            <div className="buyer-row">
              <select className="input buyer-type" value={basis} onChange={(e) => setBasis(e.target.value)}>
                <option value="">— nema —</option>
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
