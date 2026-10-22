import { FormEvent, useState } from 'react';
import { api, Category, fmt, Product } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorBox, Modal, Spinner, useLoad, useToast } from '../ui';

interface TaxRate { id: string; label: string; name: string; rate: string }

export function Products() {
  const { can } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const cats = useLoad(() => api<Category[]>('GET', '/categories'), []);
  const taxes = useLoad(() => api<TaxRate[]>('GET', '/tax-rates'), []);
  const list = useLoad(() => api<{ data: Product[]; total: number; pageSize: number }>('GET',
    `/products?includeInactive=true&page=${page}&pageSize=25${search ? `&search=${encodeURIComponent(search)}` : ''}`), [page, search]);
  const [edit, setEdit] = useState<Product | 'new' | null>(null);
  const [newCat, setNewCat] = useState(false);
  const write = can('catalog.write');

  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <div className="page">
      <div className="toolbar">
        <input className="input" placeholder="Pretraga proizvoda" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        {write && <button className="btn" onClick={() => setNewCat(true)}>+ Kategorija</button>}
        {write && <button className="btn primary" onClick={() => setEdit('new')} disabled={!cats.data?.length || !taxes.data?.length}>+ Proizvod</button>}
      </div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> :
        !list.data?.data.length ? <Empty>Nema proizvoda.</Empty> : (
          <>
            <table className="tbl clickable">
              <thead><tr><th>Šifra</th><th>Naziv</th><th>Kategorija</th><th>PDV</th><th className="num">Cena</th><th>Status</th></tr></thead>
              <tbody>
                {list.data.data.map((p) => (
                  <tr key={p.id} onClick={() => write && setEdit(p)}>
                    <td>{p.code}</td><td>{p.name}</td><td>{cats.data?.find((c) => c.id === p.categoryId)?.name}</td>
                    <td>{p.taxLabel}</td><td className="num">{fmt(p.price)}</td>
                    <td>{p.active ? <span className="badge paid">Aktivan</span> : <span className="badge cancelled">Neaktivan</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
              <span>{page} / {pages} · ukupno {list.data.total}</span>
              <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>›</button>
            </div>
          </>
        )}
      {edit && cats.data && taxes.data && (
        <ProductForm product={edit === 'new' ? null : edit} categories={cats.data} taxes={taxes.data}
          onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); toast('ok', 'Proizvod sačuvan'); }} />
      )}
      {newCat && <CategoryForm onClose={() => setNewCat(false)} onSaved={() => { setNewCat(false); cats.reload(); toast('ok', 'Kategorija dodata'); }} />}
    </div>
  );
}

function ProductForm({ product, categories, taxes, onClose, onSaved }: {
  product: Product | null; categories: Category[]; taxes: TaxRate[]; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    code: product?.code ?? '', name: product?.name ?? '', price: product?.price ?? '',
    categoryId: product?.categoryId ?? categories[0]?.id, taxRateId: product?.taxRateId ?? taxes[0]?.id,
    barcode: product?.barcode ?? '', active: product?.active ?? true,
  });
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const priceOk = /^\d{1,10}(\.\d{1,2})?$/.test(f.price);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    const body: any = { name: f.name.trim(), price: f.price, categoryId: f.categoryId, taxRateId: f.taxRateId };
    if (f.barcode) body.barcode = f.barcode;
    try {
      if (product) await api('PATCH', `/products/${product.id}`, { ...body, active: f.active });
      else await api('POST', '/products', { ...body, code: f.code.trim() });
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal title={product ? `Izmena: ${product.name}` : 'Novi proizvod'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Šifra<input className="input" value={f.code} disabled={!!product} required maxLength={32} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
        <label>Naziv<input className="input" value={f.name} required maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Prodajna cena (sa PDV-om)
          <input className="input" inputMode="decimal" value={f.price} required placeholder="npr. 180.00" onChange={(e) => setF({ ...f, price: e.target.value.replace(',', '.') })} />
          {!priceOk && f.price !== '' && <small className="warn-text">Unesite iznos sa najviše 2 decimale</small>}
        </label>
        <label>Kategorija<select className="input" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Poreska stopa<select className="input" value={f.taxRateId} onChange={(e) => setF({ ...f, taxRateId: e.target.value })}>
          {taxes.map((t) => <option key={t.id} value={t.id}>{t.label} – {t.name} ({t.rate}%)</option>)}</select></label>
        <label>Barkod<input className="input" value={f.barcode} maxLength={32} onChange={(e) => setF({ ...f, barcode: e.target.value })} /></label>
        {product && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aktivan</label>}
        {product && product.price !== f.price && priceOk && <div className="notice">Promena cene se beleži u istoriji cena. Već dodate stavke zadržavaju staru cenu.</div>}
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
          <button className="btn primary" disabled={busy || !priceOk}>{busy ? 'Čuvam…' : 'Sačuvaj'}</button>
        </div>
      </form>
    </Modal>
  );
}

function CategoryForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2E86AB');
  const [error, setError] = useState<unknown>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await api('POST', '/categories', { name: name.trim(), color }); onSaved(); } catch (err) { setError(err); }
  };
  return (
    <Modal title="Nova kategorija" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Naziv<input className="input" value={name} required maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <label>Boja dugmeta<input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} /></label>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Odustani</button><button className="btn primary">Sačuvaj</button></div>
      </form>
    </Modal>
  );
}
