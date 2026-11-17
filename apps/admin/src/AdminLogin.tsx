import { FormEvent, useEffect, useState } from 'react';
import { api, storage } from '@shared/api';
import { useAuth } from '@shared/auth';
import { ErrorBox, Keypad, useCardReader } from '@shared/ui';
import { ServerInfo } from './ServerInfo';

/**
 * Prijava u ADMIN kao na kasi: samo šifra (PIN) na tastaturi ili prislonjena kartica.
 * Korisničko ime i lozinka ostaju kao druga mogućnost (nalozi bez PIN-a, npr. knjigovođa od kuće).
 */
export function AdminLogin() {
  const { refresh, loginPassword } = useAuth();
  const [mode, setMode] = useState<'pin' | 'password'>('pin');
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const base = import.meta.env.BASE_URL;

  const submitPin = async (value = pin) => {
    if (value.length < 1 || busy) return;
    setBusy(true); setError(undefined);
    try {
      const r = await api<{ accessToken: string }>('POST', '/auth/admin-pin', { pin: value });
      storage.token = r.accessToken;
      await refresh();
    } catch (e) { setError(e); setPin(''); } finally { setBusy(false); }
  };
  const submitPassword = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await loginPassword(email, password); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  useCardReader((code) => { setPin(''); void submitPin(code); }, mode === 'pin');
  // fizička tastatura: cifre, Backspace, Enter
  useEffect(() => {
    if (mode !== 'pin') return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (/^[0-9]$/.test(e.key)) setPin((p) => (p + e.key).slice(0, 10));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') void submitPin();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  return (
    <div className="kx k-login adm-login">
      <div className="k-login-card">
        <div className="k-login-head">
          <img className="kx-logo" src={`${base}servio-logo.png`} alt="Servio" />
          <div className="k-login-where">ADMIN · backoffice</div>
        </div>
        {mode === 'pin' ? (
          <>
            <div className="k-login-title">Unesite šifru</div>
            <div className="kp-display" aria-label={`Uneto ${pin.length} cifara`}>{pin ? '•'.repeat(pin.length) : <span className="kp-ph">ŠIFRA</span>}</div>
            {error !== undefined && <ErrorBox error={error} />}
            <Keypad value={pin} onChange={(v) => setPin(v.replace(/[^0-9]/g, '').slice(0, 10))} decimal={false} maxLen={10} disabled={busy} pin />
            <button className="kp-btn ok k-login-go" disabled={pin.length < 1 || busy} onClick={() => void submitPin()}>{busy ? 'Prijava…' : 'Prijava'}</button>
            <button className="link" onClick={() => { setMode('password'); setError(undefined); }}>Prijava korisničkim imenom i lozinkom</button>
          </>
        ) : (
          <form onSubmit={submitPassword} className="form">
            <label>Korisničko ime<input className="input" autoComplete="username" autoCapitalize="none" placeholder="npr. ADMIN" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label>Lozinka<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <button className="kp-btn ok k-login-go" disabled={busy}>{busy ? 'Prijava…' : 'Prijava'}</button>
            {error !== undefined && <ErrorBox error={error} />}
            <button type="button" className="link" onClick={() => setMode('pin')}>Nazad na šifru</button>
          </form>
        )}
        <ServerInfo />
      </div>
    </div>
  );
}
