import { FormEvent, useState } from 'react';
import { api, Category } from '@shared/api';
import { Empty, ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';

interface Printer { id: string; name: string; connection: 'SIMULATED' | 'NETWORK_ESCPOS' | 'WINDOWS_RAW'; host: string | null; port: number | null; windowsName: string | null; paperWidth: number; active: boolean }
interface Station { id: string; name: string; kind: 'BAR' | 'KITCHEN' | 'OTHER'; printerId: string | null; printerName: string | null; kdsEnabled: boolean; active: boolean }
interface Device { id: string; name: string; kind: string; active: boolean; receiptPrinterId: string | null; apiKeyPrefix: string | null; lastSeenAt: string | null }
interface Job { id: string; kind: string; status: string; printerName: string; stationName: string | null; attempts: number; lastError: string | null; createdAt: string; finishedAt: string | null; payload: any }

const CONN: Record<Printer['connection'], string> = { SIMULATED: 'Simulacija (bez papira)', NETWORK_ESCPOS: 'Mrežni ESC/POS (IP:port)', WINDOWS_RAW: 'Windows štampač (RAW)' };
const KIND: Record<Station['kind'], string> = { BAR: 'Šank', KITCHEN: 'Kuhinja', OTHER: 'Ostalo' };
const JOB_STATUS: Record<string, string> = { PENDING: 'Čeka', PRINTING: 'U štampi', PRINTED: 'Odštampano', SIMULATED: 'Simulirano', FAILED: 'Neuspešno' };
const JOB_KIND: Record<string, string> = { ORDER_TICKET: 'Porudžbina', VOID_TICKET: 'Storno', RECEIPT: 'Račun', TEST_PAGE: 'Probna strana' };
const dt = (s: string | null) => (s ? new Date(s).toLocaleString('sr-Latn-RS') : '—');

/** Štampa i KDS: pripremne pozicije i rutiranje, štampači, Print Bridge, red štampe. */
export function Printing() {
  const [tab, setTab] = useState<'stations' | 'printers' | 'devices' | 'jobs'>('stations');
  return (
    <div className="page">
      <div className="toolbar"><h2 style={{ margin: 0, flex: 1 }}>Štampa i KDS</h2></div>
      <div className="seg">
        <button className={`seg-btn ${tab === 'stations' ? 'on' : ''}`} onClick={() => setTab('stations')}>Pozicije i rutiranje</button>
        <button className={`seg-btn ${tab === 'printers' ? 'on' : ''}`} onClick={() => setTab('printers')}>Štampači</button>
        <button className={`seg-btn ${tab === 'devices' ? 'on' : ''}`} onClick={() => setTab('devices')}>Kase i Print Bridge</button>
        <button className={`seg-btn ${tab === 'jobs' ? 'on' : ''}`} onClick={() => setTab('jobs')}>Red štampe</button>
      </div>
      {tab === 'stations' && <Stations />}
      {tab === 'printers' && <Printers />}
      {tab === 'devices' && <Devices />}
      {tab === 'jobs' && <Jobs />}
    </div>
  );
}

function Stations() {
  const toast = useToast();
  const st = useLoad(() => api<Station[]>('GET', '/prep-stations'), []);
  const pr = useLoad(() => api<Printer[]>('GET', '/printers'), []);
  const cats = useLoad(() => api<(Category & { prepStationId: string | null })[]>('GET', '/categories'), []);
  const [edit, setEdit] = useState<Station | 'new' | null>(null);
  const routeCat = async (c: Category, stationId: string) => {
    try { await api('PATCH', `/categories/${c.id}`, { prepStationId: stationId || null }); cats.reload(); toast('ok', `${c.name} → ${st.data?.find((s) => s.id === stationId)?.name ?? 'bez pozicije'}`); }
    catch (e: any) { toast('err', e.message); }
  };
  if (st.error) return <ErrorBox error={st.error} onRetry={st.reload} />;
  if (!st.data || !pr.data || !cats.data) return <Spinner />;
  return (
    <>
      <p className="muted">Pripremna pozicija prima stavke posle dugmeta „Pošalji“ na kasi: kartica na KDS ekranu i/ili blok na štampaču pozicije. Artikal ide na poziciju svoje kategorije, osim ako u „Artikli i cene“ nema sopstvenu poziciju.</p>
      <div className="toolbar"><h3 style={{ margin: 0, flex: 1 }}>Pozicije</h3><button className="btn primary" onClick={() => setEdit('new')}>+ Nova pozicija</button></div>
      {!st.data.length ? <Empty>Nema pozicija — stavke se ne šalju ni na KDS ni na štampu.</Empty> : (
        <table className="tbl clickable">
          <thead><tr><th>Naziv</th><th>Vrsta</th><th>Štampač</th><th>KDS</th><th>Status</th></tr></thead>
          <tbody>{st.data.map((s) => (
            <tr key={s.id} onClick={() => setEdit(s)}>
              <td><strong>{s.name}</strong></td><td>{KIND[s.kind]}</td>
              <td>{s.printerName ?? <span className="muted">bez štampe</span>}</td>
              <td>{s.kdsEnabled ? 'da' : 'ne'}</td>
              <td>{s.active ? <span className="badge paid">Aktivna</span> : <span className="badge cancelled">Isključena</span>}</td>
            </tr>))}
          </tbody>
        </table>
      )}
      <h3>Rutiranje kategorija</h3>
      <table className="tbl">
        <thead><tr><th>Kategorija</th><th>Pripremna pozicija</th></tr></thead>
        <tbody>{cats.data.map((c) => (
          <tr key={c.id}>
            <td>{c.name}</td>
            <td><select className="input" value={c.prepStationId ?? ''} onChange={(e) => routeCat(c, e.target.value)}>
              <option value="">— bez pozicije (ne šalje se) —</option>
              {st.data!.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></td>
          </tr>))}
        </tbody>
      </table>
      {edit && <StationForm station={edit === 'new' ? null : edit} printers={pr.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); st.reload(); toast('ok', 'Pozicija sačuvana'); }} />}
    </>
  );
}

function StationForm({ station, printers, onClose, onSaved }: { station: Station | null; printers: Printer[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: station?.name ?? '', kind: station?.kind ?? 'KITCHEN', printerId: station?.printerId ?? '', kdsEnabled: station?.kdsEnabled ?? true, active: station?.active ?? true });
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    const body: any = { name: f.name.trim(), kind: f.kind, printerId: f.printerId || null, kdsEnabled: f.kdsEnabled };
    try {
      if (station) await api('PATCH', `/prep-stations/${station.id}`, { ...body, active: f.active }); else await api('POST', '/prep-stations', body);
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={station ? `Pozicija: ${station.name}` : 'Nova pripremna pozicija'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Naziv<input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={60} /></label>
        <label>Vrsta<select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as any })}>
          {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Štampač<select className="input" value={f.printerId} onChange={(e) => setF({ ...f, printerId: e.target.value })}>
          <option value="">— bez štampe —</option>
          {printers.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} ({CONN[p.connection]})</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={f.kdsEnabled} onChange={(e) => setF({ ...f, kdsEnabled: e.target.checked })} /> Prikaz na KDS ekranu</label>
        {station && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aktivna</label>}
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Otkaži</button><button className="btn primary" disabled={busy || !f.name.trim()}>Sačuvaj</button></div>
      </form>
    </Modal>
  );
}

function Printers() {
  const toast = useToast();
  const pr = useLoad(() => api<Printer[]>('GET', '/printers'), []);
  const [edit, setEdit] = useState<Printer | 'new' | null>(null);
  const test = async (p: Printer) => {
    try { await api('POST', `/printers/${p.id}/test`, {}); toast('ok', `Probna strana je u redu štampe za „${p.name}“ — stanje pogledajte u „Red štampe“`); }
    catch (e: any) { toast('err', e.message); }
  };
  if (pr.error) return <ErrorBox error={pr.error} onRetry={pr.reload} />;
  if (!pr.data) return <Spinner />;
  return (
    <>
      <p className="muted">Štampu izvršava <strong>Print Bridge</strong> na računaru u lokalu (apps/print-bridge). Bez pokrenutog bridge-a zadaci ostaju u redu sa statusom „Čeka“. „Simulacija“ ništa ne štampa na papiru — zadatak dobija status „Simulirano“.</p>
      <div className="toolbar"><h3 style={{ margin: 0, flex: 1 }}>Štampači</h3><button className="btn primary" onClick={() => setEdit('new')}>+ Novi štampač</button></div>
      {!pr.data.length ? <Empty>Nema štampača.</Empty> : (
        <table className="tbl clickable">
          <thead><tr><th>Naziv</th><th>Veza</th><th>Adresa</th><th>Papir</th><th>Status</th><th /></tr></thead>
          <tbody>{pr.data.map((p) => (
            <tr key={p.id} onClick={() => setEdit(p)}>
              <td><strong>{p.name}</strong></td><td>{CONN[p.connection]}</td>
              <td>{p.connection === 'NETWORK_ESCPOS' ? `${p.host}:${p.port}` : p.connection === 'WINDOWS_RAW' ? p.windowsName : '—'}</td>
              <td>{p.paperWidth} mm</td>
              <td>{p.active ? <span className="badge paid">Aktivan</span> : <span className="badge cancelled">Isključen</span>}</td>
              <td><button className="btn sm" onClick={(e) => { e.stopPropagation(); test(p); }}>Probna strana</button></td>
            </tr>))}
          </tbody>
        </table>
      )}
      {edit && <PrinterForm printer={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); pr.reload(); toast('ok', 'Štampač sačuvan'); }} />}
    </>
  );
}

function PrinterForm({ printer, onClose, onSaved }: { printer: Printer | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: printer?.name ?? '', connection: printer?.connection ?? 'NETWORK_ESCPOS', host: printer?.host ?? '', port: String(printer?.port ?? 9100),
    windowsName: printer?.windowsName ?? '', paperWidth: printer?.paperWidth ?? 80, active: printer?.active ?? true,
  });
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    const body: any = {
      name: f.name.trim(), connection: f.connection, paperWidth: f.paperWidth,
      host: f.connection === 'NETWORK_ESCPOS' ? f.host.trim() : null, port: f.connection === 'NETWORK_ESCPOS' ? Number(f.port) : null,
      windowsName: f.connection === 'WINDOWS_RAW' ? f.windowsName.trim() : null,
    };
    try {
      if (printer) await api('PATCH', `/printers/${printer.id}`, { ...body, active: f.active }); else await api('POST', '/printers', body);
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={printer ? `Štampač: ${printer.name}` : 'Novi štampač'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Naziv<input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={60} /></label>
        <label>Veza<select className="input" value={f.connection} onChange={(e) => setF({ ...f, connection: e.target.value as any })}>
          {Object.entries(CONN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {f.connection === 'NETWORK_ESCPOS' && (
          <div className="grid2">
            <label>IP adresa<input className="input" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="192.168.1.50" required /></label>
            <label>Port<input className="input" inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, '') })} required /></label>
          </div>
        )}
        {f.connection === 'WINDOWS_RAW' && (
          <label>Naziv štampača u Windows-u<input className="input" value={f.windowsName} onChange={(e) => setF({ ...f, windowsName: e.target.value })} placeholder="EPSON TM-T20III Receipt" required />
            <small className="muted">Tačan naziv iz „Printers &amp; scanners“. Windows RAW adapter još nije proveren na stvarnom Windows računaru.</small></label>
        )}
        <label>Širina papira<select className="input" value={f.paperWidth} onChange={(e) => setF({ ...f, paperWidth: Number(e.target.value) })}>
          <option value={80}>80 mm (48 znakova)</option><option value={58}>58 mm (32 znaka)</option></select></label>
        {printer && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aktivan</label>}
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Otkaži</button><button className="btn primary" disabled={busy}>Sačuvaj</button></div>
      </form>
    </Modal>
  );
}

function Devices() {
  const toast = useToast();
  const dv = useLoad(() => api<Device[]>('GET', '/devices'), []);
  const pr = useLoad(() => api<Printer[]>('GET', '/printers'), []);
  const [key, setKey] = useState<{ name: string; apiKey: string } | null>(null);
  const [newName, setNewName] = useState('');
  const setReceipt = async (d: Device, printerId: string) => {
    try { await api('PATCH', `/devices/${d.id}/receipt-printer`, { receiptPrinterId: printerId || null }); dv.reload(); toast('ok', 'Štampač računa sačuvan'); }
    catch (e: any) { toast('err', e.message); }
  };
  const createBridge = async (e: FormEvent) => {
    e.preventDefault();
    try { const r = await api('POST', '/print-bridges', { name: newName.trim() }); setKey(r); setNewName(''); dv.reload(); }
    catch (err: any) { toast('err', err.message); }
  };
  const rotate = async (d: Device) => {
    if (!confirm(`Novi ključ za „${d.name}“? Stari ključ odmah prestaje da važi.`)) return;
    try { setKey(await api('POST', `/print-bridges/${d.id}/rotate-key`, {})); dv.reload(); } catch (e: any) { toast('err', e.message); }
  };
  if (dv.error) return <ErrorBox error={dv.error} onRetry={dv.reload} />;
  if (!dv.data || !pr.data) return <Spinner />;
  const bridges = dv.data.filter((d) => d.kind === 'BRIDGE');
  const pos = dv.data.filter((d) => d.kind !== 'BRIDGE');
  const online = (d: Device) => d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < 30000;
  return (
    <>
      <h3>Štampač računa po kasi</h3>
      <table className="tbl">
        <thead><tr><th>Uređaj</th><th>Vrsta</th><th>Štampač računa</th></tr></thead>
        <tbody>{pos.map((d) => (
          <tr key={d.id}><td>{d.name}</td><td>{d.kind}</td>
            <td>{d.kind === 'KDS' ? <span className="muted">—</span> : (
              <select className="input" value={d.receiptPrinterId ?? ''} onChange={(e) => setReceipt(d, e.target.value)}>
                <option value="">— bez štampe računa —</option>
                {pr.data!.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>)}</td></tr>))}
        </tbody>
      </table>

      <h3>Print Bridge</h3>
      <p className="muted">Print Bridge je mali servis na računaru u lokalu koji preuzima zadatke i šalje ih štampačima. Prijavljuje se ključem (ne PIN-om). Ključ se prikazuje samo jednom; u bazi se čuva samo njegov heš.</p>
      <table className="tbl">
        <thead><tr><th>Naziv</th><th>Ključ</th><th>Poslednji kontakt</th><th /></tr></thead>
        <tbody>{bridges.length === 0 ? <tr><td colSpan={4} className="muted">Nema registrovanih bridge-ova.</td></tr> : bridges.map((d) => (
          <tr key={d.id}>
            <td><strong>{d.name}</strong></td><td><code>{d.apiKeyPrefix}…</code></td>
            <td>{online(d) ? <span className="badge paid">Aktivan</span> : <span className="warn-text">{d.lastSeenAt ? dt(d.lastSeenAt) : 'nikad'}</span>}</td>
            <td><button className="btn sm" onClick={() => rotate(d)}>Novi ključ</button></td>
          </tr>))}
        </tbody>
      </table>
      <form className="row" style={{ gap: 8, marginTop: 8 }} onSubmit={createBridge}>
        <input className="input" placeholder="Naziv (npr. Računar u kancelariji)" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} />
        <button className="btn primary" disabled={!newName.trim()}>+ Registruj bridge</button>
      </form>
      {key && (
        <Modal title={`Ključ za „${key.name}“`} onClose={() => setKey(null)}>
          <p className="warn-text"><strong>Ključ se prikazuje samo sada.</strong> Upišite ga u <code>apps/print-bridge/.env</code> kao <code>BRIDGE_KEY=…</code>.</p>
          <textarea className="input" readOnly rows={3} value={key.apiKey} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: 'monospace' }} />
          <div className="modal-actions">
            <button className="btn" onClick={() => navigator.clipboard?.writeText(key.apiKey).then(() => toast('ok', 'Kopirano'), () => toast('err', 'Kopiranje nije dozvoljeno — označite i kopirajte ručno'))}>Kopiraj</button>
            <button className="btn primary" onClick={() => setKey(null)}>Zapisao sam ključ</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Jobs() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const jobs = useLoad(() => api<Job[]>('GET', `/print-jobs${status ? `?status=${status}` : ''}`), [status]);
  const retry = async (j: Job) => {
    try { await api('POST', `/print-jobs/${j.id}/retry`, {}); jobs.reload(); toast('ok', 'Zadatak vraćen u red'); } catch (e: any) { toast('err', e.message); }
  };
  return (
    <>
      <div className="toolbar">
        <select className="input" style={{ maxWidth: 220 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Svi statusi</option>
          {Object.entries(JOB_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn" onClick={jobs.reload}>Osveži</button>
      </div>
      {jobs.error ? <ErrorBox error={jobs.error} onRetry={jobs.reload} /> : !jobs.data ? <Spinner /> : !jobs.data.length ? <Empty>Nema zadataka.</Empty> : (
        <table className="tbl">
          <thead><tr><th>Vreme</th><th>Vrsta</th><th>Štampač</th><th>Sadržaj</th><th>Status</th><th className="num">Pokušaji</th><th /></tr></thead>
          <tbody>{jobs.data.map((j) => (
            <tr key={j.id}>
              <td>{dt(j.createdAt)}</td><td>{JOB_KIND[j.kind] ?? j.kind}</td><td>{j.printerName}{j.stationName ? ` · ${j.stationName}` : ''}</td>
              <td className="small">{j.payload?.orderNumber ? `#${j.payload.orderNumber} ${j.payload.table ?? ''}` : ''}{j.payload?.batch ? ` · tura ${j.payload.batch}` : ''}</td>
              <td><span className={`badge ${j.status === 'FAILED' ? 'cancelled' : j.status === 'PRINTED' ? 'paid' : ''}`}>{JOB_STATUS[j.status] ?? j.status}</span>
                {j.lastError && <div className="warn-text small">{j.lastError}</div>}</td>
              <td className="num">{j.attempts}</td>
              <td>{j.status === 'FAILED' && <button className="btn sm" onClick={() => retry(j)}>Ponovi</button>}</td>
            </tr>))}
          </tbody>
        </table>
      )}
    </>
  );
}
