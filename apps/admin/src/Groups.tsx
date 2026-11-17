import { useState } from 'react';
import { api, Category } from '@shared/api';
import { ErrorBox, Spinner, useLoad, useToast } from '@shared/ui';
import { CategoryForm } from '@shared/pages/Products';
import { ExcelBar } from './Users';
import { Column, DataTable } from './DataTable';

type Group = Category & { prepStationId?: string | null };

/** Grupe: grupe na kasi (dugmad u boji), u kojima se nalaze proizvodi. */
export function Groups() {
  const cats = useLoad(() => api<Group[]>('GET', '/categories'), []);
  const prods = useLoad(() => api<{ data: { categoryId: string }[] }>('GET', '/products?pageSize=5000&includeInactive=true').then((r) => r.data), []);
  const stations = useLoad(() => api<{ id: string; name: string }[]>('GET', '/prep-stations').catch(() => []), []);
  const [edit, setEdit] = useState<Category | 'new' | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  /** redosled dugmadi na kasi: zamena sa susednom grupom, pa svi redom 10, 20, 30… (čuva se samo ono što se promenilo) */
  const move = async (c: Group, d: -1 | 1) => {
    const l = [...cats.data!]; const i = l.findIndex((x) => x.id === c.id); const j = i + d;
    if (j < 0 || j >= l.length || busy) return;
    [l[i], l[j]] = [l[j], l[i]];
    setBusy(true);
    try {
      for (const [k, x] of l.entries()) if (x.sortOrder !== (k + 1) * 10) await api('PATCH', `/categories/${x.id}`, { sortOrder: (k + 1) * 10 });
      cats.reload(); toast('ok', 'Redosled sačuvan - kase ga vide posle Osveži');
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  if (cats.loading && !cats.data) return <Spinner />;
  if (cats.error) return <ErrorBox error={cats.error} onRetry={cats.reload} />;
  const count = new Map<string, number>();
  for (const p of prods.data ?? []) count.set(p.categoryId, (count.get(p.categoryId) ?? 0) + 1);
  const columns: Column<Group>[] = [
    { key: 'name', label: 'Grupa', value: (c) => c.name, render: (c) => <strong>{c.name}</strong> },
    { key: 'color', label: 'Boja na kasi', value: (c) => c.color ?? '', filter: false,
      render: (c) => <span className="cat-chip" style={{ ['--c' as any]: c.color ?? '#2F7BC4' }}>{c.name}</span> },
    { key: 'sort', label: 'Redosled na kasi', value: (c) => c.sortOrder, align: 'center', filter: false, width: 120,
      render: (c) => <span className="ord" onClick={(e) => e.stopPropagation()}><button className="btn sm" disabled={busy} onClick={() => void move(c, -1)} aria-label="Gore">▲</button> <button className="btn sm" disabled={busy} onClick={() => void move(c, 1)} aria-label="Dole">▼</button></span> },
    { key: 'station', label: 'Kategorija', value: (c) => stations.data?.find((s) => s.id === c.prepStationId)?.name ?? '', filter: 'select' },
    { key: 'sale', label: 'Za prodaju', value: (c) => ((c as any).forSale === false ? 'ne (sirovine)' : 'da'), filter: 'select' },
    { key: 'count', label: 'Proizvoda', value: (c) => count.get(c.id) ?? 0, align: 'right' },
    { key: 'active', label: 'Status', value: (c) => (c.active ? 'Aktivna' : 'Neaktivna'), filter: 'select',
      render: (c) => (c.active ? <span className="badge paid">Aktivna</span> : <span className="badge cancelled">Neaktivna</span>) },
  ];
  return (
    <div className="page">
      <div className="toolbar"><span className="muted">Grupe za prodaju su dugmad na kasi; grupe sirovina (nisu za prodaju) služe za lager i normative.</span><button className="btn primary" onClick={() => setEdit('new')}>+ Grupa</button></div>
      <ExcelBar exportPath="/categories/export" fileBase="grupe" importPath="/categories/import" onImported={cats.reload} />
      <DataTable columns={columns} rows={cats.data!} rowKey={(c) => c.id} onRowClick={setEdit} rowClass={(c) => (c.active ? undefined : 'inactive')} empty="Nema grupa." />
      {edit && <CategoryForm category={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); cats.reload(); }} />}
    </div>
  );
}
