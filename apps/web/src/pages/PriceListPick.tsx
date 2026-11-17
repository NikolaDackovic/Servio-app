import { useState } from 'react';
import { api, storage } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, KeypadDialog } from '../ui';
import { pinApproval } from './ShiftQuick';

export interface KasaPriceLists { current: { id: string; name: string } | null; lists: { id: string; name: string }[] }

/**
 * Postavi cenovnik: izbor cenovnika za ovu kasu (ili osnovne cene). Bez prava za smenu traži se šifra kasira ili menadžera.
 */
export function PriceListPick({ data, onClose, onDone }: { data: KasaPriceLists; onClose: () => void; onDone: () => void }) {
  const { can, me } = useAuth();
  const [want, setWant] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const apply = async (priceListId: string | null, token?: string) => {
    setBusy(true); setError(null);
    try { await api('PUT', '/price-lists/kasa', { priceListId }, token); onDone(); }
    catch (e) { setError(e); setBusy(false); }
  };
  const pick = (id: string | null) => (can('shift.manage') ? apply(id) : setWant(id));
  if (want !== undefined) {
    return <KeypadDialog title="Postavi cenovnik" hint="Šifra kasira ili menadžera" secret minLen={1} busy={busy} error={error}
      onConfirm={async (pin) => {
        try { const a = await pinApproval(pin, 'shift.manage', storage.deviceId ?? me?.user.deviceId); await apply(want, a.token); }
        catch (e) { setError(e); }
      }} onClose={onClose} />;
  }
  const cur = data.current?.id ?? null;
  return (
    <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kp k-pl" role="dialog" aria-modal="true" aria-label="Postavi cenovnik">
        <div className="kp-title">Postavi cenovnik</div>
        <button className={`k-eod-btn ${cur === null ? 'on' : ''}`} disabled={busy} onClick={() => pick(null)}>OSNOVNE CENE<small>cene iz proizvoda</small></button>
        {data.lists.map((l) => (
          <button key={l.id} className={`k-eod-btn ${cur === l.id ? 'on' : ''}`} disabled={busy} onClick={() => pick(l.id)}>{l.name.toUpperCase()}</button>
        ))}
        {error !== null && <ErrorBox error={error} />}
        <button className="kp-btn cancel" onClick={onClose}>Odustani</button>
      </div>
    </div>
  );
}
