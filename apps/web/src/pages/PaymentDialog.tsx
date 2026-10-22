import { useState } from 'react';
import { api, ApiError, cmpMoney, fmt, newIdempotencyKey, Order, subMoney } from '../api';
import { ErrorBox, Keypad, Modal } from '../ui';

type Method = 'CASH' | 'CARD' | 'TRANSFER';
const METHODS: { id: Method; label: string }[] = [
  { id: 'CASH', label: 'Gotovina' }, { id: 'CARD', label: 'Kartica' }, { id: 'TRANSFER', label: 'Virman' },
];

/**
 * Naplata. Iteracija 1: TEST režim — ništa se ne šalje platnom terminalu ni fiskalnom uređaju.
 * Idempotency ključ se generiše po pokušaju i ponavlja pri ponovnom slanju posle mrežne greške,
 * tako da dvostruki klik ili retry nikad ne prave duplu naplatu.
 */
export function PaymentDialog({ order, onClose, onPaid }: { order: Order; onClose: () => void; onPaid: (o: Order) => void }) {
  const [method, setMethod] = useState<Method>('CASH');
  const [input, setInput] = useState(''); // prazno = ceo preostali iznos
  const [key, setKey] = useState(() => newIdempotencyKey('pay'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [lastChange, setLastChange] = useState<string | null>(null);

  const remaining = order.remaining;
  const entered = input === '' ? remaining : normalize(input);

  // Gotovina: unos je "primljeno". Ako je primljeno ≥ preostalo → naplata celog iznosa uz kusur.
  // Kartica/virman: unos je iznos naplate (≤ preostalo).
  let amount = entered;
  let tendered: string | undefined;
  let change = '0.00';
  let invalid: string | null = null;
  if (cmpMoney(entered, '0.00') <= 0) invalid = 'Iznos mora biti veći od nule';
  else if (method === 'CASH') {
    if (cmpMoney(entered, remaining) >= 0) { amount = remaining; tendered = entered; change = subMoney(entered, remaining); }
  } else if (cmpMoney(entered, remaining) > 0) invalid = 'Iznos je veći od preostalog duga';

  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true); setError(undefined);
    try {
      const r = await api('POST', `/orders/${order.id}/payments`, {
        method, amount, tendered, idempotencyKey: key, expectedVersion: order.version,
      });
      setLastChange(r.payment.change !== '0.00' ? r.payment.change : null);
      setKey(newIdempotencyKey('pay')); // sledeći pokušaj (npr. drugi deo podeljene naplate) dobija novi ključ
      setInput('');
      onPaid(r.order);
    } catch (e) {
      // Kod mrežne greške ključ OSTAJE isti: ponovni pokušaj neće napraviti duplu naplatu.
      setError(e);
      if ((e as ApiError).code === 'STALE_ORDER') setKey(newIdempotencyKey('pay'));
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Naplata računa #${order.number}`} onClose={busy ? () => {} : onClose} wide>
      <div className="test-banner">TEST REŽIM — naplata se evidentira, ali nema platnog terminala ni fiskalizacije.</div>
      <div className="pay">
        <div className="pay-left">
          <div className="seg">
            {METHODS.map((m) => <button key={m.id} disabled={busy} className={`seg-btn ${method === m.id ? 'on' : ''}`} onClick={() => { setMethod(m.id); setError(undefined); }}>{m.label}</button>)}
          </div>
          <div className="row big"><span>Preostalo</span><strong>{fmt(remaining)}</strong></div>
          <div className="row big"><span>{method === 'CASH' ? 'Primljeno' : 'Iznos'}</span><strong className="entered">{fmt(entered)}</strong></div>
          {method === 'CASH' && cmpMoney(change, '0.00') > 0 && <div className="row big change"><span>Kusur</span><strong>{fmt(change)}</strong></div>}
          {cmpMoney(amount, remaining) < 0 && !invalid && <div className="notice">Delimična naplata: ostaje {fmt(subMoney(remaining, amount))}</div>}
          {method === 'CASH' && (
            <div className="chips">
              {['500', '1000', '2000', '5000'].map((v) => <button key={v} className="chip" disabled={busy} onClick={() => setInput(v)}>{fmt(v + '.00')}</button>)}
              <button className="chip" disabled={busy} onClick={() => setInput('')}>Tačan iznos</button>
            </div>
          )}
          {lastChange && <div className="notice ok">Vratiti kusur: <strong>{fmt(lastChange)}</strong></div>}
          {invalid && <div className="notice warn">{invalid}</div>}
          {error !== undefined && <ErrorBox error={error} />}
        </div>
        <div className="pay-right">
          <Keypad value={input} onChange={setInput} disabled={busy} />
          <button className="btn primary xl block" disabled={!!invalid || busy} onClick={submit}>
            {busy ? 'Obrada…' : `Naplati ${fmt(amount)}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function normalize(v: string) {
  const [i, d = ''] = v.split('.');
  return `${i || '0'}.${(d + '00').slice(0, 2)}`;
}
