import { FormEvent, useState } from 'react';
import { api, Discount } from '@shared/api';
import { Empty, ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';

/** Popusti koje kasa nudi pri naplati (procenat na ceo račun). */
export function Discounts() {
  const toast = useToast();
  const list = useLoad(() => api<Discount[]>('GET', '/discounts?includeInactive=true'), []);
  const [edit, setEdit] = useState<Discount | 'new' | null>(null);

  const toggle = async (d: Discount) => {
    try { await api('PATCH', `/discounts/${d.id}`, { active: !d.active }); list.reload(); toast('ok', d.active ? 'Popust isključen' : 'Popust uključen'); }
    catch (e: any) { toast('err', e.message); }
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>Popusti</h2>
        <button className="btn primary" onClick={() => setEdit('new')}>+ Novi popust</button>
      </div>
      <p className="muted">Aktivni popusti se pojavljuju kao dugmad na ekranu naplate na kasi (posle dugmeta „Osveži“). Popust važi na ceo račun.</p>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> :
        !list.data?.length ? <Empty>Nema definisanih popusta.</Empty> : (
          <table className="tbl clickable">
            <thead><tr><th>Naziv</th><th className="num">Procenat</th><th className="num">Redosled</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((d) => (
                <tr key={d.id} onClick={() => setEdit(d)}>
                  <td><strong>{d.name}</strong></td>
                  <td className="num">{d.percent.replace(/\.00$/, '')}%</td>
                  <td className="num">{d.sortOrder}</td>
                  <td>{d.active ? <span className="badge paid">Aktivan</span> : <span className="badge cancelled">Isključen</span>}</td>
                  <td><button className="btn sm" onClick={(e) => { e.stopPropagation(); toggle(d); }}>{d.active ? 'Isključi' : 'Uključi'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {edit && <DiscountForm discount={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); toast('ok', 'Popust sačuvan'); }} />}
    </div>
  );
}

function DiscountForm({ discount, onClose, onSaved }: { discount: Discount | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(discount?.name ?? '');
  const [percent, setPercent] = useState(discount?.percent.replace(/\.00$/, '') ?? '');
  const [sortOrder, setSortOrder] = useState(String(discount?.sortOrder ?? 0));
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const ok = /^\d{1,3}([.,]\d{1,2})?$/.test(percent) && Number(percent.replace(',', '.')) > 0 && Number(percent.replace(',', '.')) <= 100;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    const body = { name: name.trim(), percent: percent.replace(',', '.'), sortOrder: Number(sortOrder) || 0 };
    try {
      if (discount) await api('PATCH', `/discounts/${discount.id}`, body); else await api('POST', '/discounts', body);
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={discount ? `Izmena: ${discount.name}` : 'Novi popust'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Naziv (prikazuje se na kasi)<input className="input" value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} placeholder="npr. Loyalty 15%" /></label>
        <label>Procenat (%)<input className="input" inputMode="decimal" value={percent} required onChange={(e) => setPercent(e.target.value)} placeholder="npr. 10" />
          {!ok && percent !== '' && <small className="warn-text">Broj veći od 0 i najviše 100, do 2 decimale</small>}</label>
        <label>Redosled na kasi<input className="input" inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value.replace(/\D/g, ''))} /></label>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
          <button className="btn primary" disabled={busy || !ok || !name.trim()}>Sačuvaj</button>
        </div>
      </form>
    </Modal>
  );
}
