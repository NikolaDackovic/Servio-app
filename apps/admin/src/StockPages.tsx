import { FormEvent, useMemo, useState } from 'react';
import { api, Category } from '@shared/api';
import { ErrorBox, Spinner, useLoad, useToast } from '@shared/ui';
import { download, Warehouse } from './stockShared';
import { Column, DataTable } from './DataTable';
import { n2, n4 } from './dayRange';
import { useTab } from './tabs';
import { GroupFilter } from './GroupTree';

interface BalanceRow { warehouseId: string; warehouseName: string; productId: string; code: string; name: string; unit: string; quantity: string; avgCost: string; value: string; negative: boolean }
interface P { id: string; categoryId: string; barcode: string | null; price: string; taxRateId: string; prepStationId: string | null; isSellable: boolean }
interface Row { key: string; productId: string; station: string; group: string; groupId: string; code: string; barcode: string; name: string; unit: string; wh: string;
  rate: number; qty: number; costNet: number; costGross: number; valNet: number; valGross: number; saleNet: number; saleGross: number; saleValNet: number; saleValGross: number; negative: boolean }

/**
 * Trenutno stanje robe (kao u Octopos-u): gore levo stablo kategorija i grupa sa kućicama, tabela sa nabavnom i prodajnom
 * cenom i vrednošću (bez i sa PDV-om), u dnu UKUPNO. Dvoklik otvara karticu proizvoda.
 */
export function Balances({ onCard }: { onCard: (productId: string, warehouseId: string) => void }) {
  const toast = useToast();
  const tab = useTab();
  const whs = useLoad(() => api<Warehouse[]>('GET', '/warehouses'), []);
  const [wh, setWh] = useState('');
  const list = useLoad(() => api<{ data: BalanceRow[]; totalValue: string }>('GET', `/stock/balances?nonZero=false${wh ? `&warehouseId=${wh}` : ''}`), [wh]);
  const prods = useLoad(() => api<{ data: P[] }>('GET', '/products?pageSize=5000&includeInactive=true').then((r) => new Map(r.data.map((p) => [p.id, p]))), []);
  const cats = useLoad(() => api<(Category & { prepStationId: string | null })[]>('GET', '/categories'), []);
  const taxes = useLoad(() => api<{ id: string; rate: string }[]>('GET', '/tax-rates'), []);
  const stations = useLoad(() => api<{ id: string; name: string }[]>('GET', '/prep-stations').catch(() => []), []);
  const [checked, setChecked] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    if (!list.data || !prods.data || !cats.data || !taxes.data) return [];
    return list.data.data.map((b) => {
      const p = prods.data!.get(b.productId);
      const c = cats.data!.find((x) => x.id === p?.categoryId);
      const st = stations.data?.find((s) => s.id === (p?.prepStationId ?? c?.prepStationId))?.name ?? '';
      const rate = Number(taxes.data!.find((t) => t.id === p?.taxRateId)?.rate ?? 0);
      const k = 1 + rate / 100, qty = Number(b.quantity), cost = Number(b.avgCost);
      const saleGross = p?.isSellable ? Number(p.price) : 0, saleNet = saleGross / k;
      return {
        key: b.warehouseId + b.productId, productId: b.productId, station: st, group: c?.name ?? '', groupId: c?.id ?? '', code: b.code, barcode: p?.barcode ?? '', name: b.name, unit: b.unit.toUpperCase(), wh: b.warehouseName,
        rate, qty, costNet: cost, costGross: cost * k, valNet: qty * cost, valGross: qty * cost * k, saleNet, saleGross, saleValNet: qty * saleNet, saleValGross: qty * saleGross, negative: b.negative,
      };
    });
  }, [list.data, prods.data, cats.data, taxes.data, stations.data]);

  const shown = checked.length ? rows.filter((r) => checked.includes(r.groupId)) : rows;
  const exp = (format: string) => download(`/export/stock-balances?format=${format}${wh ? `&warehouseId=${wh}` : ''}`).catch((e) => toast('err', e.message));
  const q = (v: number) => (v ? n4(v) : '');
  const m = (v: number) => (v ? n2(v) : '');
  const sum = (rs: Row[], k: keyof Row) => rs.reduce((a, r) => a + (r[k] as number), 0);

  const columns: Column<Row>[] = [
    ...(wh ? [] : [{ key: 'wh', label: 'Magacin', value: (r: Row) => r.wh, filter: 'select', width: 90, optional: 1 } as Column<Row>]),
    { key: 'station', label: 'Kategorija', value: (r) => r.station, filter: 'select', width: 90, optional: 3 },
    { key: 'group', label: 'Grupa', value: (r) => r.group, filter: 'select', width: 100 },
    { key: 'code', label: 'Šifra', value: (r) => r.code, width: 60 },
    { key: 'barcode', label: 'Barkod', value: (r) => r.barcode, width: 100, optional: 1 },
    { key: 'name', label: 'Proizvod', value: (r) => r.name, render: (r) => <b>{r.name}</b> },
    { key: 'unit', label: 'JM', value: (r) => r.unit, filter: 'select', width: 46 },
    { key: 'rate', label: 'PDV', value: (r) => r.rate, render: (r) => n2(r.rate), align: 'right', filter: false, width: 50 },
    { key: 'qty', label: 'Količina', value: (r) => r.qty, render: (r) => <b className={r.qty < 0 ? 'qty-out' : ''}>{q(r.qty)}</b>, align: 'right', filter: false, width: 80 },
    { key: 'costNet', label: 'Nab. cena bez PDV', value: (r) => r.costNet, render: (r) => m(r.costNet), align: 'right', filter: false, width: 82, optional: 3 },
    { key: 'costGross', label: 'Nab. cena sa PDV', value: (r) => r.costGross, render: (r) => m(r.costGross), align: 'right', filter: false, width: 82, optional: 2 },
    { key: 'valNet', label: 'Nabavna vrednost bez PDV', value: (r) => r.valNet, render: (r) => m(r.valNet), align: 'right', filter: false, width: 82, optional: 3 },
    { key: 'valGross', label: 'Nabavna vrednost sa PDV', value: (r) => r.valGross, render: (r) => m(r.valGross), align: 'right', filter: false, width: 82, optional: 3 },
    { key: 'saleNet', label: 'Prod. cena bez PDV', value: (r) => r.saleNet, render: (r) => m(r.saleNet), align: 'right', filter: false, width: 82, optional: 2 },
    { key: 'saleGross', label: 'Prod. cena sa PDV', value: (r) => r.saleGross, render: (r) => m(r.saleGross), align: 'right', filter: false, width: 82, optional: 3 },
    { key: 'saleValNet', label: 'Prod. vrednost bez PDV', value: (r) => r.saleValNet, render: (r) => m(r.saleValNet), align: 'right', filter: false, width: 82, optional: 2 },
    { key: 'saleValGross', label: 'Prod. vrednost sa PDV', value: (r) => r.saleValGross, render: (r) => m(r.saleValGross), align: 'right', filter: false, width: 82, optional: 3 },
  ];
  const loading = !list.data || !prods.data || !cats.data || !taxes.data;
  const err = list.error ?? prods.error ?? cats.error ?? taxes.error;

  return (
    <div className="page wide fill">
      <div className="filters-row">
        <GroupFilter value={checked} onChange={setChecked} only={[...new Set(rows.map((r) => r.groupId))]} />
        <label className="inline">Magacin
          <select className="input" value={wh} onChange={(e) => setWh(e.target.value)}>
            <option value="">Svi magacini</option>
            {whs.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <small className="muted">Stanje u {new Date().toLocaleString('sr-Latn-RS')}. Dvoklik otvara karticu proizvoda.</small>
      </div>
      {err ? <ErrorBox error={err} onRetry={list.reload} /> : loading ? <Spinner /> : (
        <DataTable fit columns={columns} rows={shown} rowKey={(r) => r.key} selectedKey={sel} onRowClick={(r) => setSel(r.key)}
          onRowDoubleClick={(r) => onCard(r.productId, '')} rowClass={(r) => (r.negative ? 'row-neg' : undefined)} initialSort={{ key: 'station', dir: 1 }}
          empty="Nema artikala sa vođenjem zalihe. Uključite praćenje zalihe na proizvodu."
          totals={(rs) => ({ group: `UKUPNO (${rs.length})`, qty: <b>{n4(sum(rs, 'qty'))}</b>, valNet: <b>{n2(sum(rs, 'valNet'))}</b>, valGross: <b>{n2(sum(rs, 'valGross'))}</b>, saleValNet: <b>{n2(sum(rs, 'saleValNet'))}</b>, saleValGross: <b>{n2(sum(rs, 'saleValGross'))}</b> })} />
      )}
      <div className="bar">
        <div className="bar-left">
          <button className="btn" onClick={() => window.print()}>Štampaj</button>
          <button className="btn" onClick={() => exp('xlsx')}>Izvoz XLSX</button>
          <button className="btn" onClick={() => exp('csv')}>Izvoz CSV</button>
        </div>
        <div className="bar-right">
          <button className="btn" onClick={() => { list.reload(); prods.reload(); }}>Osveži</button>
          <button className="btn" disabled={!sel} onClick={() => { const r = rows.find((x) => x.key === sel); if (r) onCard(r.productId, ''); }}>Kartica proizvoda</button>
          <button className="btn" onClick={tab.close}>Zatvori</button>
        </div>
      </div>
    </div>
  );
}

/** Magacini (skladišta) i odakle prodaja troši robu. */
export function WarehousesPage() {
  const toast = useToast();
  const whs = useLoad(() => api<Warehouse[]>('GET', '/warehouses'), []);
  const stations = useLoad(() => api<{ id: string; name: string; warehouseId: string | null }[]>('GET', '/prep-stations'), []);
  const [name, setName] = useState('');
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); whs.reload(); stations.reload(); toast('ok', msg); } catch (e: any) { toast('err', e.message); }
  };
  const add = (e: FormEvent) => { e.preventDefault(); act(() => api('POST', '/warehouses', { name: name.trim() }), 'Magacin dodat').then(() => setName('')); };
  return (
    <div className="page narrow">
      <p className="muted small">Prodaja troši iz magacina pripremne pozicije stavke (npr. Šank → magacin Šank); ako pozicija nema magacin - iz podrazumevanog.</p>
      {whs.data && (
        <table className="tbl grid">
          <thead><tr><th>Magacin</th><th>Podrazumevani</th><th>Status</th><th /></tr></thead>
          <tbody>{whs.data.map((w) => (
            <tr key={w.id}>
              <td><b>{w.name}</b></td><td>{w.isDefault ? '✓' : <button className="btn sm" onClick={() => act(() => api('PATCH', `/warehouses/${w.id}`, { isDefault: true }), 'Podrazumevani magacin promenjen')}>Postavi</button>}</td>
              <td>{w.active ? 'aktivan' : 'neaktivan'}</td>
              <td>{!w.isDefault && <button className="btn sm" onClick={() => act(() => api('PATCH', `/warehouses/${w.id}`, { active: !w.active }), 'Sačuvano')}>{w.active ? 'Isključi' : 'Uključi'}</button>}</td>
            </tr>))}
          </tbody>
        </table>
      )}
      <form className="row" style={{ gap: 8, margin: '10px 0 18px' }} onSubmit={add}>
        <input className="input" placeholder="Novi magacin" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button className="btn" disabled={!name.trim()}>+ Dodaj</button>
      </form>
      {stations.data && whs.data && (
        <table className="tbl grid">
          <thead><tr><th>Pripremna pozicija (kategorija)</th><th>Troši iz magacina</th></tr></thead>
          <tbody>{stations.data.map((s) => (
            <tr key={s.id}><td>{s.name}</td><td>
              <select className="input" value={s.warehouseId ?? ''} onChange={(e) => act(() => api('PUT', `/prep-stations/${s.id}/warehouse`, { warehouseId: e.target.value || null }), 'Sačuvano')}>
                <option value="">- podrazumevani magacin -</option>
                {whs.data!.filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select></td></tr>))}
          </tbody>
        </table>
      )}
    </div>
  );
}
