import { useEffect, useMemo, useState } from 'react';
import { api, Category, fmt, Product } from '@shared/api';
import { useAuth } from '@shared/auth';
import { ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { ProductForm, TaxRate } from '@shared/pages/Products';
import { Column, DataTable } from './DataTable';
import { BulkEdit } from './BulkEdit';
import { useTab } from './tabs';

type Row = Product & { isSellable: boolean; trackStock: boolean; prepStationId: string | null; purchaseTaxRateId: string | null; minStock: string | null };
type Cost = { productId: string; cost: string; costWithVat: string };

const ACTION_LABEL: Record<string, string> = {
  'product.create': 'Kreiran', 'product.update': 'Izmenjen', 'product.price.change': 'Promena cene', 'product.image.set': 'Nova slika', 'product.image.delete': 'Slika obrisana',
};

/**
 * Pregled proizvoda (prodajni artikli i sirovine u jednoj tabeli, kao u Octopos-u):
 * klik označava red, dvoklik otvara proizvod; Kopiraj otvara novi proizvod sa istim podacima (npr. Coca-Cola → Fanta).
 */
export function AdminProducts({ autoNew }: { autoNew?: boolean } = {}) {
  const { can } = useAuth();
  const tab = useTab();
  const toast = useToast();
  const write = can('catalog.write');
  const [inactive, setInactive] = useState(false);
  const list = useLoad(() => api<{ data: Row[] }>('GET', '/products?includeInactive=true&pageSize=5000').then((r) => r.data), []);
  const cats = useLoad(() => api<(Category & { prepStationId: string | null })[]>('GET', '/categories'), []);
  const taxes = useLoad(() => api<TaxRate[]>('GET', '/tax-rates'), []);
  const stations = useLoad(() => api<{ id: string; name: string }[]>('GET', '/prep-stations').catch(() => []), []);
  const costs = useLoad(() => api<Cost[]>('GET', '/products/costs').catch(() => [] as Cost[]), []);
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: 'new' | 'edit' | 'copy'; p: Row | null } | null>(autoNew ? { mode: 'new', p: null } : null);
  const [panel, setPanel] = useState<'usedIn' | 'log' | 'bulk' | null>(null);

  const rows = useMemo(() => (list.data ?? []).filter((p) => inactive || p.active), [list.data, inactive]);
  const selected = rows.find((p) => p.id === sel) ?? null;
  useEffect(() => { if (sel && !rows.some((p) => p.id === sel)) setSel(null); }, [rows, sel]);

  if ((list.loading && !list.data) || (cats.loading && !cats.data) || (taxes.loading && !taxes.data)) return <Spinner />;
  if (list.error || cats.error || taxes.error) return <ErrorBox error={list.error ?? cats.error ?? taxes.error} onRetry={() => { list.reload(); cats.reload(); taxes.reload(); }} />;

  const cat = (id: string) => cats.data!.find((c) => c.id === id);
  const tax = (id: string | null) => taxes.data!.find((t) => t.id === id);
  const station = (p: Row) => stations.data?.find((s) => s.id === (p.prepStationId ?? cat(p.categoryId)?.prepStationId))?.name ?? '';
  const rate = (id: string | null) => { const t = tax(id); return t ? Number(t.rate).toLocaleString('sr-Latn-RS', { minimumFractionDigits: 2 }) : ''; };
  const costOf = new Map((costs.data ?? []).map((c) => [c.productId, c]));
  const margin = (p: Row) => {
    const c = costOf.get(p.id);
    return c && p.isSellable && Number(c.costWithVat) > 0 ? ((Number(p.price) - Number(c.costWithVat)) / Number(c.costWithVat)) * 100 : null;
  };
  const idx = new Map((list.data ?? []).map((p, i) => [p.id, i + 1]));
  const check = (on: boolean) => <input type="checkbox" className="dt-check" checked={on} readOnly tabIndex={-1} />;

  const columns: Column<Row>[] = [
    { key: 'id', label: 'Id', value: (p) => idx.get(p.id), align: 'right', width: 42, optional: 1 },
    { key: 'station', label: 'Kategorija', value: station, filter: 'select', width: 86, optional: 2 },
    { key: 'group', label: 'Grupa', value: (p) => cat(p.categoryId)?.name, filter: 'select', width: 110, optional: 3,
      render: (p) => <span className="dt-group" style={{ ['--c' as any]: cat(p.categoryId)?.color ?? '#64748b' }}>{cat(p.categoryId)?.name}</span> },
    { key: 'code', label: 'Šifra', value: (p) => p.code, width: 58 },
    { key: 'barcode', label: 'Barkod', value: (p) => p.barcode ?? '', width: 104, optional: 1 },
    { key: 'name', label: 'Naziv', value: (p) => p.name, render: (p) => <strong>{p.name}</strong> },
    { key: 'unit', label: 'JM', value: (p) => p.unit.toUpperCase(), filter: 'select', width: 46 },
    { key: 'tax', label: 'Izlazni PDV', value: (p) => rate(p.taxRateId), align: 'right', filter: 'select', width: 58, optional: 3 },
    { key: 'taxIn', label: 'Ulazni PDV', value: (p) => rate(p.purchaseTaxRateId ?? p.taxRateId), align: 'right', filter: 'select', width: 58, optional: 1 },
    { key: 'cost', label: 'Nab. cena sa PDV', value: (p) => (costOf.get(p.id) ? Number(costOf.get(p.id)!.costWithVat) : ''), align: 'right', width: 78, filter: false, optional: 3,
      render: (p) => (costOf.get(p.id) ? fmt(costOf.get(p.id)!.costWithVat) : '') },
    { key: 'price', label: 'Cena', value: (p) => Number(p.price), render: (p) => (p.isSellable ? fmt(p.price) : ''), align: 'right', width: 78, filter: false },
    { key: 'margin', label: 'Marža %', value: (p) => margin(p) ?? '', align: 'right', width: 64, filter: false, optional: 2,
      render: (p) => { const m = margin(p); return m === null ? '' : <span className={m < 0 ? 'qty-out' : ''}>{m.toLocaleString('sr-Latn-RS', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</span>; } },
    { key: 'stock', label: 'Zaliha', value: (p) => (p.trackStock ? 'da' : 'ne'), render: (p) => check(p.trackStock), align: 'center', filter: 'select', width: 52, optional: 3 },
    { key: 'sell', label: 'Za prodaju', value: (p) => (p.isSellable ? 'da' : 'ne'), render: (p) => check(p.isSellable), align: 'center', filter: 'select', width: 58, optional: 3 },
    { key: 'active', label: 'Aktivan', value: (p) => (p.active ? 'da' : 'ne'), render: (p) => check(p.active), align: 'center', filter: 'select', width: 54 },
  ];

  const deactivate = async () => {
    if (!selected || !window.confirm(`Obrisati (deaktivirati) "${selected.name}"? Istorija prodaje ostaje; proizvod se vraća uključivanjem "Aktivan".`)) return;
    try { await api('PATCH', `/products/${selected.id}`, { active: false }); list.reload(); toast('ok', 'Proizvod je deaktiviran'); }
    catch (e: any) { toast('err', e.message); }
  };

  return (
    <div className="page wide fill prod-page">
      <DataTable fit columns={columns} rows={rows} rowKey={(p) => p.id} selectedKey={sel} onRowClick={(p) => setSel(p.id)}
        onRowDoubleClick={write ? (p) => { setSel(p.id); setForm({ mode: 'edit', p }); } : undefined}
        rowClass={(p) => (p.active ? undefined : 'inactive')} empty="Nema proizvoda." />
      <div className="prod-bar">
        <div className="prod-bar-left">
          <button className="btn" disabled={!selected} onClick={() => setPanel('usedIn')}>Gde je u normativu</button>
          {can('audit.read') && <button className="btn" disabled={!selected} onClick={() => setPanel('log')}>Dnevnik promena</button>}
          {write && <button className="btn danger-ghost" disabled={!selected || !selected.active} onClick={deactivate}>Obriši</button>}
          <label className="check prod-inactive"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Prikaži neaktivne</label>
        </div>
        <div className="prod-bar-right">
          {write && <button className="btn" onClick={() => setPanel('bulk')} title="Poskupljenje u %, premeštanje u grupu, isključivanje više proizvoda odjednom">Grupna izmena</button>}
          <button className="btn" onClick={() => { list.reload(); costs.reload(); }}>Osveži</button>
          <button className="btn" onClick={() => window.print()}>Štampaj</button>
          {write && <button className="btn" disabled={!selected} onClick={() => selected && setForm({ mode: 'copy', p: selected })}>Kopiraj</button>}
          {write && <button className="btn" onClick={() => setForm({ mode: 'new', p: null })}>Dodaj</button>}
          {write && <button className="btn primary" disabled={!selected} onClick={() => selected && setForm({ mode: 'edit', p: selected })}>Izmeni</button>}
          <button className="btn" onClick={tab.close}>Zatvori</button>
        </div>
      </div>
      {form && (
        <ProductForm product={form.mode === 'edit' ? form.p : null} copyOf={form.mode === 'copy' ? form.p : null} categories={cats.data!} taxes={taxes.data!}
          onClose={() => setForm(null)} onImage={list.reload}
          onSaved={(c, again) => { if (!again) setForm(null); if (c) setSel(c.id); list.reload(); costs.reload(); toast('ok', form.mode === 'copy' ? 'Kopija sačuvana' : again ? `Sačuvano: ${c?.name} - unesite sledeći` : 'Proizvod sačuvan'); }} />
      )}
      {panel === 'usedIn' && selected && <UsedIn p={selected} onClose={() => setPanel(null)} />}
      {panel === 'bulk' && <BulkEdit rows={list.data ?? []} cats={cats.data!} onClose={() => setPanel(null)} onDone={() => { list.reload(); costs.reload(); toast('ok', 'Grupna izmena primenjena'); }} />}
      {panel === 'log' && selected && <ChangeLog p={selected} cats={cats.data!} onClose={() => setPanel(null)} />}
    </div>
  );
}

/** Gde je u normativu: artikli koji troše izabranu sirovinu. */
function UsedIn({ p, onClose }: { p: Row; onClose: () => void }) {
  const r = useLoad(() => api<any[]>('GET', `/products/${p.id}/used-in`), [p.id]);
  return (
    <Modal title={`Gde je u normativu: ${p.name}`} onClose={onClose} wide>
      {r.loading && !r.data ? <Spinner /> : r.error ? <ErrorBox error={r.error} /> : (
        <DataTable rows={r.data ?? []} rowKey={(x) => `${x.productId}${x.version}`} empty="Ovaj proizvod nije ni u jednom normativu." columns={[
          { key: 'code', label: 'Šifra', value: (x) => x.code, width: 80 },
          { key: 'name', label: 'Artikal', value: (x) => x.name, render: (x) => <strong>{x.name}</strong> },
          { key: 'qty', label: 'Količina', value: (x) => Number(x.quantity), render: (x) => `${Number(x.quantity).toLocaleString('sr-Latn-RS', { maximumFractionDigits: 4 })} ${x.unit}`, align: 'right' },
          { key: 'status', label: 'Normativ', value: (x) => (x.status === 'ACTIVE' ? `aktivan v${x.version}` : `nacrt v${x.version}`), filter: 'select' },
        ] as Column<any>[]} />
      )}
    </Modal>
  );
}

/** Dnevnik promena proizvoda: ko je, kada i šta menjao (revizijski trag). */
function ChangeLog({ p, cats, onClose }: { p: Row; cats: Category[]; onClose: () => void }) {
  const r = useLoad(() => api<any[]>('GET', `/audit-logs?entity=product&entityId=${p.id}`), [p.id]);
  const describe = (x: any) => {
    const d = x.data ?? {};
    if (x.action === 'product.price.change') return `${fmt(d.from)} → ${fmt(d.to)}`;
    const parts: string[] = [];
    if (d.name) parts.push(`naziv: ${d.name}`);
    if (d.price) parts.push(`cena: ${fmt(d.price)}`);
    if (d.categoryId) parts.push(`grupa: ${cats.find((c) => c.id === d.categoryId)?.name ?? '?'}`);
    if (d.active !== undefined) parts.push(d.active ? 'aktivan' : 'neaktivan');
    if (d.code) parts.push(`šifra: ${d.code}`);
    return parts.join(' · ');
  };
  return (
    <Modal title={`Dnevnik promena: ${p.name}`} onClose={onClose} wide>
      {r.loading && !r.data ? <Spinner /> : r.error ? <ErrorBox error={r.error} /> : (
        <DataTable rows={r.data ?? []} rowKey={(x) => x.id} empty="Nema zabeleženih promena." columns={[
          { key: 'at', label: 'Vreme', value: (x) => x.at, render: (x) => new Date(x.at).toLocaleString('sr-Latn-RS'), filter: false, width: 160 },
          { key: 'user', label: 'Korisnik', value: (x) => x.user ?? '', filter: 'select' },
          { key: 'action', label: 'Radnja', value: (x) => ACTION_LABEL[x.action] ?? x.action, filter: 'select' },
          { key: 'what', label: 'Promena', value: describe },
        ] as Column<any>[]} />
      )}
    </Modal>
  );
}
