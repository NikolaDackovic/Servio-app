import { useEffect, useMemo, useState } from 'react';
import { api } from '@shared/api';
import { ErrorBox, Spinner, useLoad } from '@shared/ui';

export interface Day { id: string; date: string; name: string; status: string; openedAt: string }
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(d);
const WD = ['Nedelja', 'Ponedeljak', 'Utorak', 'Sreda', 'Četvrtak', 'Petak', 'Subota'];
/** "30.10.2026 Petak" (naziv smene ako je dat, npr. Ponedeljak1) */
export const dayLabel = (d: Day) => `${d.date.split('-').reverse().join('.')} ${d.name || WD[new Date(`${d.date}T12:00:00`).getDay()]}${d.status === 'OPEN' ? ' (otvorena)' : ''}`;

/**
 * Smene (poslovni dani) iz poslednjih meseci i izbor "od početne do završne smene" - kao u Octopos-u.
 * Vraća izabrane smene (id-jeve), datume od-do i JSX sa dva padajuća menija.
 */
export function useDayRange(months = 6) {
  const list = useMemo(() => { const d = new Date(); return Array.from({ length: months }, (_, k) => ymd(new Date(d.getFullYear(), d.getMonth() - k, 15)).slice(0, 7)); }, [months]);
  const days = useLoad(async () => {
    const all = (await Promise.all(list.map((m) => api<Day[]>('GET', `/business-days?month=${m}`).catch(() => [] as Day[])))).flat().filter((d) => d.id);
    return all.sort((a, b) => (b.openedAt ?? b.date).localeCompare(a.openedAt ?? a.date));
  }, []);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => { if (days.data?.[0] && !from) { setFrom(days.data[0].id); setTo(days.data[0].id); } }, [days.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const l = days.data ?? [];
  const i = l.findIndex((d) => d.id === from), j = l.findIndex((d) => d.id === to);
  const sel = i < 0 || j < 0 ? [] : l.slice(Math.min(i, j), Math.max(i, j) + 1);
  const ids = sel.map((d) => d.id);
  const dates = sel.length ? { from: sel[sel.length - 1].date, to: sel[0].date } : null;
  const ui = days.loading && !days.data ? <Spinner /> : days.error ? <ErrorBox error={days.error} onRetry={days.reload} /> : (
    <div className="dr">
      <label>Početna smena<select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>{l.map((d) => <option key={d.id} value={d.id}>{dayLabel(d)}</option>)}</select></label>
      <label>Završna smena<select className="input" value={to} onChange={(e) => setTo(e.target.value)}>{l.map((d) => <option key={d.id} value={d.id}>{dayLabel(d)}</option>)}</select></label>
      {l.length === 0 && <small className="muted">Još nema smena.</small>}
    </div>
  );
  return { ids, dates, ui, days: l };
}

/** Lista sa kućicama (Korisnik, Magacin, Grupa…): ništa štiklirano = sve. */
export function CheckList({ title, items, value, onChange, search }: {
  title: string; items: string[]; value: string[]; onChange: (v: string[]) => void; search?: boolean;
}) {
  const [q, setQ] = useState('');
  const shown = q ? items.filter((x) => x.toLowerCase().includes(q.toLowerCase())) : items;
  return (
    <div className="cl">
      <div className="cl-head"><b>{title}</b>{value.length > 0 && <button type="button" className="link small" onClick={() => onChange([])}>sve ({value.length})</button>}</div>
      {search && <input className="input cl-q" placeholder="traži…" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="cl-box">
        {shown.length === 0 ? <small className="muted">-</small> : shown.map((x) => (
          <label key={x} className="check"><input type="checkbox" checked={value.includes(x)} onChange={() => onChange(value.includes(x) ? value.filter((y) => y !== x) : [...value, x])} /> {x || '(bez)'}</label>
        ))}
      </div>
    </div>
  );
}

export const n2 = (v: number) => v.toLocaleString('sr-Latn-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const n4 = (v: number) => v.toLocaleString('sr-Latn-RS', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
