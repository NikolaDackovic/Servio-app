import { useState } from 'react';
import { api } from '@shared/api';
import { Empty, ErrorBox, Spinner, useLoad, useToast } from '@shared/ui';
import { fq, PickProduct, ProductPicker } from './stockShared';
import { Column, DataTable } from './DataTable';

interface RecipeLine { componentId: string; componentName: string; componentCode: string; unit: string; quantity: string }
interface Recipe { id: string; productId: string; productName: string; productCode: string; version: number; status: 'DRAFT' | 'ACTIVE' | 'RETIRED'; note: string | null; createdBy: string; createdAt: string; activatedAt: string | null; retiredAt: string | null; lines: RecipeLine[] }
const STATUS: Record<Recipe['status'], string> = { DRAFT: 'Nacrt', ACTIVE: 'Aktivan', RETIRED: 'Povučen' };

/** Normativi: šta se troši sa lagera za 1 prodat artikal. Verzije; aktivna se ne menja. */
export function Recipes() {
  const all = useLoad(() => api<Recipe[]>('GET', '/recipes'), []);
  const [product, setProduct] = useState<{ id: string; label: string } | null>(null);
  if (product) return <ProductRecipes product={product} onBack={() => { setProduct(null); all.reload(); }} />;
  const byProduct = new Map<string, Recipe[]>();
  for (const r of all.data ?? []) byProduct.set(r.productId, [...(byProduct.get(r.productId) ?? []), r]);
  return (
    <div className="page">
      <p className="muted">Normativ određuje šta se automatski skida sa lagera kada se artikal naplati (npr. Espresso → 0,008 espresso KG). Artikal bez normativa troši sam sebe ako se prati zaliha; inače se ništa ne troši.</p>
      <div className="toolbar">
        <div style={{ flex: 1, minWidth: 280 }}>
          <ProductPicker filter="sellable=true" placeholder="Novi normativ - artikal za prodaju: šifra ili naziv…" onPick={(p: PickProduct) => setProduct({ id: p.id, label: `${p.code} ${p.name}` })} />
        </div>
      </div>
      {all.error ? <ErrorBox error={all.error} onRetry={all.reload} /> : !all.data ? <Spinner /> : (
        <DataTable rows={[...byProduct.values()]} rowKey={(l) => l[0].productId} empty="Nema normativa."
          onRowClick={(l) => setProduct({ id: l[0].productId, label: `${l[0].productCode} ${l[0].productName}` })} columns={[
            { key: 'code', label: 'Šifra', value: (l) => l[0].productCode, width: 90 },
            { key: 'name', label: 'Artikal', value: (l) => l[0].productName, render: (l) => <strong>{l[0].productName}</strong> },
            { key: 'ver', label: 'Aktivna verzija', value: (l) => { const a = l.find((r) => r.status === 'ACTIVE'); return a ? `v${a.version}` : 'nema aktivne'; }, filter: 'select',
              render: (l) => { const a = l.find((r) => r.status === 'ACTIVE'); return a ? `v${a.version}` : <span className="warn-text">nema aktivne</span>; } },
            { key: 'lines', label: 'Sastav (za 1 kom)', value: (l) => l.find((r) => r.status === 'ACTIVE')?.lines.map((x) => `${fq(x.quantity)} ${x.unit} ${x.componentName}`).join(' + ') ?? '' },
            { key: 'drafts', label: 'Nacrti', value: (l) => l.filter((r) => r.status === 'DRAFT').length || '', align: 'right' },
          ] as Column<Recipe[]>[]} />
      )}
    </div>
  );
}

function ProductRecipes({ product, onBack }: { product: { id: string; label: string }; onBack: () => void }) {
  const toast = useToast();
  const list = useLoad(() => api<Recipe[]>('GET', `/recipes?productId=${product.id}`), [product.id]);
  const [edit, setEdit] = useState<{ id: string | null; lines: { componentId: string; label: string; unit: string; quantity: string }[]; note: string } | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true); setError(undefined);
    try { await fn(); list.reload(); toast('ok', msg); return true; } catch (e) { setError(e); return false; } finally { setBusy(false); }
  };
  const startNew = (from?: Recipe) => setEdit({ id: null, note: '', lines: from?.lines.map((l) => ({ componentId: l.componentId, label: `${l.componentCode} ${l.componentName}`, unit: l.unit, quantity: l.quantity.replace(/\.?0+$/, '') })) ?? [] });
  const saveEdit = async () => {
    if (!edit) return;
    const body = { lines: edit.lines.map((l) => ({ componentId: l.componentId, quantity: l.quantity.replace(',', '.') })), note: edit.note || undefined };
    const ok = await act(() => (edit.id ? api('PUT', `/recipes/${edit.id}`, body) : api('POST', '/recipes', { productId: product.id, ...body })), 'Nacrt normativa sačuvan');
    if (ok) setEdit(null);
  };
  return (
    <div className="page">
      <div className="toolbar">
        <button className="btn" onClick={onBack}>← Normativi</button>
        <h2 style={{ margin: 0, flex: 1 }}>Normativ: {product.label}</h2>
        {!edit && <button className="btn primary" onClick={() => startNew(list.data?.find((r) => r.status === 'ACTIVE'))}>+ Nova verzija</button>}
      </div>
      {error !== undefined && <ErrorBox error={error} />}
      {edit && (
        <div className="card visible">
          <h3 style={{ marginTop: 0 }}>{edit.id ? 'Izmena nacrta' : 'Nova verzija (nacrt)'}</h3>
          <p className="muted small">Količine su za 1 jedinicu prodatog artikla, u jedinici mere komponente (npr. 0,008 kg). Komponenta mora imati vođenje zalihe.</p>
          <table className="tbl">
            <thead><tr><th>Komponenta</th><th className="num">Količina</th><th>JM</th><th /></tr></thead>
            <tbody>{edit.lines.map((l, i) => (
              <tr key={l.componentId}><td>{l.label}</td>
                <td className="num"><input className="input num" style={{ maxWidth: 120 }} inputMode="decimal" value={l.quantity}
                  onChange={(e) => setEdit({ ...edit, lines: edit.lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} /></td>
                <td>{l.unit}</td>
                <td><button className="btn sm danger-ghost" onClick={() => setEdit({ ...edit, lines: edit.lines.filter((_, j) => j !== i) })}>Ukloni</button></td></tr>))}
            </tbody>
          </table>
          <ProductPicker exclude={[product.id, ...edit.lines.map((l) => l.componentId)]} placeholder="Dodaj komponentu (artikal sa zalihom)…"
            onPick={(p) => setEdit({ ...edit, lines: [...edit.lines, { componentId: p.id, label: `${p.code} ${p.name}`, unit: p.unit, quantity: '' }] })} />
          <label className="form" style={{ marginTop: 8 }}>Napomena<input className="input" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} maxLength={300} /></label>
          <div className="modal-actions">
            <button className="btn" onClick={() => setEdit(null)}>Otkaži</button>
            <button className="btn primary" disabled={busy || !edit.lines.length || edit.lines.some((l) => !/^\d{1,11}([.,]\d{1,4})?$/.test(l.quantity) || Number(l.quantity.replace(',', '.')) <= 0)} onClick={saveEdit}>Sačuvaj nacrt</button>
          </div>
        </div>
      )}
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Spinner /> : !list.data.length ? <Empty>Artikal nema normativ. Dodajte „Novu verziju“.</Empty> : (
        list.data.map((r) => (
          <div key={r.id} className="card">
            <div className="row">
              <strong>v{r.version} · <span className={`badge ${r.status === 'ACTIVE' ? 'paid' : r.status === 'RETIRED' ? 'cancelled' : ''}`}>{STATUS[r.status]}</span></strong>
              <span className="muted small">{r.createdBy} · {new Date(r.createdAt).toLocaleString('sr-Latn-RS')}{r.activatedAt ? ` · aktiviran ${new Date(r.activatedAt).toLocaleString('sr-Latn-RS')}` : ''}{r.retiredAt ? ` · povučen ${new Date(r.retiredAt).toLocaleString('sr-Latn-RS')}` : ''}</span>
            </div>
            {r.note && <div className="muted small">{r.note}</div>}
            <ul>{r.lines.map((l) => <li key={l.componentId}>{fq(l.quantity)} {l.unit} - <code>{l.componentCode}</code> {l.componentName}</li>)}</ul>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              {r.status === 'DRAFT' && <button className="btn" onClick={() => setEdit({ id: r.id, note: r.note ?? '', lines: r.lines.map((l) => ({ componentId: l.componentId, label: `${l.componentCode} ${l.componentName}`, unit: l.unit, quantity: l.quantity.replace(/\.?0+$/, '') })) })}>Izmeni</button>}
              {r.status === 'DRAFT' && <button className="btn primary" disabled={busy} onClick={() => confirm(`Aktivirati v${r.version}? Prethodna aktivna verzija se povlači; od sada se troši po ovoj verziji.`) && act(() => api('POST', `/recipes/${r.id}/activate`, {}), `Verzija ${r.version} je aktivna`)}>Aktiviraj</button>}
              {r.status === 'ACTIVE' && <button className="btn danger-ghost" disabled={busy} onClick={() => confirm('Povući normativ? Artikal posle toga ne troši komponente.') && act(() => api('POST', `/recipes/${r.id}/retire`, {}), 'Normativ povučen')}>Povuci</button>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
