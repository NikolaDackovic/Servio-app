import { useEffect, useMemo, useRef, useState } from 'react';
import { api, Category } from '@shared/api';
import { Spinner, useLoad } from '@shared/ui';

type Cat = Category & { prepStationId: string | null };

/** Kategorije (Šank, Kuhinja…) i njihove grupe; `only` = prikazati samo ove grupe (npr. one koje imaju robu). */
export function useGroupTree(only?: string[]) {
  const cats = useLoad(() => api<Cat[]>('GET', '/categories'), []);
  const stations = useLoad(() => api<{ id: string; name: string }[]>('GET', '/prep-stations').catch(() => []), []);
  const tree = useMemo(() => {
    const list = (cats.data ?? []).filter((c) => !only || only.includes(c.id));
    const st = [...(stations.data ?? []), { id: '', name: '(bez kategorije)' }];
    return st.map((s) => ({ id: s.id, name: s.name, groups: list.filter((c) => (c.prepStationId ?? '') === s.id || (!s.id && !st.some((x) => x.id && x.id === c.prepStationId))) }))
      .filter((s) => s.groups.length);
  }, [cats.data, stations.data, only?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return { tree, loading: !cats.data, cats: cats.data ?? [] };
}

/** Stablo sa kućicama: kategorija štiklira sve svoje grupe; ništa štiklirano = sve. */
export function GroupTree({ value, onChange, only, open: open0 = false }: { value: string[]; onChange: (ids: string[]) => void; only?: string[]; open?: boolean }) {
  const { tree, loading } = useGroupTree(only);
  const [open, setOpen] = useState<string[] | null>(null);
  const isOpen = (id: string) => (open === null ? open0 : open.includes(id));
  const toggleOpen = (id: string) => setOpen((o) => { const cur = o ?? (open0 ? tree.map((t) => t.id) : []); return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]; });
  const set = (ids: string[], on: boolean) => onChange(on ? [...new Set([...value, ...ids])] : value.filter((x) => !ids.includes(x)));
  if (loading) return <Spinner />;
  return (
    <div className="gtree" role="tree">
      {tree.map((t) => {
        const ids = t.groups.map((g) => g.id);
        const all = ids.every((x) => value.includes(x)), some = ids.some((x) => value.includes(x));
        return (
          <div key={t.id} role="treeitem" aria-expanded={isOpen(t.id)}>
            <div className="gtree-row">
              <button type="button" className="gtree-tg" onClick={() => toggleOpen(t.id)} aria-label={isOpen(t.id) ? 'Skupi' : 'Raširi'}>{isOpen(t.id) ? '−' : '+'}</button>
              <label className="check"><input type="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = some && !all; }} onChange={(e) => set(ids, e.target.checked)} /> <b>{t.name}</b></label>
            </div>
            {isOpen(t.id) && t.groups.map((g) => (
              <label key={g.id} className="check gtree-leaf"><input type="checkbox" checked={value.includes(g.id)} onChange={(e) => set([g.id], e.target.checked)} /> {g.name}</label>
            ))}
          </div>
        );
      })}
      {!tree.length && <small className="muted">Nema grupa.</small>}
    </div>
  );
}

/** Dugme "Grupe ▾" sa stablom u padajućem panelu (ne zauzima mesto na ekranu). */
export function GroupFilter({ value, onChange, only }: { value: string[]; onChange: (ids: string[]) => void; only?: string[] }) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setShow(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="gfilter" ref={ref}>
      <button type="button" className={`btn ${value.length ? 'primary' : ''}`} onClick={() => setShow(!show)} aria-expanded={show}>
        Kategorije i grupe: {value.length ? `izabrano ${value.length}` : 'sve'} ▾
      </button>
      {show && (
        <div className="gfilter-pop">
          <GroupTree value={value} onChange={onChange} only={only} open />
          <div className="gfilter-foot">
            <button type="button" className="btn sm" onClick={() => onChange([])}>Sve grupe</button>
            <button type="button" className="btn sm primary" onClick={() => setShow(false)}>Gotovo</button>
          </div>
        </div>
      )}
    </div>
  );
}
