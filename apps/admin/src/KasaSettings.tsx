import { useState } from 'react';
import { api } from '@shared/api';
import { ErrorBox, Spinner, useLoad, useToast } from '@shared/ui';
import { imageToDataUrl } from './TableMap';

interface Settings { pinPerTable: boolean; screensaverText: string; screensaverImage: string | null }

/** Podešavanja kase za lokal. Svako novo podešavanje kase dobija ovde svoj red. */
export function KasaSettings() {
  const toast = useToast();
  const s = useLoad(() => api<Settings>('GET', '/settings/kasa'), []);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const save = async (patch: Partial<Settings>) => {
    setBusy(true);
    try { s.setData(await api<Settings>('PUT', '/settings/kasa', patch)); setText(null); toast('ok', 'Sačuvano - kase primenjuju posle dugmeta Osveži'); }
    catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  const image = async (file?: File) => {
    if (!file) return;
    try { await save({ screensaverImage: await imageToDataUrl(file, 1920) }); } catch (e: any) { toast('err', e.message); }
  };
  if (s.loading && !s.data) return <Spinner />;
  if (s.error) return <ErrorBox error={s.error} onRetry={s.reload} />;
  const v = s.data!;
  return (
    <div className="page narrow">
      <div className="card">
        <h3>Kasa</h3>
        <label className="setting">
          <input type="checkbox" checked={v.pinPerTable} disabled={busy} onChange={(e) => save({ pinPerTable: e.target.checked })} />
          <span><strong>Šifra konobara za svaki sto</strong><small>Kasa traži PIN pri svakom ulasku na sto i za brzi račun; sto se otvara kao konobar čija je šifra. Isključeno: radi se pod prijavljenim korisnikom.</small></span>
        </label>
      </div>
      <div className="card">
        <h3>Čuvar ekrana (dok smena nije otvorena)</h3>
        <label className="rl-field">Tekst na ekranu (npr. naziv lokala)
          <div className="btn-row tight">
            <input className="input" maxLength={120} value={text ?? v.screensaverText} placeholder="Dobrodošli" onChange={(e) => setText(e.target.value)} />
            <button className="btn primary" disabled={busy || text === null} onClick={() => save({ screensaverText: (text ?? '').trim() })}>Sačuvaj</button>
          </div>
        </label>
        <div className="rl-logo">
          {v.screensaverImage ? <img className="ss-prev" src={v.screensaverImage} alt="čuvar ekrana" /> : <span className="muted small">Bez slike (prikazuje se sat i tekst).</span>}
          <label className="btn sm">Izaberi sliku<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void image(e.target.files?.[0]); e.target.value = ''; }} /></label>
          {v.screensaverImage && <button className="btn sm danger-ghost" disabled={busy} onClick={() => save({ screensaverImage: null })}>Ukloni</button>}
        </div>
      </div>
    </div>
  );
}
