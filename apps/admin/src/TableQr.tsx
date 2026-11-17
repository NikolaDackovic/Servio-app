import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { QrSvg } from '@shared/ReceiptSlip';
import { api } from '@shared/api';
import { ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { placeLabel } from '@shared/pages/GuestMenu';

interface QrTable { id: string; name: string; area: string; isRoom: boolean; qrToken: string }

/** QR kod kao SVG (crni moduli, beli okvir) - oštar i pri štampi. */

/**
 * QR kodovi stolova: gost skenira kod na stolu i naručuje sa telefona (naplata ostaje konobaru).
 * Adresa u kodu mora biti dostupna telefonima gostiju (Wi-Fi lokala → IP glavne kase), ne "localhost".
 */
export function TableQr({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const tables = useLoad(() => api<QrTable[]>('GET', '/tables'), []);
  const st = useLoad(() => api<{ qrOrdering: boolean; qrBaseUrl: string; storeName: string }>('GET', '/settings/kasa'), []);
  const addrs = useLoad(() => api<{ urls: string[] }>('GET', '/qr-admin/addresses').catch(() => ({ urls: [] as string[] })), []);
  const [base, setBase] = useState('');
  const [area, setArea] = useState('');
  const [saving, setSaving] = useState(false);
  const local = /^(localhost|127\.)/.test(location.hostname);
  useEffect(() => {
    if (!st.data || !addrs.data || base) return;
    setBase(st.data.qrBaseUrl || (!local ? location.origin : addrs.data.urls[0] ?? location.origin));
  }, [st.data, addrs.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (tables.error || st.error) return <Modal title="QR kodovi stolova" onClose={onClose}><ErrorBox error={tables.error ?? st.error} /></Modal>;
  if (!tables.data || !st.data || !addrs.data) return <Modal title="QR kodovi stolova" onClose={onClose}><Spinner /></Modal>;

  const areas = [...new Set(tables.data.map((t) => t.area))];
  const list = tables.data.filter((t) => !area || t.area === area);
  const clean = base.replace(/\/+$/, '');
  const bad = !/^https?:\/\/\S+$/.test(clean) || /\/\/(localhost|127\.)/.test(clean);
  const save = async (patch: object) => {
    setSaving(true);
    try { await api('PUT', '/settings/kasa', patch); st.reload(); toast('ok', 'Sačuvano'); } catch (e: any) { toast('err', e.message); } finally { setSaving(false); }
  };
  const reset = async (t: QrTable) => {
    if (!confirm(`Novi QR kod za ${t.name}? Stari kod sa tog stola prestaje da radi - odštampajte i zamenite nalepnicu.`)) return;
    try { await api('POST', `/qr-admin/tables/${t.id}/reset`); tables.reload(); toast('ok', 'Napravljen novi kod'); } catch (e: any) { toast('err', e.message); }
  };

  return (
    <Modal title="QR kodovi stolova - gosti naručuju sa telefona" onClose={onClose} wide>
      <div className="form qr-admin">
        <label className="check">
          <input type="checkbox" checked={st.data.qrOrdering} disabled={saving} onChange={(e) => void save({ qrOrdering: e.target.checked })} />
          Naručivanje preko QR koda je uključeno (gost naručuje, porudžbina ide u šank/kuhinju i na račun stola; naplaćuje konobar)
        </label>
        <div className="grid2 tight">
          <label>Adresa u QR kodu (glavna kasa, kako je vide telefoni)
            <input className={`input ${bad ? 'invalid' : ''}`} list="qr-addrs" value={base} onChange={(e) => setBase(e.target.value)} placeholder="http://192.168.1.10:3000" />
            <datalist id="qr-addrs">{addrs.data.urls.map((u) => <option key={u} value={u} />)}</datalist>
          </label>
          <label>Prostorija<select className="input" value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">Sve</option>{areas.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
        </div>
        {bad && <p className="err-text small">Telefoni gostiju ne mogu da otvore „localhost“. Upišite IP adresu glavne kase{addrs.data.urls.length ? ` (npr. ${addrs.data.urls[0]})` : ''}.</p>}
        <p className="muted small">Gosti moraju biti na Wi-Fi mreži lokala (ista mreža kao kasa). Probajte jedan kod svojim telefonom pre štampe.</p>
        <div className="toolbar">
          <button className="btn" disabled={saving || bad || clean === st.data.qrBaseUrl} onClick={() => void save({ qrBaseUrl: clean })}>Zapamti adresu</button>
          <span className="grow-1" />
          <button className="btn primary" disabled={bad || !list.length} onClick={() => window.print()}>Štampaj QR kodove ({list.length})</button>
        </div>
        <div className="qr-grid">
          {list.map((t) => (
            <div key={t.id} className="qr-card">
              <div className="qr-store">{st.data!.storeName}</div>
              <div className="qr-table">{placeLabel(t.name, t.isRoom)}</div>
              {!bad && <QrSvg text={`${clean}/m/${t.qrToken}`} />}
              <div className="qr-hint">Skenirajte i naručite</div>
              <div className="qr-sub">plaćanje kod konobara</div>
              <button className="btn sm ghost qr-noprint" onClick={() => void reset(t)} title="Ako je kod zloupotrebljen ili nalepnica nestala">Novi kod</button>
              {!bad && <a className="qr-noprint small" href={`${clean}/m/${t.qrToken}`} target="_blank" rel="noreferrer">otvori meni</a>}
            </div>
          ))}
        </div>
      </div>
      {/* list za štampu: direktno u body, van prozora (prozor ima skrol i ne štampa se ceo) */}
      {!bad && createPortal(
        <div className="qr-print-sheet" aria-hidden>
          {list.map((t) => (
            <div key={t.id} className="qr-card">
              <div className="qr-store">{st.data!.storeName}</div>
              <div className="qr-table">{placeLabel(t.name, t.isRoom)}</div>
              <QrSvg text={`${clean}/m/${t.qrToken}`} size={200} />
              <div className="qr-hint">Skenirajte i naručite</div>
              <div className="qr-sub">plaćanje kod konobara</div>
            </div>
          ))}
        </div>, document.body)}
    </Modal>
  );
}
