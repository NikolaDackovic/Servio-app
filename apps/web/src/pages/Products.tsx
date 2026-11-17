import { FormEvent, useRef, useState } from 'react';
import { api, Category, fmt, Product, productImageUrl } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorBox, Modal, Spinner, useLoad, useToast } from '../ui';

export interface TaxRate { id: string; label: string; name: string; rate: string }

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
  const [editCat, setEditCat] = useState<Category | null>(null);
  const write = can('catalog.write');

  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <div className="page">
      <div className="toolbar">
        <input className="input" placeholder="Pretraga proizvoda" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        {write && <button className="btn" onClick={() => setNewCat(true)}>+ Kategorija</button>}
        {write && <button className="btn primary" onClick={() => setEdit('new')} disabled={!cats.data?.length || !taxes.data?.length}>+ Proizvod</button>}
      </div>
      {write && !!cats.data?.length && (
        <div className="cat-chips" aria-label="Kategorije">
          <span className="muted small">Kategorije (dodir za izmenu boje i naziva):</span>
          {cats.data.map((c) => (
            <button key={c.id} className={`cat-chip ${c.active ? '' : 'off'}`} style={{ ['--c' as any]: c.color ?? '#2F7BC4' }} onClick={() => setEditCat(c)}>{c.name}</button>
          ))}
        </div>
      )}
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> :
        !list.data?.data.length ? <Empty>Nema proizvoda.</Empty> : (
          <>
            <table className="tbl clickable">
              <thead><tr><th></th><th>Šifra</th><th>Naziv</th><th>Kategorija</th><th>PDV</th><th className="num">Cena</th><th>Status</th></tr></thead>
              <tbody>
                {list.data.data.map((p) => (
                  <tr key={p.id} onClick={() => write && setEdit(p)}>
                    <td className="thumb">{productImageUrl(p) && <img src={productImageUrl(p)!} alt="" />}</td><td>{p.code}</td><td>{p.name}{(p as any).isSellable === false && <small className="muted"> · sirovina</small>}{(p as any).trackStock && <small className="muted"> · lager</small>}</td><td>{cats.data?.find((c) => c.id === p.categoryId)?.name}</td>
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
          onClose={() => setEdit(null)} onImage={list.reload} onSaved={(_c, again) => { if (!again) setEdit(null); list.reload(); toast('ok', 'Proizvod sačuvan'); }} />
      )}
      {newCat && <CategoryForm onClose={() => setNewCat(false)} onSaved={() => { setNewCat(false); cats.reload(); toast('ok', 'Kategorija dodata'); }} />}
      {editCat && <CategoryForm category={editCat} onClose={() => setEditCat(null)} onSaved={() => { setEditCat(null); cats.reload(); toast('ok', 'Kategorija sačuvana'); }} />}
    </div>
  );
}

const UNITS = ['kom', 'kg', 'l', 'g', 'ml', 'porcija'];
type NormLine = { componentId: string; quantity: string };

/**
 * Proizvod na jednom mestu: prodajni artikal ili sirovina (npr. "espresso KG").
 * Osnovno (naziv, cena, grupa, izlazni/ulazni PDV, JM), dodaci (slika, izmene na kasi), normativ:
 * sirovine sa bruto količinom (espresso KG 0,007). Zaliha se prati na sirovini; artikal bez normativa
 * a sa zalihom (npr. Coca-Cola) prati se sam.
 */
export function ProductForm({ product, copyOf, categories, taxes, onClose, onSaved, onImage, initial }: {
  product: Product | null; categories: Category[]; taxes: TaxRate[]; onClose: () => void; onImage: () => void;
  /** created = novi proizvod (posle POST); again = "Sačuvaj i novi" - forma ostaje otvorena za sledeći */
  onSaved: (created?: Product, again?: boolean) => void;
  /** početne vrednosti novog proizvoda (npr. naziv iz pretrage u dokumentu) */
  initial?: { name?: string; trackStock?: boolean };
  /** Kopiraj: novi proizvod popunjen iz postojećeg (grupa, cena, PDV, izmene, normativ); menja se naziv i šifra. */
  copyOf?: Product | null;
}) {
  // novi proizvod: poslednja grupa, PDV i JM (unos više artikala iste grupe bez ponovnog biranja)
  const lastUsed = (() => { try { return JSON.parse(localStorage.getItem('pf.last') ?? '{}'); } catch { return {}; } })();
  const p: any = product ?? copyOf ?? {
    ...(categories.some((c) => c.id === lastUsed.categoryId) ? { categoryId: lastUsed.categoryId } : {}),
    // PDV: poslednji korišćen, inače opšta stopa (najviša) - ne prva u spisku (često 0%)
    taxRateId: taxes.some((t) => t.id === lastUsed.taxRateId) ? lastUsed.taxRateId : [...taxes].sort((a, b) => Number(b.rate) - Number(a.rate))[0]?.id,
    ...(lastUsed.unit ? { unit: lastUsed.unit } : {}), ...initial,
  };
  const src = product ?? copyOf ?? null;
  const [kind, setKind] = useState<'SALE' | 'RAW'>(product && p.isSellable === false ? 'RAW' : 'SALE');
  const [f, setF] = useState({
    code: copyOf ? '' : p.code ?? '', name: p.name ?? '', price: p.price ?? '', unit: p.unit ?? 'kom',
    categoryId: p.categoryId ?? categories[0]?.id, taxRateId: p.taxRateId ?? taxes[0]?.id, purchaseTaxRateId: p.purchaseTaxRateId ?? '',
    barcode: p.barcode ?? '', active: p.active ?? true, prepStationId: p.prepStationId ?? '',
    // novi artikal: zaliha se vodi (podrazumevano); isključuje se samo za usluge i artikle bez lagera
    trackStock: p.trackStock ?? !product, minStock: p.minStock ? String(Number(p.minStock)) : '', noteOptions: (p.noteOptions ?? []) as string[],
  });
  const stations = useLoad(() => api<{ id: string; name: string; active: boolean }[]>('GET', '/prep-stations').catch(() => []), []);
  const raws = useLoad(() => api<{ data: Product[] }>('GET', '/products?pageSize=500&sellable=false').then((r) => r.data), []);
  const recipes = useLoad(() => (src ? api<any[]>('GET', `/recipes?productId=${src.id}`) : Promise.resolve([])), [src?.id]);
  const active = recipes.data?.find((r) => r.status === 'ACTIVE') ?? null;
  const [norm, setNorm] = useState<NormLine[] | null>(null);
  const lines: NormLine[] = norm ?? (active ? active.lines.map((l: any) => ({ componentId: l.componentId, quantity: String(Number(l.quantity)) })) : []);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const raw = kind === 'RAW';
  const priceOk = raw ? f.price === '' || /^\d{1,10}(\.\d{1,2})?$/.test(f.price) : /^\d{1,10}(\.\d{1,2})?$/.test(f.price);
  const linesOk = lines.every((l) => l.componentId && /^\d{1,8}(\.\d{1,4})?$/.test(l.quantity.replace(',', '.')) && Number(l.quantity.replace(',', '.')) > 0);
  const unitOf = (id: string) => raws.data?.find((r) => r.id === id)?.unit ?? '';
  const grams = (l: NormLine) => {
    const q = Number(l.quantity.replace(',', '.')); const u = unitOf(l.componentId);
    return u === 'kg' ? `${+(q * 1000).toFixed(1)} g` : u === 'l' ? `${+(q * 1000).toFixed(1)} ml` : '';
  };

  const again = useRef(false); // "Sačuvaj i novi" (ref: submit forme ide u istom potezu kao klik)
  const nameRef = useRef<HTMLInputElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const more = again.current; again.current = false;
    setBusy(true); setError(undefined);
    const body: any = {
      name: f.name.trim(), price: raw ? (f.price || '0.00') : f.price, unit: f.unit,
      categoryId: f.categoryId, taxRateId: f.taxRateId, purchaseTaxRateId: f.purchaseTaxRateId || null,
      prepStationId: f.prepStationId || null, isSellable: !raw, trackStock: raw ? true : f.trackStock,
      minStock: f.minStock ? f.minStock.replace(',', '.') : null, noteOptions: raw ? [] : f.noteOptions,
    };
    if (f.barcode) body.barcode = f.barcode;
    try {
      let id = product?.id;
      let created: Product | undefined;
      if (product) await api('PATCH', `/products/${product.id}`, { ...body, active: f.active });
      else { created = await api<Product>('POST', '/products', { ...body, ...(f.code.trim() ? { code: f.code.trim() } : {}) }); id = created.id; } // prazno = automatska šifra
      if (!product) { try { localStorage.setItem('pf.last', JSON.stringify({ categoryId: f.categoryId, taxRateId: f.taxRateId, unit: f.unit })); } catch { /* */ } }
      // Normativ: nova verzija i aktivacija samo ako je izmenjen; prazan normativ povlači aktivni.
      // kopija preuzima normativ originala i kada se ne menja
      const newNorm = norm ?? (copyOf && lines.length ? lines : null);
      if (!raw && newNorm) {
        if (newNorm.length) {
          const r = await api('POST', '/recipes', { productId: id, lines: newNorm.map((l) => ({ componentId: l.componentId, quantity: l.quantity.replace(',', '.') })) });
          await api('POST', `/recipes/${r.id}/activate`);
        } else if (active && product) await api('POST', `/recipes/${active.id}/retire`);
      }
      if (more && !product) {
        // "Sačuvaj i novi": grupa, PDV, JM i vrsta ostaju; naziv, cena, šifra i barkod se prazne
        setF({ ...f, code: '', name: '', price: '', barcode: '', minStock: '', noteOptions: [] }); setNorm(null);
        setTimeout(() => nameRef.current?.focus(), 0);
      }
      onSaved(created, more && !product);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal title={product ? `Izmena: ${product.name}` : copyOf ? `Kopija: ${copyOf.name}` : 'Novi proizvod'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="seg">
          <button type="button" className={`seg-btn ${!raw ? 'on' : ''}`} onClick={() => setKind('SALE')}>PRODAJNI ARTIKAL</button>
          <button type="button" className={`seg-btn ${raw ? 'on' : ''}`} onClick={() => setKind('RAW')}>SIROVINA</button>
        </div>
        <div className="pf-section">Osnovno</div>
        <div className="grid2 tight">
          <label>Šifra<input className="input" value={f.code} disabled={!!product} maxLength={32} placeholder="automatski (sledeći broj)" onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
          <label>Naziv{raw && <small className="muted"> (npr. espresso KG)</small>}
            <input ref={nameRef} autoFocus={!product} className="input" value={f.name} required maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          {!raw && <label>Prodajna cena (sa PDV-om)
            <input className="input" inputMode="decimal" value={f.price} required placeholder="npr. 180.00" onChange={(e) => setF({ ...f, price: e.target.value.replace(',', '.') })} />
            {!priceOk && f.price !== '' && <small className="warn-text">Iznos sa najviše 2 decimale</small>}
          </label>}
          <label>Grupa<select className="input" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Izlazni PDV (prodaja)<select className="input" value={f.taxRateId} onChange={(e) => setF({ ...f, taxRateId: e.target.value })}>
            {taxes.map((t) => <option key={t.id} value={t.id}>{t.label} - {t.name} ({t.rate}%)</option>)}</select></label>
          <label>Ulazni PDV (nabavka)<select className="input" value={f.purchaseTaxRateId} onChange={(e) => setF({ ...f, purchaseTaxRateId: e.target.value })}>
            <option value="">Isti kao izlazni</option>
            {taxes.map((t) => <option key={t.id} value={t.id}>{t.label} - {t.name} ({t.rate}%)</option>)}</select></label>
          <label>JM (jedinica mere)<select className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
            {[...new Set([...UNITS, f.unit])].map((u) => <option key={u} value={u}>{u.toUpperCase()}</option>)}</select></label>
          {(raw || f.trackStock) && <label>Minimalna zaliha ({f.unit}) <small className="muted">ispod nje crveno u Zalihama</small>
            <input className="input" inputMode="decimal" value={f.minStock} placeholder="npr. 5" onChange={(e) => setF({ ...f, minStock: e.target.value })} /></label>}
          <label>Barkod<input className="input" value={f.barcode} maxLength={32} onChange={(e) => setF({ ...f, barcode: e.target.value })} /></label>
        </div>
        {!raw && !lines.length && <label className="check"><input type="checkbox" checked={f.trackStock} onChange={(e) => setF({ ...f, trackStock: e.target.checked })} /> Prati se zaliha samog artikla (komadni, npr. Coca-Cola), bez normativa</label>}

        {!raw && (
          <>
            <div className="pf-section">Dodaci</div>
            {product && <ProductImage product={product} onChanged={onImage} />}
            <NoteOptionsField value={f.noteOptions} onChange={(noteOptions) => setF({ ...f, noteOptions })} />
            <label>Kategorija (Šank / Kuhinja)<select className="input" value={f.prepStationId} onChange={(e) => setF({ ...f, prepStationId: e.target.value })}>
              <option value="">Prema grupi</option>
              {stations.data?.filter((st) => st.active).map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}</select></label>

            <div className="pf-section">Normativ <small className="muted">sirovine i bruto količina po jednom artiklu; zaliha se prati na sirovini</small></div>
            <table className="tbl norm">
              <thead><tr><th>Sirovina</th><th className="num">Količina (bruto)</th><th>JM</th><th /><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td><select className="input" value={l.componentId} onChange={(e) => setNorm(lines.map((x, j) => (j === i ? { ...x, componentId: e.target.value } : x)))}>
                      <option value="">izaberite sirovinu…</option>
                      {raws.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></td>
                    <td><input className="input num" inputMode="decimal" value={l.quantity} placeholder="0,007" onChange={(e) => setNorm(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} /></td>
                    <td>{unitOf(l.componentId).toUpperCase()}</td>
                    <td className="muted small">{grams(l)}</td>
                    <td><button type="button" className="btn sm danger-ghost" onClick={() => setNorm(lines.filter((_, j) => j !== i))} aria-label="Ukloni">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="btn-row tight">
              <button type="button" className="btn sm" onClick={() => setNorm([...lines, { componentId: '', quantity: '' }])}>+ Sirovina</button>
              {!raws.data?.length && <small className="muted">Nema sirovina: napravite ih ovde izborom „SIROVINA“ (npr. espreso, kg).</small>}
            </div>
          </>
        )}
        {product && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aktivan</label>}
        {product && !raw && product.price !== f.price && priceOk && <div className="notice">Promena cene se beleži u istoriji cena. Već dodate stavke zadržavaju staru cenu.</div>}
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions">
          <button className="btn primary" disabled={busy || !priceOk || !linesOk}>{busy ? 'Čuvam…' : 'Sačuvaj'}</button>
          {!product && <button className="btn" disabled={busy || !priceOk || !linesOk} onClick={() => { again.current = true; }} title="Sačuvaj i odmah unesi sledeći (grupa i PDV ostaju)">Sačuvaj i novi</button>}
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
        </div>
      </form>
    </Modal>
  );
}

/** Boje dugmadi kategorija kakve se najčešće koriste na kasi (plava za hranu, crna za piće…). */
const CAT_COLORS = ['#2F7BC4', '#1D5E9E', '#17181A', '#4A4E54', '#D9443F', '#2E9D5B', '#D9861C', '#8B5A2B', '#7B3FA0', '#C9A227'];

export function CategoryForm({ category, onClose, onSaved }: { category?: Category; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(category?.name ?? '');
  const [color, setColor] = useState(category?.color ?? '#2F7BC4');
  const [sortOrder, setSortOrder] = useState(String(category?.sortOrder ?? 0));
  const [active, setActive] = useState(category?.active ?? true);
  const [forSale, setForSale] = useState((category as any)?.forSale ?? true);
  const [station, setStation] = useState<string>((category as any)?.prepStationId ?? '');
  const stations = useLoad(() => api<{ id: string; name: string; active: boolean }[]>('GET', '/prep-stations').catch(() => []), []);
  const [error, setError] = useState<unknown>();
  const again = useRef(false); // "Sačuvaj i novi" (ref: submit forme ide u istom potezu kao klik)
  const nameRef = useRef<HTMLInputElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const more = again.current; again.current = false;
    const body = { name: name.trim(), color, sortOrder: Number(sortOrder) || 0, prepStationId: station || null, forSale };
    try {
      if (category) await api('PATCH', `/categories/${category.id}`, { ...body, active });
      else await api('POST', '/categories', body);
      onSaved();
    } catch (err) { setError(err); }
  };
  return (
    <Modal title={category ? `Kategorija: ${category.name}` : 'Nova kategorija'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Naziv<input className="input" value={name} required maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <label>Boja dugmeta na kasi
          <div className="swatches">
            {CAT_COLORS.map((c) => <button type="button" key={c} className={`swatch ${color.toUpperCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} />
          </div>
        </label>
        <label>Kategorija (Šank / Kuhinja)<select className="input" value={station} onChange={(e) => setStation(e.target.value)}>
          <option value="">bez kategorije</option>{stations.data?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Redosled (manji broj = ranije)<input className="input" inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value.replace(/\D/g, ''))} /></label>
        <label className="check"><input type="checkbox" checked={forSale} onChange={(e) => setForSale(e.target.checked)} /> Za prodaju (vidi se na kasi i u QR meniju)</label>
        {!forSale && <small className="muted">Grupa sirovina / troška (npr. „Sirovine voće“: limun KG) - ne prikazuje se na kasi; sirovine se troše kroz normativ prodajnih artikala.</small>}
        {category && <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aktivna</label>}
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Odustani</button><button className="btn primary">Sačuvaj</button></div>
      </form>
    </Modal>
  );
}

/** Umanjuje sliku u pregledaču (najviše 256 px, WEBP/JPEG) pre slanja - kasa učitava male pločice. */
async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('Fajl nije slika')); i.src = url; });
    const k = Math.min(1, 256 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const webp = c.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

/** Slika artikla za pločicu na kasi. */
function ProductImage({ product, onChanged }: { product: Product; onChanged: () => void }) {
  const [imageAt, setImageAt] = useState(product.imageAt ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const src = productImageUrl({ id: product.id, imageAt });
  const pick = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError(undefined);
    try { const r = await api('PUT', `/products/${product.id}/image`, { dataUrl: await shrinkImage(file) }); setImageAt(r.imageAt); onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(undefined);
    try { await api('DELETE', `/products/${product.id}/image`); setImageAt(null); onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="img-edit">
      <div className="img-preview">{src ? <img src={src} alt="" /> : <span className="muted small">bez slike</span>}</div>
      <div className="img-actions">
        <label className="btn sm">{busy ? 'Šaljem…' : src ? 'Promeni sliku' : 'Dodaj sliku'}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {src && <button type="button" className="btn sm danger-ghost" disabled={busy} onClick={remove}>Ukloni</button>}
        <small className="muted">Prikazuje se na pločici artikla na kasi. Slika se automatski umanjuje.</small>
      </div>
      {error !== undefined && <ErrorBox error={error} />}
    </div>
  );
}

/**
 * Izmene koje kasa nudi čim se artikal otkuca (npr. "Bez leda", "Bez voća", "Bez čaše").
 * Prazno = artikal se dodaje odmah, bez prozora sa izmenama.
 */
function NoteOptionsField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    const next = [...value];
    for (const p of parts) if (p.length <= 40 && !next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next.slice(0, 24)); setText('');
  };
  return (
    <label>Izmene na kasi <small className="muted">(iskaču u velikom prozoru čim se artikal otkuca)</small>
      <div className="opt-chips">
        {value.map((o) => (
          <span key={o} className="opt-chip">{o}<button type="button" aria-label={`Ukloni ${o}`} onClick={() => onChange(value.filter((x) => x !== o))}>✕</button></span>
        ))}
        {value.length === 0 && <span className="muted small">Nema izmena - artikal se dodaje odmah.</span>}
      </div>
      <div className="opt-add">
        <input className="input" value={text} maxLength={120} placeholder="npr. Bez leda, Bez voća, Bez čaše"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="btn" disabled={!text.trim()} onClick={add}>Dodaj</button>
      </div>
    </label>
  );
}
