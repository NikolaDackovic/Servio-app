import { useEffect, useState } from 'react';
import { api, ApiError, fmt, storage } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Keypad, KeypadDialog, Spinner, useLoad, useToast } from '../ui';

/**
 * Odobrenje PIN-om na ovoj kasi: vraća pristup zaposlenog čiji je PIN, ako ima traženo pravo.
 * Prijavljeni korisnik ostaje prijavljen; radnja se beleži na onoga ko je odobrio.
 */
export async function pinApproval(pin: string, permission: string, deviceId: string | null | undefined) {
  if (!deviceId) throw new ApiError(0, 'DEVICE_REQUIRED', 'Kasa nije registrovana na ovom uređaju');
  const r = await api('POST', '/auth/pin', { deviceId, pin });
  if (!r.user.permissions.includes(permission)) throw new ApiError(403, 'FORBIDDEN', `${r.user.fullName} nema pravo za ovu radnju`);
  return { token: r.accessToken as string, name: r.user.fullName as string };
}

/**
 * Otvaranje smene u jednom prozoru: današnji datum, naziv smene (Petak; Petak1 ako postoji) i šifra.
 * Potvrdi proverava šifru (kasir ili menadžer) i otvara smenu. Bez unosa gotovine.
 */
export function OpenShift({ locked, onClose, onDone }: { locked?: boolean; onClose: () => void; onDone: () => void }) {
  const { me } = useAuth();
  const deviceId = storage.deviceId ?? me?.user.deviceId;
  const status = useLoad(async () => {
    const cur = await api('GET', '/business-days/current');
    if (cur.day) return { open: cur.day as any, next: null };
    return { open: null, next: await api<{ date: string; name: string }>('GET', '/business-days/next') };
  }, []);
  const [form, setForm] = useState<{ date: string; name: string } | null>(null);
  useEffect(() => { if (status.data?.next && !form) setForm(status.data.next); }, [status.data, form]);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ready = pin.length >= 4 && !busy && (!!status.data?.open || (!!form?.date && !!form?.name.trim()));

  const confirm = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const r = await api('POST', '/auth/pin', { deviceId, pin });
      if (!r.user.permissions.includes('shift.manage')) throw new ApiError(403, 'FORBIDDEN', `${r.user.fullName} nema pravo da otvori smenu`);
      const t = r.accessToken as string;
      if (!status.data?.open) {
        if (!r.user.permissions.includes('day.manage')) throw new ApiError(403, 'FORBIDDEN', 'Smenu otvara kasir ili menadžer');
        await api('POST', '/business-days/open', { date: form!.date, name: form!.name.trim() }, t);
      }
      await api('POST', '/shifts/open', { openingCash: '0.00' }, t);
      onDone();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'DAY_NAME_TAKEN' && (err.details as any)?.suggested) setForm((f) => (f ? { ...f, name: (err.details as any).suggested } : f));
      setError(e); setPin('');
    } finally { setBusy(false); }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (/^\d$/.test(e.key)) setPin((p) => (p + e.key).slice(0, 10));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') void confirm();
      else if (e.key === 'Escape' && !locked) onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const day = status.data?.open;
  return (
    <div className="kp-back" onMouseDown={(e) => !locked && e.target === e.currentTarget && onClose()}>
      <div className="kp" role="dialog" aria-modal="true" aria-label="Otvaranje smene">
        <div className="kp-title">Otvaranje smene</div>
        {status.loading && !status.data ? <Spinner /> : status.error ? <ErrorBox error={status.error} onRetry={status.reload} /> : day ? (
          <div className="kp-hint">Smena <b>{day.name}</b> ({day.date.split('-').reverse().join('.')}.) je otvorena. Unesite šifru za nastavak rada na ovoj kasi.</div>
        ) : form && (
          <div className="kp-form">
            <label className="kp-field">Datum<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
            <label className="kp-field">Naziv smene<input value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          </div>
        )}
        <div className="kp-display" aria-label={`Uneto ${pin.length} cifara`}>{pin ? '•'.repeat(pin.length) : <span className="kp-ph">Šifra</span>}</div>
        {error !== null && <ErrorBox error={error} />}
        <Keypad value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 10))} decimal={false} maxLen={10} disabled={busy} pin />
        <div className={`kp-actions ${locked ? 'single' : ''}`}>
          <button type="button" className="kp-btn go" disabled={!ready} onClick={confirm}>{busy ? '...' : 'Potvrdi'}</button>
          {!locked && <button type="button" className="kp-btn cancel" onClick={onClose}>Odustani</button>}
        </div>
      </div>
    </div>
  );
}

/**
 * Zatvaranje smene: "Da li ste sigurni?" pa Da: zatvara kasu i dan. Nije moguće dok postoji nenaplaćen račun.
 * Ako prijavljeni nema pravo, traži se šifra kasira ili menadžera.
 */
export function CloseShift({ dayName, onClose, onDone, onOpenOrder }: { dayName: string; onClose: () => void; onDone: () => void; onOpenOrder?: (id: string) => void }) {
  const { me, can } = useAuth();
  const toast = useToast();
  const deviceId = storage.deviceId ?? me?.user.deviceId;
  const [step, setStep] = useState<'check' | 'ask' | 'pin' | 'blocked'>('check');
  // Prvo: nenaplaćeni računi svih konobara — dok postoje, smena se ne zatvara (ni pitanje se ne postavlja).
  useEffect(() => {
    api<{ openOrders: any[] }>('GET', '/shifts/close-check')
      .then((r) => { if (r.openOrders.length) { setOpen(r.openOrders); setStep('blocked'); } else setStep('ask'); })
      .catch(() => setStep('ask'));
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<any[]>([]);

  const close = async (token?: string) => {
    setBusy(true); setError(null);
    try {
      await api('POST', '/shifts/close', {}, token);
      await api('POST', '/business-days/current/close', undefined, token);
      onDone();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'SHIFT_HAS_OPEN_ORDERS' || err.code === 'DAY_HAS_OPEN_ORDERS') {
        setOpen((await api<{ openOrders: any[] }>('GET', '/shifts/close-check').catch(() => ({ openOrders: [] }))).openOrders);
        setStep('blocked');
      } else if (token) setError(e);
      else toast('err', err.message);
    } finally { setBusy(false); }
  };
  const yes = () => (can('shift.manage') && can('day.manage') ? close() : setStep('pin'));
  const withPin = async (pin: string) => {
    setBusy(true); setError(null);
    try {
      const r = await api('POST', '/auth/pin', { deviceId, pin });
      if (!r.user.permissions.includes('shift.manage') || !r.user.permissions.includes('day.manage')) {
        throw new ApiError(403, 'FORBIDDEN', `${r.user.fullName} nema pravo da zatvori smenu`);
      }
      await close(r.accessToken);
    } catch (e) { setError(e); setBusy(false); }
  };

  if (step === 'check') return null;
  if (step === 'pin') return <KeypadDialog title="Zatvaranje smene" hint="Šifra kasira ili menadžera" secret minLen={1} busy={busy} error={error} onConfirm={withPin} onClose={onClose} />;
  if (step === 'blocked') {
    return (
      <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="kp wide" role="alertdialog" aria-modal="true" aria-label="Smena ne može da se zatvori">
          <div className="kp-title">Smena ne može da se zatvori</div>
          <div className="kp-hint">Svi računi moraju biti naplaćeni.{open.length ? ` Nenaplaćeno: ${open.length}. Dodirnite račun da ga otvorite i naplatite.` : ''}</div>
          {open.length > 0 && (
            <table className="bw-table">
              <tbody>
                {open.map((o) => (
                  <tr key={o.id} className={onOpenOrder ? 'click' : ''} onClick={() => onOpenOrder?.(o.id)} title="Otvori račun za naplatu">
                    <td>{o.tableName ?? `Brza prodaja #${o.number}`}{o.tabName ? `, ${o.tabName}` : ''}</td><td>{o.waiterName}</td><td className="num">{fmt(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="kp-actions"><span /><button className="kp-btn ok" onClick={onClose}>U redu</button></div>
        </div>
      </div>
    );
  }
  return (
    <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kp" role="alertdialog" aria-modal="true" aria-label="Zatvaranje smene">
        <div className="kp-title">Zatvaranje smene</div>
        <div className="kp-ask">Da li ste sigurni da želite da zatvorite smenu{dayName ? ` ${dayName}` : ''}?</div>
        <div className="kp-actions">
          <button className="kp-btn go" disabled={busy} onClick={yes}>{busy ? '...' : 'Da'}</button>
          <button className="kp-btn cancel" disabled={busy} onClick={onClose}>Ne</button>
        </div>
      </div>
    </div>
  );
}
