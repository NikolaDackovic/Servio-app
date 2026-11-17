import { useMemo, useState } from 'react';
import { api } from '@shared/api';
import { ErrorBox, Spinner, useLoad } from '@shared/ui';
import { Column, DataTable } from './DataTable';
import { CheckList, n2, n4, useDayRange } from './dayRange';
import { useTab } from './tabs';

interface Raw { productId: string; code: string; name: string; unitPrice: string; quantity: string; total: string; waiter: string; tableName: string; discountPercent: string; kind: string; groupName: string; stationName: string; warehouseName: string }
interface Row { key: string; name: string; code: string; qty: number; price: number; total: number }

const KINDS: [string, string][] = [['regular', 'Promet'], ['representation', 'Reprezentacija']];
const pct = (s: string) => (Number(s) ? `${Number(s)}%` : 'Bez popusta');

/**
 * Specifikacija izdatih artikala (kao u Octopos-u): levo početna i završna smena, tip računa, vreme od-do i liste
 * (korisnik, magacin, popust, kategorija, grupa, proizvod, sto - ništa štiklirano = sve); desno prodato po artiklu i ceni.
 */
export function SoldItems() {
  const tab = useTab();
  const range = useDayRange();
  const [kinds, setKinds] = useState<string[]>(['regular', 'representation']);
  const [byTime, setByTime] = useState(false);
  const [tf, setTf] = useState('08:00');
  const [tt, setTt] = useState('23:59');
  const [q, setQ] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const data = useLoad(() => (q ? api<Raw[]>('GET', q) : Promise.resolve(null)), [q, run]);
  const [f, setF] = useState<Record<string, string[]>>({});
  const find = () => {
    if (!range.ids.length) return;
    setQ(`/reports/sold-items?dayIds=${range.ids.join(',')}${byTime ? `&timeFrom=${tf}&timeTo=${tt}` : ''}`);
    setRun((x) => x + 1);
  };

  const raw = data.data ?? [];
  const lists: [string, string, (r: Raw) => string][] = [
    ['waiter', 'Korisnik', (r) => r.waiter], ['wh', 'Magacin', (r) => r.warehouseName], ['disc', 'Popust', (r) => pct(r.discountPercent)],
    ['station', 'Kategorija', (r) => r.stationName], ['group', 'Grupa', (r) => r.groupName], ['prod', 'Proizvod', (r) => r.name], ['table', 'Sto', (r) => r.tableName || 'brzi račun'],
  ];
  const opts = useMemo(() => Object.fromEntries(lists.map(([k, , get]) => [k, [...new Set(raw.map(get))].sort((a, b) => a.localeCompare(b, 'sr', { numeric: true }))])), [raw]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo<Row[]>(() => {
    const m = new Map<string, Row>();
    for (const r of raw) {
      if (!kinds.includes(r.kind)) continue;
      if (!lists.every(([k, , get]) => !f[k]?.length || f[k].includes(get(r)))) continue;
      const key = `${r.productId}|${r.unitPrice}`;
      const x = m.get(key) ?? { key, name: r.name, code: r.code, qty: 0, price: Number(r.unitPrice), total: 0 };
      x.qty += Number(r.quantity); x.total += Number(r.total);
      m.set(key, x);
    }
    return [...m.values()];
  }, [raw, kinds, f]); // eslint-disable-line react-hooks/exhaustive-deps
  const columns: Column<Row>[] = [
    { key: 'name', label: 'Proizvod', value: (r) => r.name, render: (r) => <b>{r.name}</b> },
    { key: 'code', label: 'Šifra', value: (r) => r.code, width: 80 },
    { key: 'qty', label: 'Količina', value: (r) => r.qty, render: (r) => n4(r.qty), align: 'right', filter: false, width: 120 },
    { key: 'price', label: 'Prodajna cena', value: (r) => r.price, render: (r) => n2(r.price), align: 'right', filter: false, width: 130 },
    { key: 'total', label: 'Prodajna vrednost', value: (r) => r.total, render: (r) => <b>{n2(r.total)}</b>, align: 'right', filter: false, width: 150 },
  ];

  return (
    <div className="page wide side-layout">
      <aside className="side">
        {range.ui}
        <div className="cl">
          <div className="cl-head"><b>Tip računa</b></div>
          <div className="cl-box">{KINDS.map(([k, l]) => <label key={k} className="check"><input type="checkbox" checked={kinds.includes(k)} onChange={() => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])} /> {l}</label>)}</div>
        </div>
        <div className="side-time">
          <label className="check"><input type="checkbox" checked={byTime} onChange={(e) => setByTime(e.target.checked)} /> Za vreme</label>
          <label>Od<input type="time" className="input" disabled={!byTime} value={tf} onChange={(e) => setTf(e.target.value)} /></label>
          <label>Do<input type="time" className="input" disabled={!byTime} value={tt} onChange={(e) => setTt(e.target.value)} /></label>
        </div>
        <button className="btn primary side-find" disabled={!range.ids.length || data.loading} onClick={find}>{data.loading ? 'Tražim…' : 'Pronađi'}</button>
        {raw.length > 0 && <div className="side-lists">
          {lists.map(([k, l]) => <CheckList key={k} title={l} items={opts[k] ?? []} value={f[k] ?? []} onChange={(v) => setF({ ...f, [k]: v })} search={k === 'prod'} />)}
        </div>}
      </aside>
      <div className="side-main fill">
        {data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> : data.loading && !data.data ? <Spinner /> : (
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.key} initialSort={{ key: 'name', dir: 1 }}
            empty={q ? 'Nema prodaje za izabrane filtere.' : 'Izaberite smene i kliknite Pronađi.'}
            totals={(rs) => ({ name: 'UKUPNO', qty: <b>{n4(rs.reduce((a, r) => a + r.qty, 0))}</b>, total: <b>{n2(rs.reduce((a, r) => a + r.total, 0))}</b> })} />
        )}
        <div className="bar">
          <div className="bar-left"><button className="btn" disabled={!rows.length} onClick={() => window.print()}>Štampaj</button></div>
          <div className="bar-right"><button className="btn" onClick={tab.close}>Zatvori</button></div>
        </div>
      </div>
    </div>
  );
}
