import { FormEvent, useState } from 'react';
import { api, Category, Discount, Product } from '@shared/api';
import { ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { Column, DataTable } from './DataTable';

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
        <span className="muted">Aktivni popusti su dugmad na ekranu naplate na kasi (posle „Osveži“). Popust važi na ceo račun.</span>
        <button className="btn primary" onClick={() => setEdit('new')}>+ Novi popust</button>
      </div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (
        <DataTable rows={list.data ?? []} rowKey={(d) => d.id} onRowClick={setEdit} rowClass={(d) => (d.active ? undefined : 'inactive')} empty="Nema definisanih popusta." columns={[
          { key: 'name', label: 'Naziv', value: (d) => d.name, render: (d) => <strong>{d.name}</strong> },
          { key: 'pct', label: 'Procenat', value: (d) => Number(d.percent), render: (d) => `${d.percent.replace(/\.00$/, '')}%`, align: 'right' },
          { key: 'scope', label: 'Važi za', filter: 'select',
            value: (d) => (d.scope === 'GROUP' ? `Grupe (${d.targetIds?.length ?? 0})` : d.scope === 'PRODUCT' ? `Proizvodi (${d.targetIds?.length ?? 0})` : 'Ceo račun') },
          { key: 'sort', label: 'Redosled', value: (d) => d.sortOrder, align: 'right' },
          { key: 'active', label: 'Status', value: (d) => (d.active ? 'Aktivan' : 'Isključen'), filter: 'select',
            render: (d) => (d.active ? <span className="badge paid">Aktivan</span> : <span className="badge cancelled">Isključen</span>) },
          { key: 'act', label: '', value: () => '', filter: false, align: 'right',
            render: (d) => <button className="btn sm" onClick={(e) => { e.stopPropagation(); void toggle(d); }}>{d.active ? 'Isključi' : 'Uključi'}</button> },
        ] as Column<Discount>[]} />
      )}
      {edit && <DiscountForm discount={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); toast('ok', 'Popust sačuvan'); }} />}
    </div>
  );
}

const SCOPE_LABEL = { ALL: 'Ceo račun', GROUP: 'Grupe', PRODUCT: 'Proizvodi' } as const;
type Scope = keyof typeof SCOPE_LABEL;

/** Popust: naziv, procenat i na šta se odnosi (ceo račun, izabrane grupe ili izabrani proizvodi). */
function DiscountForm({ discount, onClose, onSaved }: { discount: Discount | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(discount?.name ?? '');
  const [percent, setPercent] = useState(discount?.percent.replace(/\.00$/, '') ?? '');
  const [sortOrder, setSortOrder] = useState(String(discount?.sortOrder ?? 0));
  const [scope, setScope] = useState<Scope>(discount?.scope ?? 'ALL');
  const [targets, setTargets] = useState<string[]>(discount?.targetIds ?? []);
  const [q, setQ] = useState('');
  const cats = useLoad(() => api<Category[]>('GET', '/categories'), []);
  const prods = useLoad(() => api<{ data: Product[] }>('GET', '/products?pageSize=5000&sellable=true').then((r) => r.data), []);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const ok = /^\d{1,3}([.,]\d{1,2})?$/.test(percent) && Number(percent.replace(',', '.')) > 0 && Number(percent.replace(',', '.')) <= 100;
  const pickScope = (s: Scope) => { if (s !== scope) { setScope(s); setTargets([]); setQ(''); } };
  const toggle = (id: string) => setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const options = scope === 'GROUP'
    ? (cats.data ?? []).map((c) => ({ id: c.id, label: c.name, sub: '' }))
    : (prods.data ?? []).map((p) => ({ id: p.id, label: p.name, sub: cats.data?.find((c) => c.id === p.categoryId)?.name ?? '' }));
  const shown = options.filter((o) => !q || `${o.label} ${o.sub}`.toLowerCase().includes(q.toLowerCase()));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    const body = { name: name.trim(), percent: percent.replace(',', '.'), sortOrder: Number(sortOrder) || 0, scope, targetIds: scope === 'ALL' ? [] : targets };
    try {
      if (discount) await api('PATCH', `/discounts/${discount.id}`, body); else await api('POST', '/discounts', body);
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={discount ? `Izmena: ${discount.name}` : 'Novi popust'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="grid2 tight">
          <label>Naziv (prikazuje se na kasi)<input className="input" value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} placeholder="npr. Loyalty 15%" /></label>
          <label>Procenat (%)<input className="input" inputMode="decimal" value={percent} required onChange={(e) => setPercent(e.target.value)} placeholder="npr. 10" />
            {!ok && percent !== '' && <small className="warn-text">Broj veći od 0 i najviše 100, do 2 decimale</small>}</label>
        </div>
        <label>Popust važi za
          <div className="seg">
            {(Object.keys(SCOPE_LABEL) as Scope[]).map((s) => (
              <button key={s} type="button" className={`seg-btn ${scope === s ? 'on' : ''}`} onClick={() => pickScope(s)}>{SCOPE_LABEL[s]}</button>
            ))}
          </div>
        </label>
        {scope !== 'ALL' && (
          <div className="disc-targets">
            <div className="disc-targets-head">
              <input className="input" placeholder={scope === 'GROUP' ? 'Pretraga grupa' : 'Pretraga proizvoda'} value={q} onChange={(e) => setQ(e.target.value)} />
              <span className="muted small">Izabrano: {targets.length}</span>
              <button type="button" className="btn sm" onClick={() => setTargets([...new Set([...targets, ...shown.map((o) => o.id)])])}>Izaberi prikazane</button>
              <button type="button" className="btn sm ghost" onClick={() => setTargets([])}>Poništi</button>
            </div>
            <div className="disc-list">
              {shown.map((o) => (
                <label key={o.id} className={`disc-item ${targets.includes(o.id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={targets.includes(o.id)} onChange={() => toggle(o.id)} />
                  <span>{o.label}{o.sub && <small className="muted"> · {o.sub}</small>}</span>
                </label>
              ))}
              {shown.length === 0 && <span className="muted small">Nema rezultata.</span>}
            </div>
          </div>
        )}
        <label>Redosled na kasi<input className="input" inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value.replace(/\D/g, ''))} /></label>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
          <button className="btn primary" disabled={busy || !ok || !name.trim() || (scope !== 'ALL' && !targets.length)}>Sačuvaj</button>
        </div>
      </form>
    </Modal>
  );
}
