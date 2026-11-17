import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt } from '@shared/api';
import { ErrorBox, Spinner, useLoad } from '@shared/ui';

interface Overview {
  day: { id: string; name: string; date: string } | null;
  sales: { paidCount: number; paidTotal: string; openCount: number; openTotal: string; refunds: string; byMethod: Record<string, string> } | null;
  lowStock: { name: string; unit: string; qty: string; min: string }[];
  warnings: { fiscalFailed: number; fiscalStuck: number; printFailed: number; draftDocs: number; defaultPassword?: boolean };
  checklist: { id: string; label: string; done: boolean; count?: number }[];
}

const q = (v: string) => Number(v).toLocaleString('sr-Latn-RS', { maximumFractionDigits: 3 });

/**
 * Početna ADMIN-a: današnji promet, šta traži pažnju (klik vodi na pravu stranicu), brze radnje
 * i kontrolna lista za otvaranje lokala - novi korisnik vidi redom šta treba da podesi.
 */
export function Home({ name, go, canReport }: { name: string; go: (view: string, intent?: string) => void; canReport: boolean }) {
  const o = useLoad(() => (canReport ? api<Overview>('GET', '/admin/overview') : Promise.resolve(null)), []);
  useEffect(() => { const t = setInterval(() => o.reload(), 60_000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Dobro jutro' : hour < 18 ? 'Dobar dan' : 'Dobro veče';
  const quick: [string, string, string?][] = [
    ['Novi artikal', 'products', 'new'], ['Ulazna faktura (prijem robe)', 'documents', 'RECEIPT'], ['Popis', 'documents', 'STOCKTAKE'],
    ['Trenutno stanje robe', 'balances'], ['Šta naručiti', 'reorder'], ['Pazar po danima', 'calendar'], ['Izveštaj prometa', 'report'], ['Pregled računa', 'receipts'], ['Mapa stolova', 'tables'], ['Uputstvo (kasa, ADMIN, KDS)', 'help'],
  ];

  return (
    <div className="page wide home">
      <h2 className="home-hello">{hello}, {name.split(' ')[0]}</h2>
      {o.loading && !o.data ? <Spinner /> : o.error ? <ErrorBox error={o.error} onRetry={o.reload} /> : o.data && (
        <>
          <section className="home-tiles">
            {o.data.day && o.data.sales ? (
              <>
                <Tile label={`Promet - ${o.data.day.name || o.data.day.date.split('-').reverse().join('.')}`} value={fmt((Number(o.data.sales.paidTotal) - Number(o.data.sales.byMethod.REPRESENTATION ?? 0)).toFixed(2))} sub={`${o.data.sales.paidCount} računa`} onClick={() => go('report')} big />
                <Tile label="Gotovina" value={fmt(o.data.sales.byMethod.CASH ?? '0')} />
                <Tile label="Kartica" value={fmt(o.data.sales.byMethod.CARD ?? '0')} />
                <Tile label="Otvoreni računi" value={fmt(o.data.sales.openTotal)} sub={`${o.data.sales.openCount} stolova`} onClick={() => go('receipts')} />
                {Number(o.data.sales.byMethod.REPRESENTATION ?? 0) > 0 && <Tile label="Reprezentacija" value={fmt(o.data.sales.byMethod.REPRESENTATION)} />}
                {Number(o.data.sales.refunds) > 0 && <Tile label="Povraćaji" value={fmt(o.data.sales.refunds)} warn />}
              </>
            ) : <Tile label="Dan" value="Nije otvoren" sub="Dan se otvara na kasi" />}
          </section>

          <Attention o={o.data} go={go} />
        </>
      )}

      <section className="card">
        <h3>Brze radnje</h3>
        <div className="home-quick">
          {quick.map(([label, view, intent]) => <button key={label} className="btn" onClick={() => go(view, intent)}>{label}</button>)}
        </div>
        <p className="muted small">Savet: <kbd>Ctrl</kbd>+<kbd>K</kbd> otvara pretragu svih stranica ADMIN-a.</p>
      </section>

      {o.data && <Checklist items={o.data.checklist} go={go} />}
    </div>
  );
}

function Tile({ label, value, sub, onClick, big, warn }: { label: string; value: string; sub?: string; onClick?: () => void; big?: boolean; warn?: boolean }) {
  const C = onClick ? 'button' : 'div';
  return (
    <C className={`home-tile ${big ? 'big' : ''} ${warn ? 'warn' : ''} ${onClick ? 'click' : ''}`} onClick={onClick}>
      <span className="home-tile-label">{label}</span>
      <b className="home-tile-value">{value}</b>
      {sub && <span className="muted small">{sub}</span>}
    </C>
  );
}

function Attention({ o, go }: { o: Overview; go: (v: string) => void }) {
  const w = o.warnings;
  const items: { text: string; view: string; level: 'err' | 'warn' }[] = [];
  if (w.defaultPassword) items.push({ text: 'Nalog ADMIN još ima podrazumevanu šifru 0000 - promenite je (Korisnici), naročito ako se ADMIN otvara od kuće', view: 'users', level: 'err' });
  if (w.fiscalFailed) items.push({ text: `${w.fiscalFailed} računa nije fiskalizovano (greška) - ponovite slanje`, view: 'fiscal', level: 'err' });
  if (w.fiscalStuck) items.push({ text: `${w.fiscalStuck} računa čeka fiskalizaciju duže od 5 minuta - proverite LPFR`, view: 'fiscal', level: 'err' });
  if (w.printFailed) items.push({ text: `${w.printFailed} štampanja nije uspelo danas - proverite štampač`, view: 'printing', level: 'warn' });
  if (o.lowStock.length) items.push({ text: `${o.lowStock.length} artikala ispod minimalne zalihe: ${o.lowStock.slice(0, 4).map((l) => `${l.name} (${q(l.qty)} ${l.unit})`).join(', ')}${o.lowStock.length > 4 ? '…' : ''}`, view: 'reorder', level: 'warn' });
  if (w.draftDocs) items.push({ text: `${w.draftDocs} dokumenata u nacrtu (nisu proknjiženi - roba nije na stanju)`, view: 'documents', level: 'warn' });
  return (
    <section className="card">
      <h3>Traži pažnju</h3>
      {items.length === 0 ? <p className="ok-text">✓ Sve je u redu.</p> : (
        <ul className="home-attn">
          {items.map((i) => <li key={i.text}><button className={`home-attn-item ${i.level}`} onClick={() => go(i.view)}>{i.level === 'err' ? '⚠' : '•'} {i.text} <span aria-hidden>›</span></button></li>)}
        </ul>
      )}
    </section>
  );
}

function Checklist({ items, go }: { items: Overview['checklist']; go: (v: string) => void }) {
  const done = items.filter((i) => i.done).length;
  if (done === items.length) return null;
  return (
    <section className="card">
      <h3>Podešavanje lokala <small className="muted">{done} od {items.length} urađeno</small></h3>
      <div className="home-progress"><span style={{ width: `${(done / items.length) * 100}%` }} /></div>
      <ol className="home-check">
        {items.map((i) => (
          <li key={i.label} className={i.done ? 'done' : ''}>
            <button onClick={() => go(i.id)}>{i.done ? '✓' : '○'} {i.label}{i.count !== undefined && i.count > 0 ? ` (${i.count})` : ''} {!i.done && <span className="muted">→ podesi</span>}</button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Ctrl+K: pretraga svih stranica ADMIN-a (kucanje + Enter umesto traženja po menijima). */
export function CommandPalette({ items, go, onClose }: { items: { id: string; label: string; group: string }[]; go: (v: string) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const norm = (s: string) => s.toLocaleLowerCase('sr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'dj');
  const list = useMemo(() => {
    const t = norm(text.trim());
    return items.filter((i) => !t || norm(`${i.label} ${i.group}`).includes(t));
  }, [text, items]);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => setHi(0), [text]);
  const pick = (i: { id: string }) => { go(i.id); onClose(); };
  return (
    <div className="cmdk-back" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Pretraga stranica">
        <input ref={ref} className="input" value={text} placeholder="Gde želite da odete? npr. faktura, popis, štampač, PIN…" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter' && list[hi]) pick(list[hi]);
          }} />
        <ul>
          {list.map((i, n) => (
            <li key={i.id + i.label}><button className={n === hi ? 'hi' : ''} onMouseEnter={() => setHi(n)} onClick={() => pick(i)}>
              <span>{i.label}</span><span className="muted small">{i.group}</span></button></li>
          ))}
          {list.length === 0 && <li className="muted small" style={{ padding: 10 }}>Ništa za „{text}“.</li>}
        </ul>
      </div>
    </div>
  );
}
