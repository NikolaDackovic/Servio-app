import { FormEvent, useState } from 'react';
import { ApiError, storage } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Keypad } from '../ui';

export function Login() {
  const { loginPin, loginPassword } = useAuth();
  const hasDevice = !!storage.deviceId;
  const [mode, setMode] = useState<'pin' | 'admin'>(hasDevice ? 'pin' : 'admin');
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const submitPin = async (value = pin) => {
    if (value.length < 4 || busy) return;
    setBusy(true); setError(undefined);
    try { await loginPin(value); } catch (e) { setError(e); setPin(''); } finally { setBusy(false); }
  };

  const submitAdmin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try { await loginPassword(email, password, storage.deviceId ?? undefined); }
    catch (err) {
      // Ako je sačuvani uređaj obrisan/deaktiviran, prijavi se bez njega.
      if (err instanceof ApiError && /Uređaj/.test(err.message)) {
        storage.deviceId = null;
        try { await loginPassword(email, password); } catch (e2) { setError(e2); }
      } else setError(err);
    } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand"><span className="logo" /> POS</div>
        {mode === 'pin' ? (
          <>
            <p className="muted">Unesite PIN</p>
            <div className="pin-dots" aria-label={`Uneto ${pin.length} cifara`}>
              {Array.from({ length: Math.max(4, pin.length) }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}
            </div>
            <Keypad value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 8))} decimal={false} maxLen={8} />
            <button className="btn primary lg block" disabled={pin.length < 4 || busy} onClick={() => submitPin()}>
              {busy ? 'Prijava…' : 'Prijava'}
            </button>
            {error !== undefined && <ErrorBox error={error} />}
            <button className="link" onClick={() => { setMode('admin'); setError(undefined); }}>Prijava lozinkom (administrator)</button>
          </>
        ) : (
          <form onSubmit={submitAdmin} className="form">
            {!hasDevice && <p className="notice">Ovaj uređaj još nije registrovan kao kasa. Prijavite se kao administrator i izaberite kasu.</p>}
            <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label>Lozinka<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <button className="btn primary lg block" disabled={busy}>{busy ? 'Prijava…' : 'Prijava'}</button>
            {error !== undefined && <ErrorBox error={error} />}
            {hasDevice && <button type="button" className="link" onClick={() => setMode('pin')}>Nazad na PIN</button>}
          </form>
        )}
      </div>
    </div>
  );
}

/** Izbor kase za ovaj uređaj (čuva se lokalno; PIN prijava zatim ide na taj uređaj). */
export function DeviceSetup({ onSkip }: { onSkip: () => void }) {
  const { me, refresh, logout } = useAuth();
  const [choice, setChoice] = useState(me?.devices.find((d) => d.kind === 'POS')?.id ?? '');
  if (!me) return null;
  const save = async () => {
    storage.deviceId = choice;
    logout();
    await refresh();
  };
  return (
    <div className="login">
      <div className="login-card">
        <h2>Registracija uređaja</h2>
        <p className="muted">Izaberite koja kasa je ovaj uređaj. Nakon toga se zaposleni prijavljuju PIN-om.</p>
        <select value={choice} onChange={(e) => setChoice(e.target.value)} className="input">
          {me.devices.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.kind})</option>)}
        </select>
        <button className="btn primary lg block" disabled={!choice} onClick={save}>Sačuvaj i idi na PIN prijavu</button>
        <button className="link" onClick={onSkip}>Nastavi bez kase (samo backoffice)</button>
      </div>
    </div>
  );
}
