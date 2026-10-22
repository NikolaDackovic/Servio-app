import { FormEvent, useState } from 'react';
import { api } from '@shared/api';
import { Empty, ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { Partner } from './stockShared';

const KIND: Record<Partner['kind'], string> = { SUPPLIER: 'Dobavljač', CUSTOMER: 'Kupac', BOTH: 'Dobavljač i kupac' };

export function Partners() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [inactive, setInactive] = useState(false);
  const list = useLoad(() => api<Partner[]>('GET', `/partners?includeInactive=${inactive}${search ? `&search=${encodeURIComponent(search)}` : ''}`), [search, inactive]);
  const [edit, setEdit] = useState<Partner | 'new' | null>(null);
  return (
    <div className="page">
      <div className="toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>Partneri</h2>
        <button className="btn primary" onClick={() => setEdit('new')}>+ Novi partner</button>
      </div>
      <div className="toolbar">
        <input className="input" placeholder="Pretraga: naziv, PIB, mesto" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="check row" style={{ alignItems: 'center' }}><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> i neaktivni</label>
      </div>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Spinner /> : !list.data.length ? <Empty>Nema partnera.</Empty> : (
        <table className="tbl clickable">
          <thead><tr><th>Naziv</th><th>PIB</th><th>Matični broj</th><th>Mesto</th><th>Vrsta</th><th>Kontakt</th><th>Status</th></tr></thead>
          <tbody>{list.data.map((p) => (
            <tr key={p.id} onClick={() => setEdit(p)}>
              <td><strong>{p.name}</strong></td><td>{p.taxId ?? '—'}</td><td>{p.registrationNo ?? '—'}</td><td>{p.city ?? ''}</td>
              <td>{KIND[p.kind]}</td><td className="small">{[p.phone, p.email].filter(Boolean).join(' · ')}</td>
              <td>{p.active ? <span className="badge paid">Aktivan</span> : <span className="badge cancelled">Neaktivan</span>}</td>
            </tr>))}
          </tbody>
        </table>
      )}
      {edit && <PartnerForm partner={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); toast('ok', 'Partner sačuvan'); }} />}
    </div>
  );
}

function PartnerForm({ partner, onClose, onSaved }: { partner: Partner | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: partner?.name ?? '', kind: partner?.kind ?? 'SUPPLIER', taxId: partner?.taxId ?? '', registrationNo: partner?.registrationNo ?? '',
    address: partner?.address ?? '', city: partner?.city ?? '', email: partner?.email ?? '', phone: partner?.phone ?? '', active: partner?.active ?? true,
  });
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    const n = (s: string) => (s.trim() ? s.trim() : null);
    const body: any = { name: f.name.trim(), kind: f.kind, taxId: n(f.taxId), registrationNo: n(f.registrationNo), address: n(f.address), city: n(f.city), email: n(f.email), phone: n(f.phone) };
    try {
      if (partner) await api('PATCH', `/partners/${partner.id}`, { ...body, active: f.active }); else await api('POST', '/partners', body);
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={partner ? partner.name : 'Novi partner'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Naziv<input className="input" value={f.name} onChange={set('name')} required maxLength={160} /></label>
        <div className="grid2">
          <label>PIB<input className="input" inputMode="numeric" value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value.replace(/\D/g, '').slice(0, 9) })} placeholder="9 cifara" /></label>
          <label>Matični broj<input className="input" inputMode="numeric" value={f.registrationNo} onChange={(e) => setF({ ...f, registrationNo: e.target.value.replace(/\D/g, '').slice(0, 8) })} placeholder="8 cifara" /></label>
        </div>
        <label>Vrsta<select className="input" value={f.kind} onChange={set('kind')}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <div className="grid2">
          <label>Adresa<input className="input" value={f.address} onChange={set('address')} /></label>
          <label>Mesto<input className="input" value={f.city} onChange={set('city')} /></label>
        </div>
        <div className="grid2">
          <label>Email<input className="input" type="email" value={f.email} onChange={set('email')} /></label>
          <label>Telefon<input className="input" value={f.phone} onChange={set('phone')} /></label>
        </div>
        {partner && <label className="check"><input type="checkbox" checked={f.active} onChange={set('active')} /> Aktivan</label>}
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Otkaži</button><button className="btn primary" disabled={busy || !f.name.trim()}>Sačuvaj</button></div>
      </form>
    </Modal>
  );
}
