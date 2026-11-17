import { FormEvent, useState } from 'react';
import { api, Category } from '@shared/api';
import { ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';

interface Printer { id: string; name: string; connection: 'SIMULATED' | 'NETWORK_ESCPOS' | 'WINDOWS_RAW'; host: string | null; port: number | null; windowsName: string | null; paperWidth: number; active: boolean; bridgeDeviceId?: string | null }
interface Station { id: string; name: string; kind: 'BAR' | 'KITCHEN' | 'OTHER'; printerId: string | null; kdsEnabled: boolean; active: boolean }
type Group = Category & { prepStationId?: string | null; printerId?: string | null };

const KIND: Record<Station['kind'], string> = { BAR: 'Šank', KITCHEN: 'Kuhinja', OTHER: 'Ostalo' };
const CONN: Record<Printer['connection'], string> = { WINDOWS_RAW: 'Windows (instaliran drajver)', NETWORK_ESCPOS: 'Mreža (IP adresa)', SIMULATED: 'Simulacija (bez papira)' };

/**
 * Kategorije: najviši nivo (ŠANK, KUHINJA). Grupe pripadaju kategoriji; kategorija deli kraj dana i ima KDS ekran.
 */
export function Categories() {
  const stations = useLoad(() => api<Station[]>('GET', '/prep-stations'), []);
  const groups = useLoad(() => api<Group[]>('GET', '/categories'), []);
  const printers = useLoad(() => api<Printer[]>('GET', '/printers'), []);
  const [edit, setEdit] = useState<Station | 'new' | null>(null);
  const toast = useToast();
  /** redosled na kasi: dugmad kategorija i artikli na SVE */
  const move = async (i: number, d: -1 | 1) => {
    const l = [...stations.data!]; const j = i + d; if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    try { stations.setData(await api<Station[]>('PUT', '/prep-stations/order', { ids: l.map((x) => x.id) })); toast('ok', 'Redosled sačuvan - kase ga vide posle Osveži'); } catch (e: any) { toast('err', e.message); }
  };
  if (stations.loading && !stations.data) return <Spinner />;
  if (stations.error) return <ErrorBox error={stations.error} onRetry={stations.reload} />;
  return (
    <div className="page">
      <div className="toolbar"><span className="muted">Kategorije su najviši nivo (npr. ŠANK, KUHINJA). Grupe se vezuju za kategoriju, proizvodi za grupe. Strelicama birate redosled na kasi.</span>
        <button className="btn primary" onClick={() => setEdit('new')}>+ Kategorija</button></div>
      <table className="tbl clickable">
        <thead><tr><th>Redosled na kasi</th><th>Kategorija</th><th>Vrsta</th><th>Grupe</th><th>Štampač (podrazumevani)</th><th>Ekran kuhinje (KDS)</th><th>Status</th></tr></thead>
        <tbody>
          {stations.data!.map((s, i) => (
            <tr key={s.id} onClick={() => setEdit(s)}>
              <td onClick={(e) => e.stopPropagation()} className="ord"><b>{i + 1}.</b> <button className="btn sm" disabled={i === 0} onClick={() => void move(i, -1)} aria-label="Gore">▲</button> <button className="btn sm" disabled={i === stations.data!.length - 1} onClick={() => void move(i, 1)} aria-label="Dole">▼</button></td>
              <td><strong>{s.name.toUpperCase()}</strong></td><td>{KIND[s.kind]}</td>
              <td className="small">{groups.data?.filter((g) => g.prepStationId === s.id).map((g) => g.name).join(', ') || '-'}</td>
              <td>{printers.data?.find((p) => p.id === s.printerId)?.name ?? '-'}</td>
              <td>{s.kdsEnabled ? 'da' : 'ne'}</td>
              <td>{s.active ? <span className="badge paid">Aktivna</span> : <span className="badge cancelled">Neaktivna</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <StationForm station={edit === 'new' ? null : edit} printers={printers.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); stations.reload(); }} />}
    </div>
  );
}

function StationForm({ station, printers, onClose, onSaved }: { station: Station | null; printers: Printer[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: station?.name ?? '', kind: station?.kind ?? 'BAR', printerId: station?.printerId ?? '', kdsEnabled: station?.kdsEnabled ?? true, active: station?.active ?? true });
  const [error, setError] = useState<unknown>();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(undefined);
    const body = { name: f.name.trim(), kind: f.kind, printerId: f.printerId || null, kdsEnabled: f.kdsEnabled };
    try {
      if (station) await api('PATCH', `/prep-stations/${station.id}`, { ...body, active: f.active });
      else await api('POST', '/prep-stations', body);
      onSaved();
    } catch (err) { setError(err); }
  };
  return (
    <Modal title={station ? `Kategorija: ${station.name}` : 'Nova kategorija'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Naziv<input className="input" value={f.name} required maxLength={60} placeholder="npr. ŠANK" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Vrsta (za kraj dana: prodaja Šank / Kuhinja)<select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Station['kind'] })}>
          {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Podrazumevani štampač (grupa može imati svoj)<select className="input" value={f.printerId} onChange={(e) => setF({ ...f, printerId: e.target.value })}>
          <option value="">bez štampe</option>{printers.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={f.kdsEnabled} onChange={(e) => setF({ ...f, kdsEnabled: e.target.checked })} /> Prikazuje se na ekranu kuhinje (KDS)</label>
        {station && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aktivna</label>}
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button className="btn primary">Sačuvaj</button><button type="button" className="btn" onClick={onClose}>Odustani</button></div>
      </form>
    </Modal>
  );
}

/**
 * Štampanje grupa: prvo štampači (naziv kako je štampač nazvan u Windowsu posle instalacije drajvera, širina papira),
 * zatim tabela grupa i desno štampač na koji izlazi porudžbina pri kucanju.
 */
export function GroupPrinting() {
  const toast = useToast();
  const printers = useLoad(() => api<Printer[]>('GET', '/printers'), []);
  const groups = useLoad(() => api<Group[]>('GET', '/categories'), []);
  const stations = useLoad(() => api<Station[]>('GET', '/prep-stations'), []);
  const bridges = useLoad(() => api<{ id: string; name: string; kind: string }[]>('GET', '/devices').then((d) => d.filter((x) => x.kind === 'BRIDGE')).catch(() => []), []);
  const [edit, setEdit] = useState<Printer | 'new' | null>(null);
  const setGroup = async (g: Group, patch: Partial<Group>) => {
    try { await api('PATCH', `/categories/${g.id}`, patch); groups.reload(); toast('ok', 'Sačuvano'); }
    catch (e: any) { toast('err', e.message); }
  };
  if ((printers.loading && !printers.data) || (groups.loading && !groups.data)) return <Spinner />;
  if (printers.error || groups.error) return <ErrorBox error={printers.error ?? groups.error} onRetry={() => { printers.reload(); groups.reload(); }} />;
  return (
    <div className="page two-cards">
      <section className="card">
        <div className="row-between"><h3>Štampači</h3><button className="btn primary sm" onClick={() => setEdit('new')}>+ Štampač</button></div>
        <p className="muted small">USB štampač (npr. Bixolon za račune): instalirajte drajver u Windowsu na računaru na koji je priključen i ovde upišite tačan naziv iz Windowsa (Podešavanja → Štampači), npr. GenericSank_40, pa izaberite taj računar. Mrežni štampač (kuhinja, šank): veza „Mrežni" i IP adresa - štampa ga bilo koja kasa.</p>
        <table className="tbl clickable">
          <thead><tr><th>Naziv u Windowsu</th><th>Veza</th><th>Računar</th><th>Papir</th><th>Status</th></tr></thead>
          <tbody>
            {printers.data!.map((p) => (
              <tr key={p.id} onClick={() => setEdit(p)}>
                <td><strong>{p.windowsName || p.name}</strong>{p.windowsName && p.windowsName !== p.name && <div className="muted small">{p.name}</div>}</td>
                <td>{CONN[p.connection]}{p.connection === 'NETWORK_ESCPOS' && p.host ? ` ${p.host}:${p.port ?? 9100}` : ''}</td>
                <td>{bridges.data?.find((b) => b.id === p.bridgeDeviceId)?.name ?? (p.connection === 'NETWORK_ESCPOS' ? 'bilo koji (mreža)' : 'bilo koji')}</td>
                <td>{p.paperWidth} mm</td>
                <td>{p.active ? <span className="badge paid">Aktivan</span> : <span className="badge cancelled">Neaktivan</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Grupe → štampač</h3>
        <table className="tbl">
          <thead><tr><th>Grupa</th><th>Kategorija</th><th>Štampač za porudžbine</th></tr></thead>
          <tbody>
            {groups.data!.map((g) => {
              const st = stations.data?.find((s) => s.id === g.prepStationId);
              const fallback = printers.data!.find((p) => p.id === st?.printerId);
              return (
                <tr key={g.id}>
                  <td><strong>{g.name}</strong></td>
                  <td><select className="input" value={g.prepStationId ?? ''} onChange={(e) => setGroup(g, { prepStationId: e.target.value || null })}>
                    <option value="">bez kategorije</option>{stations.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
                  <td><select className="input" value={g.printerId ?? ''} onChange={(e) => setGroup(g, { printerId: e.target.value || null })}>
                    <option value="">{fallback ? `kao kategorija (${fallback.name})` : 'bez štampe'}</option>
                    {printers.data!.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.windowsName || p.name}</option>)}</select></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {edit && <PrinterForm printer={edit === 'new' ? null : edit} bridges={bridges.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); printers.reload(); }} />}
    </div>
  );
}

function PrinterForm({ printer, bridges, onClose, onSaved }: { printer: Printer | null; bridges: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    windowsName: printer?.windowsName ?? printer?.name ?? '', connection: printer?.connection ?? 'WINDOWS_RAW',
    host: printer?.host ?? '', port: String(printer?.port ?? 9100), paperWidth: printer?.paperWidth ?? 80, active: printer?.active ?? true, bridgeDeviceId: printer?.bridgeDeviceId ?? '',
  });
  const [error, setError] = useState<unknown>();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(undefined);
    const name = f.windowsName.trim();
    const body: any = { name, connection: f.connection, paperWidth: f.paperWidth, windowsName: f.connection === 'WINDOWS_RAW' ? name : null, bridgeDeviceId: f.bridgeDeviceId || null };
    if (f.connection === 'NETWORK_ESCPOS') { body.host = f.host.trim(); body.port = Number(f.port) || 9100; }
    try {
      if (printer) await api('PATCH', `/printers/${printer.id}`, { ...body, active: f.active });
      else await api('POST', '/printers', body);
      onSaved();
    } catch (err) { setError(err); }
  };
  return (
    <Modal title={printer ? `Štampač: ${printer.name}` : 'Novi štampač'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Naziv štampača (tačno kao u Windowsu)<input className="input" value={f.windowsName} required maxLength={60} placeholder="npr. GenericSank_40" onChange={(e) => setF({ ...f, windowsName: e.target.value })} /></label>
        <label>Veza<select className="input" value={f.connection} onChange={(e) => setF({ ...f, connection: e.target.value as Printer['connection'] })}>
          {Object.entries(CONN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {f.connection === 'NETWORK_ESCPOS' && (
          <div className="grid2 tight">
            <label>IP adresa<input className="input" value={f.host} required placeholder="192.168.1.50" onChange={(e) => setF({ ...f, host: e.target.value })} /></label>
            <label>Port<input className="input" inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, '') })} /></label>
          </div>
        )}
        <label>Računar na koji je štampač priključen
          <select className="input" value={f.bridgeDeviceId} onChange={(e) => setF({ ...f, bridgeDeviceId: e.target.value })}>
            <option value="">{f.connection === 'NETWORK_ESCPOS' ? 'Bilo koji (mrežni štampač)' : 'Bilo koji'}</option>
            {bridges.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <small className="muted">USB/Windows štampač štampa samo računar na koji je priključen (njegov Print Bridge).</small>
        </label>
        <label>Širina papira (trake)
          <div className="seg">
            {[80, 58].map((w) => <button key={w} type="button" className={`seg-btn ${f.paperWidth === w ? 'on' : ''}`} onClick={() => setF({ ...f, paperWidth: w })}>{w} mm</button>)}
          </div>
        </label>
        <p className="muted small">Veličina papira u Windows drajveru (npr. 80×3276 ili 80×297) ne utiče: kasa šalje komande direktno štampaču i seče papir posle svakog isečka. Bitna je samo širina: 80 mm (48 znakova) ili 58 mm (32 znaka).</p>
        {printer && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aktivan</label>}
        <p className="muted small">Probna strana i red štampe: Štampanje → Napredno.</p>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button className="btn primary">Sačuvaj</button><button type="button" className="btn" onClick={onClose}>Odustani</button></div>
      </form>
    </Modal>
  );
}
