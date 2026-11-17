import { useState } from 'react';
import { api } from '@shared/api';
import { ErrorBox, Spinner, useLoad, useToast } from '@shared/ui';
import { toRaster } from './AdminMore';
import { KasaSettings } from './KasaSettings';
import { Fiscal } from './Fiscal';
import { Printing } from './Printing';
import { useTab } from './tabs';
import { SlipLines } from './ReceiptSlip';

const TABS = [['receipt', 'Podaci o računima'], ['app', 'Podešavanje aplikacije'], ['efis', 'Elektronska fiskalizacija'], ['fiscal', 'Fiskalni (red računa)'], ['print', 'Print server']] as const;
type T = (typeof TABS)[number][0];

/** Podešavanje aplikacije (kao u Octopos-u): tabovi za podatke na računu, kasu, elektronsku fiskalizaciju, red fiskalnih računa i štampu. */
export function AppSettings() {
  const [t, setT] = useState<T>('receipt');
  return (
    <div className="page wide stabs-page">
      <div className="stabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={t === k} className={`stab ${t === k ? 'on' : ''}`} onClick={() => setT(k)}>{l}</button>)}
      </div>
      <div className="stabs-body">
        {t === 'receipt' && <ReceiptData />}
        {t === 'app' && <KasaSettings />}
        {t === 'efis' && <EFiscal />}
        {t === 'fiscal' && <Fiscal />}
        {t === 'print' && <Printing />}
      </div>
    </div>
  );
}

/** Zajedničko čuvanje podešavanja lokala: lokalne izmene (f) preko učitanih, Sačuvaj / Odustani u dnu. */
function useKasa() {
  const toast = useToast();
  const s = useLoad(() => api<any>('GET', '/settings/kasa'), []);
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const v = f ?? s.data;
  const set = (patch: object) => setF({ ...v, ...patch });
  const save = async (keys: string[]) => {
    setBusy(true);
    try {
      const body = Object.fromEntries(keys.map((k) => [k, typeof v[k] === 'string' ? v[k].trim() : v[k]]));
      s.setData(await api('PUT', '/settings/kasa', body)); setF(null); toast('ok', 'Sačuvano - važi za sledeću štampu');
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  return { s, v, set, dirty: !!f, busy, save, reset: () => setF(null) };
}

function SaveBar({ k, keys }: { k: ReturnType<typeof useKasa>; keys: string[] }) {
  const tab = useTab();
  return (
    <div className="bar">
      <div className="bar-left" />
      <div className="bar-right">
        <button className="btn primary" disabled={k.busy || !k.dirty} onClick={() => void k.save(keys)}>{k.busy ? 'Čuvam…' : 'Sačuvaj'}</button>
        <button className="btn" disabled={!k.dirty} onClick={k.reset}>Odustani</button>
        <button className="btn" onClick={tab.close}>Zatvori</button>
      </div>
    </div>
  );
}

const DATA_KEYS = ['pib', 'esirNumber', 'registrationNo', 'bankAccount', 'phone', 'email', 'website', 'companyName', 'storeName', 'address', 'city', 'receiptHeader', 'receiptLogo', 'receiptLogoPreview', 'ticketLarge', 'representationPrint'];

/** Podaci o računima: zaglavlje fiskalnog računa (PIB, firma, adresa, žiro račun…), logo i izgled porudžbina; desno pregled isečka. */
function ReceiptData() {
  const toast = useToast();
  const k = useKasa();
  if (k.s.loading && !k.s.data) return <Spinner />;
  if (k.s.error) return <ErrorBox error={k.s.error} onRetry={k.s.reload} />;
  const v = k.v;
  const logo = async (file?: File) => {
    if (!file) return;
    try { const r = await toRaster(file, 384); k.set({ receiptLogo: r.raster, receiptLogoPreview: r.preview }); } catch (e: any) { toast('err', e.message); }
  };
  const field = (key: string, label: string, max: number, ph = '', note = '') => (
    <label key={key} className="sf-row"><span>{label}{note && <small className="muted"> {note}</small>}</span>
      <input className="input" maxLength={max} value={v[key] ?? ''} placeholder={ph} onChange={(e) => k.set({ [key]: key === 'pib' ? e.target.value.replace(/[^0-9]/g, '') : e.target.value })} /></label>
  );
  return (
    <>
      <div className="sf-cols">
        <section className="sf">
          <h4>Zaglavlje fiskalnog računa</h4>
          {field('pib', 'PIB', 9, '9 cifara')}
          {field('companyName', 'Naziv firme', 120)}
          {field('storeName', 'Prodajno mesto', 120)}
          {field('address', 'Adresa', 120)}
          {field('city', 'Mesto', 60)}
          {field('esirNumber', 'ESIR broj', 30, 'npr. 284/3')}
          <h4>Dodatno (prazno = ne štampa se)</h4>
          {field('registrationNo', 'Matični broj', 20)}
          {field('bankAccount', 'Žiro račun', 60, '160-0000000123456-78')}
          {field('phone', 'Telefon', 40)}
          {field('email', 'Email', 80)}
          {field('website', 'Sajt', 80)}
          <label className="sf-row top"><span>Tekst ispod zaglavlja</span><textarea className="input" rows={2} maxLength={300} value={v.receiptHeader} onChange={(e) => k.set({ receiptHeader: e.target.value })} /></label>
          <div className="sf-row"><span>Logo na vrhu računa</span>
            <div className="rl-logo">
              {v.receiptLogoPreview ? <img src={v.receiptLogoPreview} alt="logo" /> : <span className="muted small">nema logoa</span>}
              <label className="btn sm">Izaberi sliku<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void logo(e.target.files?.[0])} /></label>
              {v.receiptLogo && <button className="btn sm danger-ghost" onClick={() => k.set({ receiptLogo: null, receiptLogoPreview: null })}>Ukloni</button>}
            </div>
          </div>
          <div className="sf-row"><span>Porudžbine (šank, kuhinja)</span>
            <div className="seg">
              <button className={`seg-btn ${v.ticketLarge ? 'on' : ''}`} onClick={() => k.set({ ticketLarge: true })}>Velika slova</button>
              <button className={`seg-btn ${!v.ticketLarge ? 'on' : ''}`} onClick={() => k.set({ ticketLarge: false })}>Normalna slova</button>
            </div>
          </div>
          <h4>Reprezentacija (na kuću)</h4>
          <RepChoice v={v} onPick={(m) => k.set({ representationPrint: m })} />
        </section>
        <SlipPreview v={v} />
      </div>
      <SaveBar k={k} keys={DATA_KEYS} />
    </>
  );
}

const EFIS_KEYS = ['fiscalMode', 'lpfrUrl', 'vpfrUrl', 'receiptFooter', 'receiptFooterImage', 'receiptFooterImagePreview', 'receiptExtraFrom', 'receiptExtraTo'];

/**
 * Elektronska fiskalizacija (lokal): način rada (TEST / LPFR / VPFR) i podrazumevane adrese; slika i tekst na kraju računa,
 * sa periodom (datum od-do) u kome se štampaju. Sertifikat (pfx), lozinka, PAK i PIN su po računaru (Podešavanje računara).
 */
function EFiscal() {
  const toast = useToast();
  const k = useKasa();
  if (k.s.loading && !k.s.data) return <Spinner />;
  if (k.s.error) return <ErrorBox error={k.s.error} onRetry={k.s.reload} />;
  const v = k.v;
  const img = async (file?: File) => {
    if (!file) return;
    try { const r = await toRaster(file, 384); k.set({ receiptFooterImage: r.raster, receiptFooterImagePreview: r.preview }); } catch (e: any) { toast('err', e.message); }
  };
  return (
    <>
      <div className="sf-cols">
        <section className="sf">
          <h4>Fiskalni procesor</h4>
          <div className="sf-row"><span>Način rada</span>
            <div className="seg">
              {(['NONE', 'LPFR', 'VPFR'] as const).map((m) => <button key={m} className={`seg-btn ${v.fiscalMode === m ? 'on' : ''}`} onClick={() => k.set({ fiscalMode: m })}>{m === 'NONE' ? 'TEST (ОБУКА)' : m}</button>)}
            </div>
          </div>
          <label className="sf-row"><span>LPFR URL <small className="muted">(za kase bez svoje adrese)</small></span><input className="input" value={v.lpfrUrl} placeholder="http://192.168.1.20:5555" onChange={(e) => k.set({ lpfrUrl: e.target.value })} /></label>
          <label className="sf-row"><span>VPFR URL</span><input className="input" value={v.vpfrUrl} placeholder="https://vpfr.suf.purs.gov.rs" onChange={(e) => k.set({ vpfrUrl: e.target.value })} /></label>
          {v.fiscalMode === 'NONE'
            ? <p className="muted small">TEST: računi su ОБУКА i nisu fiskalni. Za prave račune izaberite LPFR ili VPFR.</p>
            : <p className="err-text small">PAŽNJA: svaka naplata izdaje PRAVI fiskalni račun. Putanja do pfx, lozinka, PAK i PIN podešavaju se po računaru (Podešavanje računara → Elektronska fiskalizacija) - tamo proverite vezu.</p>}
          <h4>Kraj računa</h4>
          <div className="sf-row top"><span>Slika na kraju računa</span>
            <div className="rl-logo big">
              {v.receiptFooterImagePreview ? <img src={v.receiptFooterImagePreview} alt="slika na kraju računa" /> : <span className="muted small">nema slike</span>}
              <label className="btn sm">Izaberi sliku<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void img(e.target.files?.[0])} /></label>
              {v.receiptFooterImage && <button className="btn sm danger-ghost" onClick={() => k.set({ receiptFooterImage: null, receiptFooterImagePreview: null })}>Ukloni</button>}
            </div>
          </div>
          <label className="sf-row top"><span>Tekst na kraju računa</span><textarea className="input" rows={4} maxLength={500} value={v.receiptFooter} onChange={(e) => k.set({ receiptFooter: e.target.value })} /></label>
          <div className="sf-row"><span>Datum od - do za tekst i sliku</span>
            <div className="sf-dates">
              <label className="check"><input type="checkbox" checked={!!v.receiptExtraFrom} onChange={(e) => k.set({ receiptExtraFrom: e.target.checked ? new Date().toISOString().slice(0, 10) : '' })} /></label>
              <input type="date" className="input" disabled={!v.receiptExtraFrom} value={v.receiptExtraFrom} onChange={(e) => k.set({ receiptExtraFrom: e.target.value })} />
              <label className="check"><input type="checkbox" checked={!!v.receiptExtraTo} onChange={(e) => k.set({ receiptExtraTo: e.target.checked ? new Date().toISOString().slice(0, 10) : '' })} /></label>
              <input type="date" className="input" disabled={!v.receiptExtraTo} value={v.receiptExtraTo} onChange={(e) => k.set({ receiptExtraTo: e.target.value })} />
            </div>
          </div>
          <p className="muted small">Bez datuma = tekst i slika se štampaju uvek. Sa datumom (npr. novogodišnja čestitka) - samo u tom periodu.</p>
        </section>
        <SlipPreview v={v} />
      </div>
      <SaveBar k={k} keys={EFIS_KEYS} />
    </>
  );
}

/** Pregled fiskalnog isečka sa trenutnim (nesačuvanim) podešavanjima. */
function SlipPreview({ v }: { v: any }) {
  return (
    <div className="rl-preview">
      <h4>Pregled računa</h4>
      <div className="slip fslip">
        <div>{'===== ОВО НИЈЕ ФИСКАЛНИ РАЧУН ====='}</div>
        {v.receiptLogoPreview && <img src={v.receiptLogoPreview} alt="" />}
        {[v.pib || 'PIB', v.companyName || 'Naziv firme', v.storeName || 'Prodajno mesto', v.address || 'Adresa', v.city || 'Mesto'].map((t: string, i: number) => <div key={i}>{t}</div>)}
        {(['registrationNo', 'bankAccount', 'phone', 'email', 'website'] as const).filter((x) => v[x]).map((x) => <div key={x} className="slip-c">{x === 'registrationNo' ? `МБ: ${v[x]}` : x === 'bankAccount' ? `Жиро рачун: ${v[x]}` : x === 'phone' ? `Тел: ${v[x]}` : v[x]}</div>)}
        {String(v.receiptHeader || '').split('\n').filter(Boolean).map((t: string, i: number) => <div key={`h${i}`}>{t}</div>)}
        <div className="slip-row"><span>Касир:</span><span>ADMIN</span></div>
        <div className="slip-row"><span>ЕСИР број:</span><span>{v.esirNumber || '-'}</span></div>
        <div>{'------ ОБУКА ПРОДАЈА ------'}</div>
        <div className="slip-sep dbl" />
        <div className="slip-row"><span>Espresso (Ђ)</span></div>
        <div className="slip-row"><span>       180,00</span><span>1   180,00</span></div>
        <div className="slip-sep" />
        <div className="slip-row"><b>Укупан износ:</b><b>180,00</b></div>
        <div className="slip-row"><span>Готовина:</span><span>180,00</span></div>
        <div className="slip-sep dbl" />
        <div className="slip-row"><span>ПФР број рачуна:</span><span>TEST-…</span></div>
        <div className="slip-qr">QR</div>
        {String(v.receiptFooter || '').split('\n').filter(Boolean).map((t: string, i: number) => <div key={`f${i}`}>{t}</div>)}
        {v.receiptFooterImagePreview && <img src={v.receiptFooterImagePreview} alt="" />}
        <div>{'=== КРАЈ ФИСКАЛНОГ РАЧУНА ==='}</div>
      </div>
    </div>
  );
}

/** Kako se štampa reprezentacija: dva pregleda (isti kod kao štampač), štiklira se jedan. */
function RepChoice({ v, onPick }: { v: any; onPick: (m: 'FISCAL' | 'SLIP') => void }) {
  const base = {
    location: v.storeName || 'Lokal', orderNumber: 57, table: 'Sto 12', waiter: 'Marko', createdAt: new Date().toISOString(),
    lines: [{ qty: '2.000', name: 'Coca-Cola 0,25', unitPrice: '250.00', total: '500.00', discount: '0.00', taxLabel: 'Ђ' }, { qty: '1.000', name: 'Pljeskavica', unitPrice: '1560.00', total: '1560.00', discount: '0.00', taxLabel: 'Ђ' }],
    subtotal: '2060.00', discount: '0.00', total: '2060.00', payments: [{ method: 'REPRESENTATION', amount: '2060.00', change: '0.00', note: 'Čast kuće' }],
  };
  const fiscal = { ...base, repStyle: 'FISCAL', fiscalLayout: { isFiscal: true, pib: v.pib || '123456789', company: v.companyName || 'Firma d.o.o.', store: v.storeName || 'Lokal', address: v.address || 'Adresa', city: v.city || 'Mesto',
    cashier: 'Marko', esir: v.esirNumber || '284/3', transaction: 'ПРОМЕТ ПРОДАЈА', taxes: [{ label: 'Ђ', name: 'О-ПДВ', rate: '20.00', tax: '343.33' }], taxTotal: '343.33',
    pfrTime: base.createdAt, pfrNumber: 'XXXXXXXX-XXXXXXXX-57', counter: '57/57ПП', representationNote: 'ОВО ЈЕ ФИСКАЛНИ РАЧУН - РЕПРЕЗЕНТАЦИЈА' } };
  const opts: ['FISCAL' | 'SLIP', string, string, any][] = [
    ['FISCAL', 'Fiskalni račun', 'Isti kao fiskalni račun, na dnu piše „ОВО ЈЕ ФИСКАЛНИ РАЧУН - РЕПРЕЗЕНТАЦИЈА“.', fiscal],
    ['SLIP', 'Kratak isečak (kao porudžbina)', 'Sto, konobar, vreme, stavke i „Za naplatu“ (posle popusta).', { ...base, repStyle: 'SLIP' }],
  ];
  const cur = v.representationPrint ?? 'FISCAL';
  return (
    <div className="rep-choice">
      {opts.map(([m, t, d, p]) => (
        <label key={m} className={cur === m ? 'rep-opt on' : 'rep-opt'}>
          <span className="rep-head"><input type="radio" name="repPrint" checked={cur === m} onChange={() => onPick(m)} /> <b>{t}</b></span>
          <small className="muted">{d}</small>
          <div className="rep-prev"><SlipLines payload={p} /></div>
        </label>
      ))}
    </div>
  );
}
