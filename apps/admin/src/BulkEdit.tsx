import { useState } from 'react';
import { api, Category, fmt, Product } from '@shared/api';
import { Modal } from '@shared/ui';

type Row = Product & { isSellable: boolean };

/**
 * Grupna izmena: svi prodajni proizvodi izabrane grupe (ili svi) - poskupljenje/pojeftinjenje u % ili dinarima
 * sa zaokruživanjem, premeštanje u drugu grupu, uključivanje/isključivanje.
 * Pre primene se vidi stara → nova cena; pojedinačni proizvodi se mogu izostaviti. Svaka promena cene ide u istoriju cena.
 */
export function BulkEdit({ rows, cats, onClose, onDone }: { rows: Row[]; cats: Category[]; onClose: () => void; onDone: () => void }) {
  const [group, setGroup] = useState('');
  const [action, setAction] = useState<'price' | 'group' | 'active'>('price');
  const [mode, setMode] = useState<'pct' | 'abs'>('pct');
  const [amount, setAmount] = useState('');
  const [round, setRound] = useState('10');
  const [target, setTarget] = useState(cats[0]?.id ?? '');
  const [active, setActive] = useState(true);
  const [skip, setSkip] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; errors: string[] } | null>(null);

  const scope = rows.filter((p) => p.isSellable && (action === 'active' || p.active) && (!group || p.categoryId === group));
  const a = Number(amount.replace(',', '.'));
  const amountOk = amount.trim() !== '' && Number.isFinite(a);
  const newPrice = (p: Row) => {
    let v = mode === 'pct' ? Number(p.price) * (1 + a / 100) : Number(p.price) + a;
    const r = Number(round);
    if (r > 0) v = Math.round(v / r) * r;
    return Math.max(0, Math.round(v * 100) / 100);
  };
  const changes = scope.filter((p) => !skip.includes(p.id)).filter((p) =>
    action === 'price' ? amountOk && newPrice(p) !== Number(p.price)
      : action === 'group' ? p.categoryId !== target : p.active !== active);
  const running = !!progress && progress.done < progress.total;

  const apply = async () => {
    if (!window.confirm(`Primeniti izmenu na ${changes.length} proizvoda?`)) return;
    const errors: string[] = [];
    setProgress({ done: 0, total: changes.length, errors });
    for (const [i, p] of changes.entries()) {
      const body = action === 'price' ? { price: newPrice(p).toFixed(2) } : action === 'group' ? { categoryId: target } : { active };
      try { await api('PATCH', `/products/${p.id}`, body); } catch (e: any) { errors.push(`${p.name}: ${e.message}`); }
      setProgress({ done: i + 1, total: changes.length, errors: [...errors] });
    }
    onDone();
  };

  return (
    <Modal title="Grupna izmena proizvoda" onClose={onClose} wide>
      <div className="form">
        <div className="grid2 tight">
          <label>Proizvodi iz grupe<select className="input" value={group} onChange={(e) => { setGroup(e.target.value); setSkip([]); }}>
            <option value="">Sve grupe</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Izmena<select className="input" value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
            <option value="price">Promena cene</option><option value="group">Premesti u drugu grupu</option><option value="active">Uključi / isključi</option></select></label>
        </div>
        {action === 'price' && (
          <div className="grid2 tight">
            <label>Za koliko (minus = pojeftinjenje)
              <span className="row gap">
                <input className="input num" autoFocus inputMode="decimal" value={amount} placeholder={mode === 'pct' ? 'npr. 10 ili -5' : 'npr. 20 ili -10'} onChange={(e) => setAmount(e.target.value)} />
                <span className="seg">
                  <button type="button" className={`seg-btn ${mode === 'pct' ? 'on' : ''}`} onClick={() => setMode('pct')}>%</button>
                  <button type="button" className={`seg-btn ${mode === 'abs' ? 'on' : ''}`} onClick={() => setMode('abs')}>din</button>
                </span>
              </span>
            </label>
            <label>Zaokruži novu cenu na<select className="input" value={round} onChange={(e) => setRound(e.target.value)}>
              <option value="0">bez zaokruživanja</option><option value="1">1 din</option><option value="5">5 din</option><option value="10">10 din</option><option value="50">50 din</option></select></label>
          </div>
        )}
        {action === 'group' && <label>Nova grupa<select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        {action === 'active' && (
          <div className="seg">
            <button type="button" className={`seg-btn ${active ? 'on' : ''}`} onClick={() => setActive(true)}>Uključi (vide se na kasi)</button>
            <button type="button" className={`seg-btn ${!active ? 'on' : ''}`} onClick={() => setActive(false)}>Isključi (ne vide se na kasi)</button>
          </div>
        )}
        <div className="bulk-preview">
          <table className="tbl">
            <thead><tr><th title="Štiklirani ulaze u izmenu" /><th>Proizvod</th><th>Grupa</th><th className="num">Cena sada</th>{action === 'price' && <th className="num">Nova cena</th>}</tr></thead>
            <tbody>{scope.map((p) => {
              const on = !skip.includes(p.id);
              return (
                <tr key={p.id} className={on ? '' : 'inactive'}>
                  <td><input type="checkbox" checked={on} onChange={() => setSkip(on ? [...skip, p.id] : skip.filter((x) => x !== p.id))} /></td>
                  <td>{p.name}{!p.active && <span className="muted"> (isključen)</span>}</td>
                  <td>{cats.find((c) => c.id === p.categoryId)?.name}</td>
                  <td className="num">{fmt(p.price)}</td>
                  {action === 'price' && <td className="num"><strong>{amountOk && on ? fmt(newPrice(p).toFixed(2)) : ''}</strong></td>}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
        {progress && <div className="notice">Urađeno {progress.done} / {progress.total}{progress.errors.length ? ` · greške: ${progress.errors.join('; ')}` : ''}</div>}
        <div className="modal-actions">
          <button className="btn primary" disabled={!changes.length || running} onClick={apply}>{running ? 'Primenjujem…' : `Primeni na ${changes.length} proizvoda`}</button>
          <button className="btn" disabled={running} onClick={onClose}>Zatvori</button>
        </div>
      </div>
    </Modal>
  );
}
