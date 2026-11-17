import { FormEvent, useState } from 'react';
import { api } from '../api';
import { ErrorBox } from '../ui';

/** Podrazumevani nalozi svake nove baze (isto kao apps/api/src/db/default-users.ts). */
const DEFAULT_LOGINS: [string, string, string][] = [
  ['ADMIN (ADMIN i kasa)', 'ADMIN', '0000'],
  ['Konobar 1 (kasa)', 'KON01', '11'],
  ['Konobar 2 (kasa)', 'KON02', '22'],
  ['KDS ekran', 'tv', 'tv'],
];

/**
 * Prvo pokretanje instalirane kase (baza je prazna): samo podaci firme, ili demo podaci za probu.
 * Nalozi se prave sami (ADMIN/0000, KON01/11, KON02/22, tv/tv) i prikazuju na kraju; menjaju se u ADMIN → Korisnici.
 */
export function FirstRun({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ companyName: '', pib: '', storeName: '', address: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const ok = f.companyName.trim() && /^\d{9}$/.test(f.pib) && f.storeName.trim();
  const run = async (body: object) => {
    setBusy(true); setError(undefined);
    try { await api('POST', '/setup', body); setDone(true); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void run({ mode: 'NEW', ...f }); };

  if (done) {
    return (
      <div className="k-login">
        <div className="k-setup">
          <div className="k-setup-head">
            <img className="kx-logo" src="/servio-logo.png" alt="Servio" />
            <h1>Kasa je spremna</h1>
            <p>Napravljeni su nalozi za prijavu. Zapišite ih - promenite ih kad želite u ADMIN → Korisnici.</p>
          </div>
          <table className="k-setup-logins">
            <thead><tr><th>Nalog</th><th>Korisničko ime</th><th>Šifra</th></tr></thead>
            <tbody>{DEFAULT_LOGINS.map(([what, user, pass]) => <tr key={user}><td>{what}</td><td><b>{user}</b></td><td><b>{pass}</b></td></tr>)}</tbody>
          </table>
          <p className="muted small">Na kasi se ukucava samo šifra (PIN). ADMIN se otvara na adresi koju glavna kasa pokaže na Ctrl+Shift+A.</p>
          <div className="k-setup-actions"><button className="kp-btn go" onClick={onDone}>NA KASU</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="k-login">
      <form className="k-setup" onSubmit={submit}>
        <div className="k-setup-head">
          <img className="kx-logo" src="/servio-logo.png" alt="Servio" />
          <h1>Prvo pokretanje kase</h1>
          <p>Unesite podatke firme. Ovo se radi samo jednom; sve ostalo se podešava u ADMIN-u.</p>
        </div>
        <fieldset disabled={busy}>
          <legend>Firma i prodajno mesto</legend>
          <label>Naziv firme<input value={f.companyName} onChange={set('companyName')} placeholder="npr. Kafe Centar d.o.o." required /></label>
          <label>PIB<input value={f.pib} inputMode="numeric" maxLength={9} onChange={(e) => setF({ ...f, pib: e.target.value.replace(/[^0-9]/g, '') })} placeholder="9 cifara" required /></label>
          <label>Naziv prodajnog mesta<input value={f.storeName} onChange={set('storeName')} placeholder="npr. Kafe Centar" required /></label>
          <label>Adresa i mesto<input value={f.address} onChange={set('address')} placeholder="npr. Knez Mihailova 1, Beograd" /></label>
        </fieldset>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="k-setup-actions">
          <button className="kp-btn go" disabled={busy || !ok}>{busy ? 'PODEŠAVAM…' : 'ZAVRŠI PODEŠAVANJE'}</button>
          <button type="button" className="kp-btn plain" disabled={busy} onClick={() => void run({ mode: 'DEMO' })}>DEMO PODACI (PROBA)</button>
        </div>
      </form>
    </div>
  );
}
