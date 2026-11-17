import { FormEvent, useEffect, useState } from 'react';
import { api, Category } from '@shared/api';
import { ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { useTab } from './tabs';

type Feature = 'quickSale' | 'receipts' | 'endOfDay' | 'shift' | 'priceList' | 'transfer' | 'storno' | 'cash' | 'card';
interface Computer {
  id: string; name: string; kind: 'POS' | 'KDS'; active: boolean; lastSeenAt: string | null; priceListId: string | null; receiptPrinterId: string | null;
  settings: { hiddenGroups: string[]; hiddenFeatures: Feature[]; fiscal: Fiscal; print: Print; defaultUserId?: string | null };
}
const FEATURE_LABEL: Record<Feature, string> = {
  quickSale: 'Novi (brzi) račun', receipts: 'Pregled računa', endOfDay: 'Kraj dana', shift: 'Otvaranje / zatvaranje smene',
  priceList: 'Postavi cenovnik', transfer: 'Prebacivanje (P)', storno: 'Storniranje (S)', cash: 'Brza naplata gotovinom (G)', card: 'Brza naplata karticom (K)',
};
interface Print { logoOnReceipt: boolean; footerOnReceipt: boolean; autoReceipt: boolean }
interface Fiscal { useVpfr: boolean; lpfrUrl: string; vpfrCertPath: string; certPassword: string; pac: string; pin: string; jid: string }
const KIND: Record<Computer['kind'], string> = { POS: 'Kasa', KDS: 'KDS ekran' };

const CTABS = [['basic', 'Osnovni podaci'], ['look', 'Izgled (grupe)'], ['features', 'Funkcije'], ['print', 'Štampa'], ['efis', 'Elektronska fiskalizacija']] as const;
type CT = (typeof CTABS)[number][0];

/**
 * Podešavanje računara (kao u Octopos-u "Podešavanje računara: POS-PC"): levo računari, desno tabovi -
 * osnovni podaci i cenovnik, vidljive grupe, funkcije (dugmad), štampa (štampač računa, logo, kraj računa)
 * i elektronska fiskalizacija (VPFR/LPFR, putanja do pfx, lozinka, PAK, PIN).
 */
export function Computers() {
  const toast = useToast();
  const list = useLoad(() => api<Computer[]>('GET', '/computers'), []);
  const cats = useLoad(() => api<Category[]>('GET', '/categories'), []);
  const lists = useLoad(() => api<{ id: string; name: string; active: boolean }[]>('GET', '/price-lists').catch(() => []), []);
  const printers = useLoad(() => api<{ id: string; name: string; windowsName: string | null; active: boolean }[]>('GET', '/printers').catch(() => []), []);
  const [selId, setSelId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (!selId && list.data?.length) setSelId(list.data.find((c) => c.kind === 'POS')?.id ?? list.data[0].id); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (list.loading && !list.data) return <Spinner />;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  const c = list.data?.find((x) => x.id === selId) ?? null;
  return (
    <div className="page wide side-layout narrow-side">
      <aside className="side">
        <div className="cl-head"><b>Računari</b></div>
        <div className="pc-list">
          {list.data!.map((d) => (
            <button key={d.id} className={`pc-item ${d.id === selId ? 'on' : ''} ${d.active ? '' : 'off'}`} onClick={() => setSelId(d.id)}>
              <b>{d.name}</b><small>{KIND[d.kind]}{d.lastSeenAt ? ` · ${new Date(d.lastSeenAt).toLocaleDateString('sr-Latn-RS')}` : ''}{d.active ? '' : ' · isključen'}</small>
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => setAdding(true)}>+ Računar</button>
        <small className="muted">Kasa primenjuje izmene posle dugmeta „Osveži“.</small>
      </aside>
      <div className="side-main">
        {c ? <ComputerForm key={c.id} c={c} cats={cats.data ?? []} lists={(lists.data ?? []).filter((l) => l.active)} printers={(printers.data ?? []).filter((p) => p.active)}
          onSaved={() => { list.reload(); toast('ok', 'Sačuvano'); }} /> : <p className="muted">Izaberite računar.</p>}
      </div>
      {adding && <NewComputer onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); }} />}
    </div>
  );
}

function ComputerForm({ c, cats, lists, printers, onSaved }: {
  c: Computer; cats: Category[]; lists: { id: string; name: string }[]; printers: { id: string; name: string; windowsName: string | null }[]; onSaved: () => void;
}) {
  const tab = useTab();
  const [t, setT] = useState<CT>('basic');
  const [receiptPrinterId, setReceiptPrinterId] = useState(c.receiptPrinterId ?? '');
  const [fiscal, setFiscal] = useState<Fiscal>(c.settings.fiscal);
  const [print, setPrint] = useState<Print>({ logoOnReceipt: true, footerOnReceipt: true, autoReceipt: true, ...(c.settings.print as Partial<Print> | undefined) });
  const [name, setName] = useState(c.name);
  const [active, setActive] = useState(c.active);
  const [priceListId, setPriceListId] = useState(c.priceListId ?? '');
  const [hidden, setHidden] = useState<string[]>(c.settings.hiddenGroups);
  const [off, setOff] = useState<Feature[]>(c.settings.hiddenFeatures);
  const [defaultUserId, setDefaultUserId] = useState(c.settings.defaultUserId ?? '');
  const users = useLoad(() => api<{ id: string; fullName: string; active: boolean }[]>('GET', '/users').catch(() => []), []);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const d = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { fn(...a); setDirty(true); };
  const pos = c.kind === 'POS';
  const submit = async (e?: FormEvent) => {
    e?.preventDefault(); setBusy(true); setError(undefined);
    try {
      await api('PATCH', `/computers/${c.id}`, {
        name: name.trim(), active, ...(pos ? { priceListId: priceListId || null, settings: { hiddenGroups: hidden, hiddenFeatures: off, print, defaultUserId: defaultUserId || null, fiscal: { ...fiscal, lpfrUrl: fiscal.lpfrUrl.trim(), vpfrCertPath: fiscal.vpfrCertPath.trim(), pac: fiscal.pac.trim().toUpperCase(), jid: fiscal.jid.trim() } } } : {}),
      });
      if (pos && (receiptPrinterId || null) !== c.receiptPrinterId) await api('PATCH', `/devices/${c.id}/receipt-printer`, { receiptPrinterId: receiptPrinterId || null });
      setDirty(false); onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const tabs = CTABS.filter(([k]) => pos || k === 'basic');
  return (
    <form className="pc-form" onSubmit={submit}>
      <h3 className="pc-title">Podešavanje računara: {c.name}</h3>
      <div className="stabs" role="tablist">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={t === k} className={`stab ${t === k ? 'on' : ''}`} onClick={() => setT(k)}>{l}</button>)}
      </div>
      <div className="stabs-body sf">
        {t === 'basic' && <>
          <label className="sf-row"><span>Naziv računara</span><input className="input" value={name} maxLength={60} required onChange={(e) => d(setName)(e.target.value)} /></label>
          <div className="sf-row"><span>Vrsta</span><b>{KIND[c.kind]}</b></div>
          {pos && <label className="sf-row"><span>Cenovnik na ovoj kasi</span><select className="input" value={priceListId} onChange={(e) => d(setPriceListId)(e.target.value)}>
            <option value="">Osnovne cene</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
          {pos && <label className="sf-row"><span>Podrazumevani korisnik <small className="muted">(kasa bez šifre, npr. fast food)</small></span>
            <select className="input" value={defaultUserId} onChange={(e) => d(setDefaultUserId)(e.target.value)}>
              <option value="">nema - kucaju se šifre</option>
              {(users.data ?? []).filter((x) => x.active || x.id === defaultUserId).map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
            </select></label>}
          {pos && defaultUserId && <p className="muted small">Kasa se sama prijavljuje kao izabrani korisnik i ne traži šifru ni za stolove. Posle „Odjava“ se kuca šifra do ponovnog pokretanja kase. Storno i dalje traži šifru ako izabrani korisnik nema to pravo.</p>}
          <label className="check"><input type="checkbox" checked={active} onChange={(e) => d(setActive)(e.target.checked)} /> Aktivan (isključen računar ne može da se prijavi)</label>
          {!pos && <p className="muted small">Grupe i izgled KDS ekrana podešavaju se na samom ekranu (⚙ Podešavanja).</p>}
        </>}
        {t === 'look' && <>
          <p className="muted small">Štiklirane grupe se prikazuju na ovoj kasi (npr. kasa na šanku bez hrane).</p>
          <div className="disc-list">
            {cats.map((g) => (
              <label key={g.id} className={`disc-item ${hidden.includes(g.id) ? '' : 'on'}`}>
                <input type="checkbox" checked={!hidden.includes(g.id)} onChange={(e) => d(setHidden)(e.target.checked ? hidden.filter((x) => x !== g.id) : [...hidden, g.id])} />
                <span>{g.name}</span>
              </label>
            ))}
          </div>
        </>}
        {t === 'features' && <>
          <p className="muted small">Dugmad na ovoj kasi. Prava zaposlenih i dalje važe.</p>
          <div className="disc-list">
            {(Object.keys(FEATURE_LABEL) as Feature[]).map((f) => (
              <label key={f} className={`disc-item ${off.includes(f) ? '' : 'on'}`}>
                <input type="checkbox" checked={!off.includes(f)} onChange={(e) => d(setOff)(e.target.checked ? off.filter((x) => x !== f) : [...off, f])} />
                <span>{FEATURE_LABEL[f]}</span>
              </label>
            ))}
          </div>
        </>}
        {t === 'print' && <>
          <label className="sf-row"><span>Štampač računa (fiskalni isečak)</span><select className="input" value={receiptPrinterId} onChange={(e) => d(setReceiptPrinterId)(e.target.value)}>
            <option value="">nije izabran</option>{printers.map((p) => <option key={p.id} value={p.id}>{p.windowsName || p.name}</option>)}</select></label>
          <label className="sf-row"><span>Štampaj račun posle naplate</span><input type="checkbox" checked={print.autoReceipt} onChange={(e) => d(setPrint)({ ...print, autoReceipt: e.target.checked })} /></label>
          <label className="sf-row"><span>Štampaj logo na fiskalnom računu</span><input type="checkbox" checked={print.logoOnReceipt} onChange={(e) => d(setPrint)({ ...print, logoOnReceipt: e.target.checked })} /></label>
          <label className="sf-row"><span>Štampaj tekst i sliku na kraju računa</span><input type="checkbox" checked={print.footerOnReceipt} onChange={(e) => d(setPrint)({ ...print, footerOnReceipt: e.target.checked })} /></label>
          <p className="muted small">Logo, tekst i slika na kraju računa biraju se u Podešavanje aplikacije (Podaci o računima, Elektronska fiskalizacija). Štampači porudžbina po grupama: Štampanje → Štampanje grupa. Širina trake (58/80 mm) i veza štampača: Štampanje → Napredno.</p>
        </>}
        {t === 'efis' && <>
          <label className="check"><input type="checkbox" checked={fiscal.useVpfr} onChange={(e) => d(setFiscal)({ ...fiscal, useVpfr: e.target.checked })} /> Koristi VPFR (virtuelni procesor Poreske uprave) - inače LPFR</label>
          <label className="sf-row"><span>LPFR URL</span><input className="input" disabled={fiscal.useVpfr} value={fiscal.lpfrUrl} placeholder="npr. localhost:5555 ili 192.168.1.21:5555" onChange={(e) => d(setFiscal)({ ...fiscal, lpfrUrl: e.target.value })} /></label>
          <label className="sf-row"><span>Putanja do pfx</span><input className="input" disabled={!fiscal.useVpfr} value={fiscal.vpfrCertPath} placeholder={'npr. C:\\Cert\\sertifikat.p12'} onChange={(e) => d(setFiscal)({ ...fiscal, vpfrCertPath: e.target.value })} /></label>
          <label className="sf-row"><span>Lozinka za pfx</span><input className="input" type="password" disabled={!fiscal.useVpfr} value={fiscal.certPassword} maxLength={100} onChange={(e) => d(setFiscal)({ ...fiscal, certPassword: e.target.value })} /></label>
          <label className="sf-row"><span>PAK</span><input className="input" disabled={!fiscal.useVpfr} value={fiscal.pac} maxLength={6} placeholder="iz koverte Poreske uprave" onChange={(e) => d(setFiscal)({ ...fiscal, pac: e.target.value })} /></label>
          <label className="sf-row"><span>PIN bezbednosnog elementa</span><input className="input" type="password" inputMode="numeric" maxLength={8} value={fiscal.pin} onChange={(e) => d(setFiscal)({ ...fiscal, pin: e.target.value.replace(/[^0-9]/g, '') })} /></label>
          <label className="sf-row"><span>JID</span><input className="input" value={fiscal.jid} maxLength={40} onChange={(e) => d(setFiscal)({ ...fiscal, jid: e.target.value })} /></label>
          <p className="muted small">Račune šalje server na glavnoj kasi: „localhost“ je glavni računar - LPFR na drugoj kasi upišite njenom IP adresom; putanja do pfx je na GLAVNOM računaru.
            Pravi računi idu tek kad u Podešavanje aplikacije → Elektronska fiskalizacija izaberete LPFR/VPFR; do tada su TEST (ОБУКА).</p>
          <CheckFiscal id={c.id} />
        </>}
      </div>
      {error !== undefined && <ErrorBox error={error} />}
      <div className="bar">
        <div className="bar-left" />
        <div className="bar-right">
          <button className="btn primary" disabled={busy || !name.trim() || !dirty}>{busy ? 'Čuvam…' : 'Sačuvaj'}</button>
          <button type="button" className="btn" onClick={tab.close}>Zatvori</button>
        </div>
      </div>
    </form>
  );
}

function NewComputer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'POS' | 'KDS'>('POS');
  const [error, setError] = useState<unknown>();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(undefined);
    try { await api('POST', '/computers', { name: name.trim(), kind }); onSaved(); } catch (err) { setError(err); }
  };
  return (
    <Modal title="Novi računar" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="seg">
          <button type="button" className={`seg-btn ${kind === 'POS' ? 'on' : ''}`} onClick={() => setKind('POS')}>Kasa</button>
          <button type="button" className={`seg-btn ${kind === 'KDS' ? 'on' : ''}`} onClick={() => setKind('KDS')}>KDS ekran</button>
        </div>
        <label>Naziv<input className="input" autoFocus value={name} maxLength={60} required placeholder={kind === 'POS' ? 'npr. Kasa terasa' : 'npr. KDS šank'} onChange={(e) => setName(e.target.value)} /></label>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions">
          <button className="btn primary" disabled={!name.trim()}>Dodaj</button>
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
        </div>
      </form>
    </Modal>
  );
}

/** Provera veze sa LPFR/VPFR ove kase (snimljena podešavanja) - bez izdavanja računa. */
function CheckFiscal({ id }: { id: string }) {
  const [r, setR] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setR(null);
    try { setR(await api<{ ok: boolean; message: string }>('POST', `/fiscal/check/${id}`)); } catch (e: any) { setR({ ok: false, message: e?.message ?? String(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="row gap">
      <button type="button" className="btn" disabled={busy} onClick={run}>{busy ? 'Proveravam…' : 'Proveri vezu (snimljena podešavanja)'}</button>
      {r && <span className={r.ok ? 'ok-text' : 'err-text'}>{r.ok ? '✓ ' : '✗ '}{r.message}</span>}
    </div>
  );
}
