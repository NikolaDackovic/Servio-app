import { useEffect, useRef, useState } from 'react';
import { Modal } from '@shared/ui';

type PriceKey = 'unitNet' | 'unitGross' | 'totalNet' | 'totalGross';
export const num = (s: string | null | undefined) => Number(String(s ?? '').replace(/\./g, (m, i, all) => (all.includes(',') ? '' : m)).replace(',', '.')) || 0;
const show = (v: number, d = 2) => (Number.isFinite(v) ? v.toLocaleString('sr-Latn-RS', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false }) : '');
const ROUND: [string, number][] = [['0,01', 0.01], ['0,10', 0.1], ['1', 1], ['10', 10]];

export interface CalcResult { quantity: number; unitCost: number | null; discountPercent: number; salePrice: number | null }

/**
 * Kalkulator jedinične cene (otvara se posle izbora artikla na dokumentu):
 * količina = pakovanja × komada; cena se kuca kako piše na fakturi (jedinična/ukupna, bez/sa PDV-om) - ostale se računaju;
 * popust (rabat); rezultat je nova nabavna cena po jedinici bez PDV-a; marža i prodajna cena (menja cenu artikla).
 * Režim "qty": samo količina (izlaz, otpis, popis); "correction": + ulaz / - izlaz.
 */
export function Calculator({ name, unit, rate, stock, lastCost, salePrice, initial, mode, auto, onAuto, onClose, onSave }: {
  name: string; unit: string; rate: number; stock: number | null; lastCost: number | null; salePrice: number | null;
  initial?: { quantity: number; unitNet: number | null; discount: number };
  mode: 'price' | 'qty' | 'correction'; auto: boolean; onAuto: (v: boolean) => void;
  onClose: () => void; onSave: (r: CalcResult) => void;
}) {
  const [a, setA] = useState(initial?.quantity ? show(Math.abs(initial.quantity), 3).replace(/,?0+$/, '') : '1');
  const [b, setB] = useState('1');
  const [sign, setSign] = useState<1 | -1>(initial && initial.quantity < 0 ? -1 : 1);
  const [basis, setBasis] = useState<PriceKey>('unitNet');
  const [val, setVal] = useState(initial?.unitNet ? show(initial.unitNet, 4) : lastCost ? show(lastCost, 4) : '');
  const [rabat, setRabat] = useState(initial?.discount ? show(initial.discount) : '');
  const [sale, setSale] = useState(salePrice ? show(salePrice) : '');
  const [marginTxt, setMarginTxt] = useState<string | null>(null);
  const [round, setRound] = useState(0.01);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => first.current?.select(), 30); }, []);

  const qty = num(a) * num(b);
  const k = 1 + rate / 100;
  const raw = basis === 'unitNet' ? num(val) : basis === 'unitGross' ? num(val) / k : basis === 'totalNet' ? (qty ? num(val) / qty : 0) : (qty ? num(val) / k / qty : 0);
  const r = Math.min(Math.max(num(rabat), 0), 99.99);
  const result = raw * (1 - r / 100);
  const derived: Record<PriceKey, number> = { unitNet: raw, unitGross: raw * k, totalNet: raw * qty, totalGross: raw * k * qty };
  const field = (key: PriceKey) => (basis === key ? val : raw ? show(derived[key], key.startsWith('unit') ? 4 : 2) : '');
  const setField = (key: PriceKey, v: string) => { setBasis(key); setVal(v); };
  const costGross = result * k;
  const margin = costGross > 0 && num(sale) > 0 ? (num(sale) / costGross - 1) * 100 : 0;
  const setMargin = (t: string) => {
    setMarginTxt(t);
    if (costGross > 0) setSale(show(Math.round((costGross * (1 + num(t) / 100)) / round) * round));
  };
  const price = mode === 'price';
  const ok = qty > 0 && (!price || raw > 0);
  const save = () => ok && onSave({
    quantity: +(qty * (mode === 'correction' ? sign : 1)).toFixed(4),
    unitCost: price ? +result.toFixed(4) : null, discountPercent: price ? r : 0,
    salePrice: price && num(sale) > 0 && num(sale) !== salePrice ? +num(sale).toFixed(2) : null,
  });
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !(e.target as HTMLElement).matches('button')) { e.preventDefault(); save(); } };

  return (
    <Modal title="Kalkulator jedinične cene" onClose={onClose}>
      <div className="calc" onKeyDown={enter}>
        <div className="calc-head">
          <div>
            <b className="calc-name">{name} ({unit}), PDV: {show(rate)}%</b>
            <div className="calc-info">Trenutna zaliha: {stock === null ? '-' : show(stock, 4)}</div>
            {price && <div className="calc-info">Poslednja nabavna cena: {lastCost === null ? '-' : show(lastCost)}</div>}
            {price && <div className="calc-info">Nova nabavna cena: {show(result)}</div>}
          </div>
          <label className="check calc-auto"><input type="checkbox" checked={!auto} onChange={(e) => onAuto(!e.target.checked)} /> Ne prikazuj automatski</label>
        </div>
        {mode === 'correction' && (
          <div className="seg">
            <button type="button" className={`seg-btn ${sign === 1 ? 'on' : ''}`} onClick={() => setSign(1)}>+ Ulaz (dodaj na stanje)</button>
            <button type="button" className={`seg-btn ${sign === -1 ? 'on' : ''}`} onClick={() => setSign(-1)}>− Izlaz (skini sa stanja)</button>
          </div>
        )}
        <div className="calc-grid">
          <span>Količina</span>
          <div className="calc-qty">
            <input ref={first} className="input num" inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} aria-label="Pakovanja" />
            <span>×</span>
            <input className="input num" inputMode="decimal" value={b} onChange={(e) => setB(e.target.value)} aria-label="Komada u pakovanju" title="Komada u pakovanju (npr. 24)" />
            <span>=</span>
            <input className="input num ro" readOnly tabIndex={-1} value={show(qty, 4)} aria-label="Količina" />
          </div>
          {price && <>
            <span>Jed. cena bez PDV</span><input className={`input num ${basis === 'unitNet' ? 'on' : ''}`} inputMode="decimal" value={field('unitNet')} onChange={(e) => setField('unitNet', e.target.value)} aria-label="Jedinična cena bez PDV" />
            <span>Jed. cena sa PDV</span><input className={`input num ${basis === 'unitGross' ? 'on' : ''}`} inputMode="decimal" value={field('unitGross')} onChange={(e) => setField('unitGross', e.target.value)} aria-label="Jedinična cena sa PDV" />
            <span>Ukupna cena bez PDV</span><input className={`input num ${basis === 'totalNet' ? 'on' : ''}`} inputMode="decimal" value={field('totalNet')} onChange={(e) => setField('totalNet', e.target.value)} aria-label="Ukupna cena bez PDV" />
            <span>Ukupna cena sa PDV</span><input className={`input num ${basis === 'totalGross' ? 'on' : ''}`} inputMode="decimal" value={field('totalGross')} onChange={(e) => setField('totalGross', e.target.value)} aria-label="Ukupna cena sa PDV" />
            <span>Popust</span><input className="input num" inputMode="decimal" value={rabat} placeholder="0,00" onChange={(e) => setRabat(e.target.value)} aria-label="Popust" />
            <span>Rezultat</span><input className="input num ro" readOnly tabIndex={-1} value={show(result, 10)} aria-label="Rezultat" />
          </>}
        </div>
        <div className="calc-foot">
          {price && <>
            <label>Zaokr.<select className="input" value={round} onChange={(e) => setRound(Number(e.target.value))}>{ROUND.map(([l, v]) => <option key={l} value={v}>{l}</option>)}</select></label>
            <label>Marža %<input className="input num" inputMode="decimal" value={marginTxt ?? show(margin)} onChange={(e) => setMargin(e.target.value)} onBlur={() => setMarginTxt(null)} /></label>
            <label>Prodajna cena<input className="input num" inputMode="decimal" value={sale} onChange={(e) => { setSale(e.target.value); setMarginTxt(null); }} /></label>
          </>}
          <div className="calc-btns">
            <button type="button" className="btn primary" disabled={!ok} onClick={save}>Potvrdi</button>
            <button type="button" className="btn" onClick={onClose}>Zatvori</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
