import { FormEvent, useState } from 'react';
import { api, fmt } from '@shared/api';
import { Empty, ErrorBox, Spinner, useLoad, useToast } from '@shared/ui';
import { download, fq, PickProduct, ProductPicker, Warehouse } from './stockShared';

interface BalanceRow { warehouseId: string; warehouseName: string; productId: string; code: string; name: string; unit: string; quantity: string; avgCost: string; value: string; negative: boolean }

/** Stanje lagera po skladištima, sa vrednošću po prosečnoj nabavnoj ceni. */
export function Balances({ onCard }: { onCard: (productId: string, warehouseId: string) => void }) {
  const toast = useToast();
  const whs = useLoad(() => api<Warehouse[]>('GET', '/warehouses'), []);
  const [wh, setWh] = useState('');
  const [search, setSearch] = useState('');
  const [nonZero, setNonZero] = useState(false);
  const list = useLoad(() => api<{ data: BalanceRow[]; totalValue: string }>('GET',
    `/stock/balances?nonZero=${nonZero}${wh ? `&warehouseId=${wh}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}`), [wh, search, nonZero]);
  const exp = (format: string) => download(`/export/stock-balances?format=${format}${wh ? `&warehouseId=${wh}` : ''}`).catch((e) => toast('err', e.message));
  const negatives = list.data?.data.filter((r) => r.negative).length ?? 0;
  return (
    <div className="page">
      <div className="toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>Stanje lagera</h2>
        <button className="btn" onClick={() => exp('xlsx')}>Izvoz XLSX</button>
        <button className="btn" onClick={() => exp('csv')}>Izvoz CSV</button>
      </div>
      <div className="toolbar">
        <select className="input" style={{ maxWidth: 240 }} value={wh} onChange={(e) => setWh(e.target.value)}>
          <option value="">Sva skladišta</option>
          {whs.data?.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isDefault ? ' (podrazumevano)' : ''}</option>)}
        </select>
        <input className="input" placeholder="Pretraga artikla" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="check row" style={{ alignItems: 'center' }}><input type="checkbox" checked={nonZero} onChange={(e) => setNonZero(e.target.checked)} /> samo sa stanjem ≠ 0</label>
      </div>
      {negatives > 0 && <div className="notice warn">{negatives} artikal(a) je u minusu — prodaja je potrošila više nego što je primljeno. Proknjižite prijemnicu ili popis.</div>}
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Spinner /> : !list.data.data.length ? <Empty>Nema artikala sa vođenjem zalihe. Uključite „Vodi se zaliha“ na artiklu (Artikli i cene).</Empty> : (
        <table className="tbl clickable">
          <thead><tr><th>Skladište</th><th>Šifra</th><th>Artikal</th><th className="num">Količina</th><th>JM</th><th className="num">Prosečna nabavna</th><th className="num">Vrednost</th></tr></thead>
          <tbody>
            {list.data.data.map((r) => (
              <tr key={r.warehouseId + r.productId} onClick={() => onCard(r.productId, r.warehouseId)} title="Otvori karticu artikla">
                <td>{r.warehouseName}</td><td><code>{r.code}</code></td><td>{r.name}</td>
                <td className={`num ${r.negative ? 'warn-text' : ''}`}><strong>{fq(r.quantity)}</strong></td><td>{r.unit}</td>
                <td className="num">{fq(r.avgCost)}</td><td className="num">{fmt(r.value)}</td>
              </tr>
            ))}
            <tr className="strong"><td colSpan={6}>Ukupna vrednost (po prosečnoj nabavnoj ceni)</td><td className="num">{fmt(list.data.totalValue)}</td></tr>
          </tbody>
        </table>
      )}
      <Warehouses onChanged={whs.reload} />
    </div>
  );
}

function Warehouses({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const whs = useLoad(() => api<Warehouse[]>('GET', '/warehouses'), []);
  const stations = useLoad(() => api<{ id: string; name: string; warehouseId: string | null }[]>('GET', '/prep-stations'), []);
  const [name, setName] = useState('');
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); whs.reload(); stations.reload(); onChanged(); toast('ok', msg); } catch (e: any) { toast('err', e.message); }
  };
  const add = (e: FormEvent) => { e.preventDefault(); act(() => api('POST', '/warehouses', { name: name.trim() }), 'Skladište dodato').then(() => setName('')); };
  return (
    <details className="card" style={{ marginTop: 16 }}>
      <summary><strong>Skladišta i odakle prodaja troši robu</strong></summary>
      <p className="muted small">Prodaja troši iz skladišta pripremne pozicije stavke (npr. Šank → skladište Šank); ako pozicija nema skladište — iz podrazumevanog skladišta.</p>
      {whs.data && (
        <table className="tbl">
          <thead><tr><th>Skladište</th><th>Podrazumevano</th><th>Status</th><th /></tr></thead>
          <tbody>{whs.data.map((w) => (
            <tr key={w.id}>
              <td>{w.name}</td><td>{w.isDefault ? '✓' : <button className="btn sm" onClick={() => act(() => api('PATCH', `/warehouses/${w.id}`, { isDefault: true }), 'Podrazumevano skladište promenjeno')}>Postavi</button>}</td>
              <td>{w.active ? 'aktivno' : 'neaktivno'}</td>
              <td>{!w.isDefault && <button className="btn sm" onClick={() => act(() => api('PATCH', `/warehouses/${w.id}`, { active: !w.active }), 'Sačuvano')}>{w.active ? 'Isključi' : 'Uključi'}</button>}</td>
            </tr>))}
          </tbody>
        </table>
      )}
      <form className="row" style={{ gap: 8, margin: '8px 0 16px' }} onSubmit={add}>
        <input className="input" placeholder="Novo skladište" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button className="btn" disabled={!name.trim()}>+ Dodaj</button>
      </form>
      {stations.data && whs.data && (
        <table className="tbl">
          <thead><tr><th>Pripremna pozicija</th><th>Troši iz skladišta</th></tr></thead>
          <tbody>{stations.data.map((s) => (
            <tr key={s.id}><td>{s.name}</td><td>
              <select className="input" value={s.warehouseId ?? ''} onChange={(e) => act(() => api('PUT', `/prep-stations/${s.id}/warehouse`, { warehouseId: e.target.value || null }), 'Sačuvano')}>
                <option value="">— podrazumevano skladište —</option>
                {whs.data!.filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select></td></tr>))}
          </tbody>
        </table>
      )}
    </details>
  );
}

interface Card {
  product: { id: string; code: string; name: string; unit: string }; warehouse: { id: string; name: string };
  from: string | null; to: string | null;
  opening: { quantity: string; avgCost: string }; closing: { quantity: string; avgCost: string }; totals: { in: string; out: string };
  movements: { id: string; at: string; source: string; description: string; in: string | null; out: string | null; unitCost: string; value: string; balanceAfter: string; avgCostAfter: string; user: string | null }[];
}

/** Kartica artikla: sva kretanja sa stanjem posle svakog. */
export function StockCard({ initial }: { initial?: { productId: string; warehouseId: string } | null }) {
  const whs = useLoad(() => api<Warehouse[]>('GET', '/warehouses'), []);
  const [productId, setProductId] = useState(initial?.productId ?? '');
  const [productLabel, setProductLabel] = useState('');
  const [wh, setWh] = useState(initial?.warehouseId ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const whId = wh || whs.data?.find((w) => w.isDefault)?.id || '';
  const card = useLoad(() => (productId && whId
    ? api<Card>('GET', `/stock/card?productId=${productId}&warehouseId=${whId}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`)
    : Promise.resolve(null)), [productId, whId, from, to]);
  return (
    <div className="page">
      <div className="toolbar"><h2 style={{ margin: 0, flex: 1 }}>Kartica artikla</h2></div>
      <div className="toolbar">
        <div style={{ flex: 2, minWidth: 260 }}>
          <ProductPicker onPick={(p: PickProduct) => { setProductId(p.id); setProductLabel(`${p.code} ${p.name}`); }} placeholder={productLabel || card.data?.product.name || 'Artikal: šifra ili naziv…'} />
        </div>
        <select className="input" style={{ maxWidth: 220 }} value={whId} onChange={(e) => setWh(e.target.value)}>
          {whs.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <label>Od<input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Do<input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {!productId ? <Empty>Izaberite artikal.</Empty> : card.error ? <ErrorBox error={card.error} onRetry={card.reload} /> : !card.data ? <Spinner /> : (
        <>
          <h3 style={{ marginTop: 0 }}><code>{card.data.product.code}</code> {card.data.product.name} · {card.data.warehouse.name} <span className="muted">({card.data.product.unit})</span></h3>
          <table className="tbl">
            <thead><tr><th>Vreme</th><th>Promena</th><th className="num">Ulaz</th><th className="num">Izlaz</th><th className="num">Cena</th><th className="num">Vrednost</th><th className="num">Stanje</th><th className="num">PPNC</th><th>Korisnik</th></tr></thead>
            <tbody>
              <tr className="muted"><td colSpan={6}>Početno stanje{card.data.from ? ` na dan ${card.data.from.split('-').reverse().join('.')}.` : ''}</td><td className="num">{fq(card.data.opening.quantity)}</td><td className="num">{fq(card.data.opening.avgCost)}</td><td /></tr>
              {card.data.movements.map((m) => (
                <tr key={m.id} className={m.source === 'REVERSAL' ? 'voided' : ''}>
                  <td>{new Date(m.at).toLocaleString('sr-Latn-RS')}</td><td>{m.description}</td>
                  <td className="num">{fq(m.in)}</td><td className="num">{fq(m.out)}</td>
                  <td className="num">{fq(m.unitCost)}</td><td className="num">{fmt(m.value)}</td>
                  <td className={`num ${m.balanceAfter.startsWith('-') ? 'warn-text' : ''}`}><strong>{fq(m.balanceAfter)}</strong></td><td className="num">{fq(m.avgCostAfter)}</td>
                  <td className="small">{m.user ?? ''}</td>
                </tr>
              ))}
              {card.data.movements.length === 0 && <tr><td colSpan={9} className="muted">Nema kretanja u periodu.</td></tr>}
              <tr className="strong"><td colSpan={2}>Promet / završno stanje</td><td className="num">{fq(card.data.totals.in)}</td><td className="num">{fq(card.data.totals.out)}</td><td /><td /><td className="num">{fq(card.data.closing.quantity)}</td><td className="num">{fq(card.data.closing.avgCost)}</td><td /></tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
