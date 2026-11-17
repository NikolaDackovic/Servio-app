import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, KDS_MODE, storage } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Keypad, Spinner, useCardReader } from '../ui';

/**
 * Prijava na kasu: samo PIN. U sistemu sa jednim lokalom kasa se sama prepoznaje (GET /auth/kasa),
 * pa nema emaila, lozinke ni izbora kase - mapa i artikli su isti za sve, a ko radi određuje PIN.
 * Prijava lozinkom ostaje kao rezervna opcija (više lokala, prvo podešavanje).
 */
export function Login() {
  const { loginPin, loginPassword, refresh } = useAuth();
  // podrazumevani korisnik ove kase (ADMIN → Podešavanje računara): prijava bez šifre; posle Odjave do ponovnog pokretanja se kuca šifra
  useEffect(() => {
    let manual = false; try { manual = sessionStorage.getItem('pos.manualLogin') === '1'; } catch { /* */ }
    if (KDS_MODE || manual || !storage.deviceId) return;
    api('POST', '/auth/default-login', { deviceId: storage.deviceId }).then((r) => { storage.token = r.accessToken; return refresh(); }).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [hasDevice, setHasDevice] = useState(!!storage.deviceId);
  const [kasa, setKasa] = useState<{ name: string; location: string } | null>(null);
  const [probing, setProbing] = useState(!storage.deviceId);
  const [mode, setMode] = useState<'pin' | 'admin'>(KDS_MODE ? 'admin' : 'pin'); // KDS: korisničko ime i šifra (npr. tv / tv)
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [choices, setChoices] = useState<{ id: string; name: string; location: string }[] | null>(null);

  useEffect(() => {
    if (storage.deviceId) return;
    api('GET', KDS_MODE ? '/auth/kasa?kind=KDS' : '/auth/kasa')
      .then((r) => {
        if (!KDS_MODE && (r.devices?.length ?? 0) > 1) setChoices(r.devices); // više kasa: bira se jednom
        else if (r.device) { storage.deviceId = r.device.id; setHasDevice(true); setKasa(r.device); }
        else setMode('admin');
      })
      .catch(() => setMode('admin'))
      .finally(() => setProbing(false));
  }, []);

  const submitPin = async (value = pin) => {
    if (value.length < 1 || busy) return;
    setBusy(true); setError(undefined);
    try { await loginPin(value); }
    catch (e) {
      // Sačuvana kasa obrisana ili deaktivirana → ponovo prepoznaj kasu lokala.
      if (e instanceof ApiError && /Uređaj/.test(e.message)) {
        storage.deviceId = null;
        const r = await api('GET', KDS_MODE ? '/auth/kasa?kind=KDS' : '/auth/kasa').catch(() => null);
        if (r?.device) { storage.deviceId = r.device.id; try { await loginPin(value); setBusy(false); return; } catch (e2) { setError(e2); } }
        else setError(e);
      } else setError(e);
      setPin('');
    } finally { setBusy(false); }
  };

  // prislonjena kartica (čitač kartica) = prijava bez kucanja
  useCardReader((code) => { setPin(''); void submitPin(code); }, mode === 'pin');
  // Fizička tastatura: cifre, Backspace, Enter
  useEffect(() => {
    if (mode !== 'pin') return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (/^\d$/.test(e.key)) setPin((p) => (p + e.key).slice(0, 10));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') void submitPin();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

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

  if (probing) return <div className="kx k-login"><Spinner label="Prepoznajem kasu…" /></div>;
  if (choices) {
    return (
      <div className="kx k-login">
        <div className="k-login-card">
          <div className="k-login-head"><img className="kx-logo" src="/servio-logo.png" alt="Servio" /><div className="k-login-where">{choices[0]?.location}</div></div>
          <div className="k-login-title">Koja je ovo kasa?</div>
          <p className="kp-hint">Bira se jednom na ovom uređaju (štampač računa i podešavanja te kase).</p>
          <div className="k-choose">
            {choices.map((d) => (
              <button key={d.id} className="kp-btn ok" onClick={() => { storage.deviceId = d.id; setKasa(d); setHasDevice(true); setChoices(null); }}>{d.name}</button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="kx k-login">
      <div className="k-login-card">
        <div className="k-login-head">
          <img className="kx-logo" src="/servio-logo.png" alt="Servio" />
          {kasa && <div className="k-login-where">{kasa.location} · {kasa.name}</div>}
        </div>
        {mode === 'pin' ? (
          <>
            <div className="k-login-title">Unesite PIN</div>
            <div className="kp-display" aria-label={`Uneto ${pin.length} cifara`}>{pin ? '•'.repeat(pin.length) : <span className="kp-ph">PIN</span>}</div>
            {error !== undefined && <ErrorBox error={error} />}
            <Keypad value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 10))} decimal={false} maxLen={10} disabled={busy} pin />
            <button className="kp-btn ok k-login-go" disabled={pin.length < 1 || busy} onClick={() => submitPin()}>
              {busy ? 'Prijava…' : 'Prijava'}
            </button>
            <button className="link" onClick={() => { setMode('admin'); setError(undefined); }}>{KDS_MODE ? 'Prijava korisničkim imenom' : 'Prijava lozinkom (administrator)'}</button>
          </>
        ) : (
          <form onSubmit={submitAdmin} className="form">
            {!hasDevice && <p className="notice">Kasa nije prepoznata (više lokala ili nema kase). Prijavite se kao administrator i izaberite kasu.</p>}
            <label>Korisničko ime<input className="input" autoComplete="username" placeholder={KDS_MODE ? 'npr. tv' : 'npr. ADMIN'} autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label>Šifra<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <button className="kp-btn ok k-login-go" disabled={busy}>{busy ? 'Prijava…' : 'Prijava'}</button>
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
