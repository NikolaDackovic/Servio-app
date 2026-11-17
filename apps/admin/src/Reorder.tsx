import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '@shared/api';
import { Empty, ErrorBox, Spinner, useLoad, useToast } from '@shared/ui';
import { Warehouse } from './stockShared';

interface Item {
  productId: string; code: string; name: string; unit: string; stock: string; minStock: string | null;
  dailyUse: string; target: string; suggest: string; lastCost: string | null; partnerId: string | null; partner: string | null;
}
const q3 = (v: string | number) => Number(v).toLocaleString('sr-Latn-RS', { maximumFractionDigits: 3 });

/**
 * Predlog narudžbine: šta i koliko naručiti, po dobavljaču. Količine se mogu menjati; iz predloga se jednim klikom
 * pravi nacrt ulazne fakture (stiže roba → samo se proveri i proknjiži) ili kopira tekst narudžbine za Viber/SMS/mejl.
 */
export function Reorder({ onOpenDocuments }: { onOpenDocuments: () => void }) {
  const toast = useToast();
  const [days, setDays] = useState(14);
  const [cover, setCover] = useState(7);
  const r = useLoad(() => api<{ items: Item[] }>('GET', `/stock/reorder?days=${days}&cover=${cover}`), [days, cover]);
  const whs = useLoad(() => api<Warehouse[]>('GET', '/warehouses'), []);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [off, setOff] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setQty({}); setOff([]); }, [r.data]);

  const groups = useMemo(() => {
    const m = new Map<string, { partnerId: string | null; partner: string; items: Item[] }>();
    for (const i of r.data?.items ?? []) {
      const k = i.partnerId ?? '';
      if (!m.has(k)) m.set(k, { partnerId: i.partnerId, partner: i.partner ?? 'Bez dobavljača (nije bilo ulazne fakture)', items: [] });
      m.get(k)!.items.push(i);
    }
    return [...m.values()];
  }, [r.data]);
  const q = (i: Item) => qty[i.productId] ?? i.suggest.replace('.', ',');
  const chosen = (items: Item[]) => items.filter((i) => !off.includes(i.productId) && Number(q(i).replace(',', '.')) > 0);

  const makeDraft = async (g: (typeof groups)[number]) => {
    const lines = chosen(g.items);
    if (!lines.length) return;
    const wh = whs.data?.find((w) => w.isDefault) ?? whs.data?.[0];
    if (!wh) { toast('err', 'Nema skladišta'); return; }
    setBusy(g.partner);
    try {
      const d = await api<{ id: string; version: number }>('POST', '/stock/documents', { kind: 'RECEIPT', warehouseId: wh.id, ...(g.partnerId ? { partnerId: g.partnerId } : {}) });
      await api('PUT', `/stock/documents/${d.id}/lines`, {
        expectedVersion: d.version,
        lines: lines.map((i) => ({ productId: i.productId, quantity: q(i).replace(',', '.'), unitCost: i.lastCost })),
      });
      toast('ok', `Napravljen nacrt ulazne fakture (${lines.length} stavki) - kad roba stigne, proverite količine i cene i proknjižite`);
      onOpenDocuments();
    } catch (e: any) { toast('err', e.message); } finally { setBusy(null); }
  };
  const copyText = async (g: (typeof groups)[number]) => {
    const lines = chosen(g.items);
    const txt = [`Narudžbina${g.partnerId ? ` - ${g.partner}` : ''} (${new Date().toLocaleDateString('sr-Latn-RS')})`, '',
      ...lines.map((i) => `${i.name} - ${q3(q(i).replace(',', '.'))} ${i.unit}`)].join('\n');
    try { await navigator.clipboard.writeText(txt); toast('ok', 'Tekst narudžbine je kopiran - nalepite ga u Viber, SMS ili mejl'); }
    catch { window.prompt('Kopirajte tekst narudžbine:', txt); }
  };

  return (
    <div className="page wide">
      <div className="toolbar">
        <label>Prosek potrošnje za poslednjih
          <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 30, 60].map((d) => <option key={d} value={d}>{d} dana</option>)}</select></label>
        <label>Naručiti robe za
          <select className="input" value={cover} onChange={(e) => setCover(Number(e.target.value))}>{[3, 5, 7, 10, 14, 30].map((d) => <option key={d} value={d}>{d} dana</option>)}</select></label>
        <span className="muted small grow-1">Predlog = (prosečna dnevna prodaja × dana) ili minimalna zaliha, šta je veće, minus trenutno stanje.</span>
      </div>
      {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !r.data ? <Spinner /> : !groups.length
        ? <Empty>Ništa ne treba naručiti: sve zalihe pokrivaju {cover} dana i iznad su minimuma. (Predlog radi za artikle sa vođenjem zalihe.)</Empty>
        : groups.map((g) => (
          <section key={g.partner} className="card">
            <div className="toolbar">
              <h3 style={{ margin: 0, flex: 1 }}>{g.partner}</h3>
              <button className="btn" onClick={() => copyText(g)} disabled={!chosen(g.items).length}>Kopiraj tekst narudžbine</button>
              <button className="btn primary" disabled={busy !== null || !chosen(g.items).length} onClick={() => makeDraft(g)}>
                {busy === g.partner ? 'Pravim…' : 'Napravi nacrt ulazne fakture'}</button>
            </div>
            <table className="tbl">
              <thead><tr><th /><th>Šifra</th><th>Artikal</th><th className="num">Stanje</th><th className="num">Min.</th><th className="num">Dnevno</th><th className="num">Naručiti</th><th>JM</th><th className="num">Posl. nab. cena</th></tr></thead>
              <tbody>{g.items.map((i) => {
                const on = !off.includes(i.productId);
                return (
                  <tr key={i.productId} className={on ? '' : 'inactive'}>
                    <td><input type="checkbox" checked={on} onChange={() => setOff(on ? [...off, i.productId] : off.filter((x) => x !== i.productId))} /></td>
                    <td><code>{i.code}</code></td><td>{i.name}</td>
                    <td className={`num ${Number(i.stock) <= 0 ? 'qty-out' : ''}`}>{q3(i.stock)}</td>
                    <td className="num">{i.minStock ? q3(i.minStock) : ''}</td>
                    <td className="num">{q3(i.dailyUse)}</td>
                    <td className="num"><input className="input num" style={{ maxWidth: 100 }} inputMode="decimal" value={q(i)} disabled={!on} onChange={(e) => setQty({ ...qty, [i.productId]: e.target.value })} /></td>
                    <td>{i.unit}</td>
                    <td className="num">{i.lastCost ? fmt(Number(i.lastCost).toFixed(2)) : '-'}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </section>
        ))}
    </div>
  );
}
