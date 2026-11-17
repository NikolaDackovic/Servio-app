import { ReactNode, useMemo, useState } from 'react';

export interface Column<T> {
  key: string;
  label: string;
  /** Vrednost za filter i sortiranje (tekst ili broj). */
  value: (row: T) => string | number | null | undefined;
  /** Prikaz u ćeliji (podrazumevano: vrednost). */
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** Filter u redu ispod zaglavlja: tekst (sadrži), izbor (tačna vrednost) ili bez filtera. */
  filter?: 'text' | 'select' | false;
  /** Manje važna kolona: sakriva se na užem ekranu (klasa dt-opt / dt-opt2). */
  optional?: 1 | 2 | 3;
}

/** 1 red, 2-4 reda, 5+ redova (21 red, 22 reda, 11-14 redova). */
const redova = (n: number) => { const d = n % 10, h = n % 100; return `${n} ${d === 1 && h !== 11 ? 'red' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'reda' : 'redova'}`; };

const norm = (s: string) => s.toLocaleLowerCase('sr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'dj');

/**
 * Tabela ADMIN-a (ista svuda): zaglavlje, red za filtere iznad naslova kolona (kucanje direktno u kolonu),
 * sortiranje klikom na naslov kolone, broj redova u podnožju.
 */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, onRowDoubleClick, selectedKey, rowClass, empty = 'Nema podataka.', footer, initialSort, totals, actions, fit }: {
  columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string;
  onRowClick?: (row: T) => void; rowClass?: (row: T) => string | undefined;
  /** Dvoklik (npr. otvaranje proizvoda); jedan klik tada samo označava red (selectedKey). */
  onRowDoubleClick?: (row: T) => void; selectedKey?: string | null;
  empty?: string; footer?: ReactNode; initialSort?: { key: string; dir: 1 | -1 };
  /** Zbirni red (UKUPNO) iz prikazanih redova (posle filtera): vrednost po ključu kolone. */
  totals?: (shown: T[]) => Partial<Record<string, ReactNode>>;
  /** Dugmad u podnožju tabele (desno od broja redova). */
  actions?: ReactNode;
  /** Tabela uvek staje u širinu (kolone se sužavaju, dug tekst se skraćuje) - kao u Octopos-u. */
  fit?: boolean;
}) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(initialSort ?? null);
  const options = useMemo(() => {
    const o: Record<string, string[]> = {};
    for (const c of columns) if (c.filter === 'select') {
      o[c.key] = [...new Set(rows.map((r) => String(c.value(r) ?? '')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'sr'));
    }
    return o;
  }, [columns, rows]);
  const shown = useMemo(() => {
    let out = rows.filter((r) => columns.every((c) => {
      const f = filters[c.key];
      if (!f) return true;
      const v = String(c.value(r) ?? '');
      return c.filter === 'select' ? v === f : norm(v).includes(norm(f));
    }));
    if (sort) {
      const c = columns.find((x) => x.key === sort.key);
      if (c) out = [...out].sort((a, b) => {
        const x = c.value(a); const y = c.value(b);
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * sort.dir;
        return String(x ?? '').localeCompare(String(y ?? ''), 'sr', { numeric: true }) * sort.dir;
      });
    }
    return out;
  }, [rows, columns, filters, sort]);
  const active = Object.values(filters).some(Boolean);
  const toggleSort = (key: string) => setSort((s) => (s?.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null));

  return (
    <div className="dt">
      <div className="dt-scroll">
        <table className={`tbl dt-table ${fit ? 'dt-fit' : ''} ${onRowClick || onRowDoubleClick ? 'clickable' : ''}`}>
          <thead>
            <tr className="dt-filters">
              {columns.map((c) => (
                <th key={c.key} className={c.optional ? `dt-opt${c.optional}` : undefined}>
                  {c.filter === false ? null : c.filter === 'select' ? (
                    <select className="dt-input" value={filters[c.key] ?? ''} onChange={(e) => setFilters({ ...filters, [c.key]: e.target.value })} aria-label={`Filter: ${c.label}`}>
                      <option value="">Sve</option>
                      {options[c.key]?.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input className="dt-input" value={filters[c.key] ?? ''} onChange={(e) => setFilters({ ...filters, [c.key]: e.target.value })}
                      style={{ textAlign: c.align }} aria-label={`Filter: ${c.label}`} />
                  )}
                </th>
              ))}
            </tr>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.optional ? `dt-opt${c.optional}` : undefined} style={{ width: c.width, textAlign: c.align }} title={c.label} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                  <button type="button" className="dt-sort" onClick={() => toggleSort(c.key)}>
                    {c.label}<span className="dt-arrow">{sort?.key === c.key ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={rowKey(r)} className={`${rowClass?.(r) ?? ''} ${selectedKey === rowKey(r) ? 'dt-sel' : ''}`}
                onClick={onRowClick ? () => onRowClick(r) : undefined} onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(r) : undefined}>
                {columns.map((c) => <td key={c.key} className={c.optional ? `dt-opt${c.optional}` : undefined} style={{ textAlign: c.align }}>{c.render ? c.render(r) : c.value(r)}</td>)}
              </tr>
            ))}
            {shown.length === 0 && <tr className="dt-empty"><td colSpan={columns.length}>{active ? 'Nijedan red ne odgovara filterima.' : empty}</td></tr>}
          </tbody>
          {footer && <tfoot>{footer}</tfoot>}
          {!footer && totals && shown.length > 0 && (() => { const t = totals(shown); return (
            <tfoot><tr className="dt-total">{columns.map((c, i) => <td key={c.key} className={c.optional ? `dt-opt${c.optional}` : undefined} style={{ textAlign: c.align }}>{t[c.key] ?? (i === columns.findIndex((x) => !x.optional) ? 'UKUPNO' : '')}</td>)}</tr></tfoot>
          ); })()}
        </table>
      </div>
      <div className="dt-foot">
        <span>{shown.length === rows.length ? redova(rows.length) : `${shown.length} od ${redova(rows.length)}`}</span>
        {active && <button type="button" className="btn ghost sm" onClick={() => setFilters({})}>Očisti filtere</button>}
        {actions && <div className="dt-actions">{actions}</div>}
      </div>
    </div>
  );
}
