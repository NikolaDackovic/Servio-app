import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, Table } from '@shared/api';
import { ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { floorBg, floorSize, tableLabel, TableTile } from '@shared/pages/Tables';
import { TableQr } from './TableQr';

const GRID = 10;
const snap = (v: number) => Math.round(v / GRID) * GRID;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const natural = (a: string, b: string) => a.localeCompare(b, 'sr', { numeric: true });

type Drag = { id: string; mode: 'move' | 'resize'; x0: number; y0: number; t0: Table };

/** Slika pozadine prostorije: umanjena na najviše 1600 tačaka, JPEG (podešavanje dozvoljava do ~900 KB po prostoriji). */
export async function imageToDataUrl(file: File, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('Fajl nije slika')); i.src = url; });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.82, 0.7, 0.55, 0.4]) { const d = c.toDataURL('image/jpeg', q); if (d.length < 1_150_000) return d; }
    throw new Error('Slika je prevelika');
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Mapa stolova (kao u Octopos-u): gore dugmad (pozadina, dodavanje i brisanje stolova i mapa) i mape (SALA, BAŠTA…),
 * levo spisak svih stolova sa kućicama ("Dodaj izabrane stolove" ih prebacuje na ovu mapu), desno sala - stolovi se
 * prevlače mišem ili prstom, ugao dole desno menja veličinu, dvoklik ili desni klik otvara podešavanja stola.
 * Raspored se čuva dugmetom "Sačuvaj raspored" (jedna transakcija). Kasa prikazuje isti crtež (TableTile).
 */
export function TableMap() {
  const [qrOpen, setQrOpen] = useState(false);
  const toast = useToast();
  const list = useLoad(() => api<Table[]>('GET', '/tables'), []);
  const [local, setLocal] = useState<Table[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [extraAreas, setExtraAreas] = useState<string[]>([]);
  const [area, setArea] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<null | 'newArea' | 'renameArea' | 'addRange'>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const bgInput = useRef<HTMLInputElement>(null);
  const settings = useLoad(() => api<{ floorBackgrounds: Record<string, string> }>('GET', '/settings/kasa'), []);
  const backgrounds = settings.data?.floorBackgrounds ?? {};
  useEffect(() => { if (list.data) { setLocal(list.data); setDirty(new Set()); } }, [list.data]);

  // isti redosled prostorija kao na kasi: prva je ona sa najnižim stolom
  const areas = useMemo(() => [...new Set([...[...local].sort((a, b) => natural(a.name, b.name)).map((t) => t.area), ...extraAreas])], [local, extraAreas]);
  const current = areas.includes(area) ? area : areas[0] ?? 'Sala';
  const inArea = local.filter((t) => t.area === current).sort((a, b) => natural(a.name, b.name));
  const editing = local.find((t) => t.id === editId) ?? null;
  const allSorted = [...local].sort((a, b) => natural(a.name, b.name)).filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase()));

  // Skaliranje na širinu radnog prostora
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBoxW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  });
  const size = floorSize(inArea);
  const scale = boxW ? Math.min(1.3, (boxW - 24) / size.w) : 1;

  // Prevlačenje i promena veličine (pointer events: miš, olovka i prst)
  const drag = useRef<Drag | null>(null);
  const onDown = (e: React.PointerEvent, t: Table, mode: Drag['mode']) => {
    if (e.button === 2) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: t.id, mode, x0: e.clientX, y0: e.clientY, t0: t };
    setSelId(t.id);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x0) / scale, dy = (e.clientY - d.y0) / scale;
    const patch = d.mode === 'move'
      ? { posX: clamp(snap(d.t0.posX + dx), 0, 5000), posY: clamp(snap(d.t0.posY + dy), 0, 5000) }
      : { width: clamp(snap(d.t0.width + dx), 40, 600), height: clamp(snap(d.t0.height + dy), 40, 600) };
    setLocal((l) => l.map((t) => (t.id === d.id ? { ...t, ...patch } : t)));
    setDirty((s) => (s.has(d.id) ? s : new Set(s).add(d.id)));
  };
  const onUp = () => { drag.current = null; };

  // Strelice pomeraju izabrani sto (Shift = veći korak)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!selId || editId || (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      const step = e.shiftKey ? 50 : GRID;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      setLocal((l) => l.map((t) => (t.id === selId ? { ...t, posX: clamp(t.posX + d[0], 0, 5000), posY: clamp(t.posY + d[1], 0, 5000) } : t)));
      setDirty((s) => new Set(s).add(selId));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selId, editId]);

  const saveLayout = async () => {
    setSaving(true);
    try {
      const tables = local.filter((t) => dirty.has(t.id)).map(({ id, posX, posY, width, height }) => ({ id, posX, posY, width, height }));
      await api('PUT', '/tables/layout', { tables });
      setDirty(new Set());
      toast('ok', `Raspored sačuvan (${tables.length} stolova). Kase ga vide posle dugmeta Osveži.`);
    } catch (e: any) { toast('err', e.message); } finally { setSaving(false); }
  };
  const discard = () => { if (list.data) { setLocal(list.data); setDirty(new Set()); } };

  /** Izmena jednog stola (naziv, prostorija, mesta, oblik, veličina) - odmah se čuva. */
  const patchTable = async (t: Table, patch: Partial<Table>) => {
    try {
      const r = await api<Table>('PATCH', `/tables/${t.id}`, patch);
      setLocal((l) => l.map((x) => (x.id === t.id ? { ...x, ...r } : x)));
      if (patch.area && patch.area !== current) setArea(patch.area);
      toast('ok', 'Sto sačuvan'); setEditId(null);
      return true;
    } catch (e: any) { toast('err', e.message); return false; }
  };
  const removeTable = async (t: Table) => {
    if (!window.confirm(`Obrisati sto "${t.name}"? Istorija računa ostaje sačuvana.`)) return;
    try {
      await api('DELETE', `/tables/${t.id}`);
      setLocal((l) => l.filter((x) => x.id !== t.id));
      setSelId(null); setEditId(null);
      toast('ok', `Sto "${t.name}" obrisan`);
    } catch (e: any) { toast('err', e.message); }
  };
  /** sledeće slobodno mesto u mreži mape (redovi od po 7 stolova, ispod postojećih) */
  const slots = (count: number, w: number, h: number) => {
    const y0 = inArea.length ? Math.max(...inArea.map((t) => t.posY + t.height)) + 40 : 40;
    return Array.from({ length: count }, (_, i) => ({ posX: 40 + (i % 7) * (w + 60), posY: clamp(snap(y0 + Math.floor(i / 7) * (h + 60)), 0, 5000) }));
  };
  /** Dodaj stolove od-do (npr. 1-20): "Sto 1"… na ovu mapu, preskaču se postojeći nazivi. */
  const addRange = async (from: number, to: number, shape: Table['shape']) => {
    setDialog(null); setBusy(true);
    const names = Array.from({ length: to - from + 1 }, (_, i) => `Sto ${from + i}`).filter((n) => !local.some((t) => t.name.toLowerCase() === n.toLowerCase()));
    const w = shape === 'ROUND' ? 110 : 120, h = shape === 'ROUND' ? 110 : 90;
    const pos = slots(names.length, w, h);
    let added = 0;
    try {
      for (const [i, name] of names.entries()) {
        const t = await api<Table>('POST', '/tables', { name, area: current, shape, seats: 4, ...pos[i], width: w, height: h });
        setLocal((l) => [...l.filter((x) => x.id !== t.id), { ...t, status: 'FREE', openOrders: [] }]);
        added++;
      }
      setExtraAreas((a) => a.filter((x) => x !== current));
      toast('ok', `Dodato stolova: ${added}${names.length < to - from + 1 ? ` (postojeći nazivi preskočeni)` : ''}`);
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  /** Dodaj izabrane stolove: štiklirani stolovi (sa drugih mapa) prelaze na ovu mapu. */
  const addChecked = async () => {
    const ts = local.filter((t) => checked.includes(t.id) && t.area !== current);
    if (!ts.length) { toast('err', 'Štiklirajte stolove levo (sa drugih mapa)'); return; }
    setBusy(true);
    const pos = slots(ts.length, 120, 90);
    try {
      for (const [i, t] of ts.entries()) {
        const r = await api<Table>('PATCH', `/tables/${t.id}`, { area: current, ...pos[i] });
        setLocal((l) => l.map((x) => (x.id === t.id ? { ...x, ...r } : x)));
      }
      setChecked([]); setExtraAreas((a) => a.filter((x) => x !== current));
      toast('ok', `Na mapu ${current} prebačeno stolova: ${ts.length}`);
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  /** Obriši sve stolove ove mape (stolovi sa otvorenim računom ostaju). */
  const removeAll = async (andMap = false) => {
    const busyT = inArea.filter((t) => t.openOrders.length);
    if (!window.confirm(andMap ? `Obrisati mapu "${current}" i svih ${inArea.length} stolova na njoj?` : `Obrisati svih ${inArea.length} stolova sa mape "${current}"? Istorija računa ostaje.`)) return;
    setBusy(true);
    try {
      for (const t of inArea.filter((x) => !x.openOrders.length)) { await api('DELETE', `/tables/${t.id}`); setLocal((l) => l.filter((x) => x.id !== t.id)); }
      if (andMap && !busyT.length) {
        if (backgrounds[current]) await setBackground(null, true);
        setExtraAreas((a) => a.filter((x) => x !== current)); setArea('');
      }
      toast(busyT.length ? 'err' : 'ok', busyT.length ? `Stolovi sa otvorenim računom nisu obrisani: ${busyT.map((t) => t.name).join(', ')}` : andMap ? 'Mapa obrisana' : 'Stolovi obrisani');
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); setSelId(null); }
  };
  const renameArea = async (name: string) => {
    setDialog(null);
    if (!name || name === current) return;
    if (!inArea.length) { setExtraAreas((a) => a.map((x) => (x === current ? name : x))); setArea(name); return; }
    try {
      for (const t of inArea) await api('PATCH', `/tables/${t.id}`, { area: name });
      setLocal((l) => l.map((t) => (t.area === current ? { ...t, area: name } : t)));
      if (backgrounds[current]) {
        const next = { ...backgrounds, [name]: backgrounds[current] }; delete next[current];
        settings.setData(await api('PUT', '/settings/kasa', { floorBackgrounds: next }));
      }
      setArea(name);
      toast('ok', `Mapa preimenovana u "${name}"`);
    } catch (e: any) { toast('err', e.message); list.reload(); }
  };
  /** Pozadina mape (slika sale, bašte…) - čuva se odmah, kasa je vidi posle Osveži. */
  const setBackground = async (file?: File | null, quiet = false, forArea = current) => {
    try {
      const next = { ...backgrounds };
      if (file) next[forArea] = await imageToDataUrl(file); else delete next[forArea];
      settings.setData(await api('PUT', '/settings/kasa', { floorBackgrounds: next }));
      if (!quiet) toast('ok', file ? 'Pozadina sačuvana' : 'Pozadina uklonjena');
    } catch (e: any) { toast('err', e.message); }
  };
  const nextNo = () => { const nums = local.map((t) => /^sto\s*(\d+)$/i.exec(t.name)?.[1]).filter(Boolean).map(Number); return nums.length ? Math.max(...nums) + 1 : 1; };

  if (list.loading && !list.data) return <Spinner />;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;

  return (
    <div className="page wide tm2">
      {qrOpen && <TableQr onClose={() => setQrOpen(false)} />}
      <div className="tm2-bar">
        <button className="tm2-btn" onClick={() => bgInput.current?.click()}>Postavi<br />pozadinu</button>
        <input ref={bgInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void setBackground(e.target.files?.[0]); e.target.value = ''; }} />
        <button className="tm2-btn" disabled={!backgrounds[current]} onClick={() => void setBackground(null)}>Ukloni<br />pozadinu</button>
        <button className="tm2-btn" disabled={busy || !checked.length} onClick={() => void addChecked()}>Dodaj izabrane<br />stolove</button>
        <button className="tm2-btn" disabled={busy} onClick={() => setDialog('addRange')}>Dodaj<br />stolove</button>
        <button className="tm2-btn" disabled={busy || !inArea.length} onClick={() => void removeAll()}>Obriši sve<br />stolove</button>
        <button className="tm2-btn" onClick={() => setDialog('newArea')}>Dodaj<br />mapu</button>
        <button className="tm2-btn" disabled={busy || !areas.length} onClick={() => void removeAll(true)}>Obriši<br />mapu</button>
        <div className="tm2-maps">
          {areas.map((a) => <button key={a} className={`tm2-map ${a === current ? 'on' : ''}`} onClick={() => { setArea(a); setSelId(null); }} onDoubleClick={() => { setArea(a); setDialog('renameArea'); }} title="Dvoklik = preimenuj">{a}</button>)}
        </div>
        <div className="tm2-right">
          <button className="btn" onClick={() => setQrOpen(true)} title="Gosti skeniraju kod na stolu i naručuju sa telefona">QR kodovi</button>
          <button className="btn" disabled={!dirty.size || saving} onClick={discard}>Poništi</button>
          <button className="btn primary" disabled={!dirty.size || saving} onClick={saveLayout}>{saving ? 'Čuvam…' : `Sačuvaj raspored${dirty.size ? ` (${dirty.size})` : ''}`}</button>
        </div>
      </div>

      <div className="tm2-body">
        <aside className="tm2-list">
          <input className="input" placeholder="Sto…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Traži sto" />
          <div className="tm2-scroll">
            <table className="tbl grid">
              <thead><tr><th>Sto</th><th>Mapa</th><th><input type="checkbox" aria-label="Svi" checked={allSorted.length > 0 && allSorted.every((t) => checked.includes(t.id))} onChange={(e) => setChecked(e.target.checked ? allSorted.map((t) => t.id) : [])} /></th></tr></thead>
              <tbody>{allSorted.map((t) => (
                <tr key={t.id} className={selId === t.id ? 'dt-sel' : ''} onClick={() => { setArea(t.area); setSelId(t.id); }} onDoubleClick={() => setEditId(t.id)}>
                  <td>{tableLabel(t.name)}</td><td className="muted">{t.area}</td>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={checked.includes(t.id)} onChange={() => setChecked(checked.includes(t.id) ? checked.filter((x) => x !== t.id) : [...checked, t.id])} /></td>
                </tr>))}
              </tbody>
            </table>
          </div>
        </aside>
        <div className="tm-canvas" ref={boxRef} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className={floorBg(backgrounds[current]).className} style={{ ...floorBg(backgrounds[current]).style, width: size.w * scale, height: size.h * scale }} onPointerDown={() => setSelId(null)}>
            {inArea.map((t) => (
              <div key={t.id} className={`tm-item ${selId === t.id ? 'sel' : ''} ${dirty.has(t.id) ? 'dirty' : ''}`}
                style={{ left: t.posX * scale, top: t.posY * scale, width: t.width * scale, height: t.height * scale }}
                onPointerDown={(e) => onDown(e, t, 'move')} onDoubleClick={() => setEditId(t.id)} onContextMenu={(e) => { e.preventDefault(); setSelId(t.id); setEditId(t.id); }}>
                <TableTile t={t} scale={scale} style={{ left: 0, top: 0 }} />
                <span className="tm-handle" onPointerDown={(e) => onDown(e, t, 'resize')} aria-label="Promena veličine" />
              </div>
            ))}
            {inArea.length === 0 && <div className="tm-empty">Mapa je prazna - „Dodaj stolove“ ili štiklirajte stolove levo pa „Dodaj izabrane stolove“.</div>}
          </div>
        </div>
      </div>
      <p className="tm2-hint">ⓘ Desni klik ili dvoklik na sto - podešavanja stola (naziv, mesta, oblik, boja, brisanje). Dvoklik na mapu - preimenovanje. Strelice pomeraju izabrani sto.</p>

      {editing && <Modal title={`Sto: ${editing.name}`} onClose={() => setEditId(null)}>
        <TablePanel key={editing.id} t={editing} areas={areas} onSave={(p) => patchTable(editing, p)} onDelete={() => removeTable(editing)} dirty={dirty.has(editing.id)} />
      </Modal>}
      {dialog === 'newArea' && <NewMapDialog onClose={() => setDialog(null)} exists={(n) => areas.includes(n)}
        onSave={async (n, file) => { setExtraAreas((a) => (areas.includes(n) ? a : [...a, n])); setArea(n); setSelId(null); setDialog(null); if (file) await setBackground(file, false, n); }} />}
      {dialog === 'renameArea' && <NameDialog title={`Preimenovanje mape: ${current}`} label="Novi naziv" initial={current} onClose={() => setDialog(null)} onSave={renameArea} />}
      {dialog === 'addRange' && <AddRangeDialog from={nextNo()} area={current} onClose={() => setDialog(null)} onSave={(a, b, s) => void addRange(a, b, s)} />}
    </div>
  );
}

/** Nova mapa: naziv i (opciono) slika pozadine odmah pri dodavanju. */
function NewMapDialog({ onClose, onSave, exists }: { onClose: () => void; onSave: (name: string, file: File | null) => void; exists: (n: string) => boolean }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => { if (!file) { setPreview(null); return; } const u = URL.createObjectURL(file); setPreview(u); return () => URL.revokeObjectURL(u); }, [file]);
  return (
    <Modal title="Nova mapa" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim(), file); }}>
        <label>Naziv (npr. SALA, BAŠTA, GALERIJA)<input className="input" autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        {exists(name.trim()) && <small className="err-text">Mapa sa tim nazivom već postoji.</small>}
        <label>Pozadina - slika sale (opciono)
          <input type="file" className="input" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {preview && <img className="tm2-preview" src={preview} alt="pozadina" />}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
          <button className="btn primary" disabled={!name.trim() || exists(name.trim())}>Dodaj mapu</button>
        </div>
      </form>
    </Modal>
  );
}

/** Dodavanje više stolova odjednom: od broja do broja (Sto 1 … Sto 20), oblik. */
function AddRangeDialog({ from, area, onClose, onSave }: { from: number; area: string; onClose: () => void; onSave: (a: number, b: number, s: Table['shape']) => void }) {
  const [a, setA] = useState(String(from));
  const [b, setB] = useState(String(from));
  const [shape, setShape] = useState<Table['shape']>('RECT');
  const na = Number(a), nb = Number(b);
  const ok = na >= 1 && nb >= na && nb - na < 100;
  return (
    <Modal title={`Dodaj stolove - ${area}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(na, nb, shape); }}>
        <div className="grid2 tight">
          <label>Od stola broj<input className="input" autoFocus inputMode="numeric" value={a} onChange={(e) => setA(e.target.value.replace(/\D/g, ''))} /></label>
          <label>Do stola broj<input className="input" inputMode="numeric" value={b} onChange={(e) => setB(e.target.value.replace(/\D/g, ''))} /></label>
        </div>
        <div className="seg">
          <button type="button" className={`seg-btn ${shape === 'RECT' ? 'on' : ''}`} onClick={() => setShape('RECT')}>Pravougaoni</button>
          <button type="button" className={`seg-btn ${shape === 'ROUND' ? 'on' : ''}`} onClick={() => setShape('ROUND')}>Okrugli</button>
        </div>
        <small className="muted">{ok ? `Biće dodato ${nb - na + 1} stolova (Sto ${na}${nb > na ? ` … Sto ${nb}` : ''}) na mapu ${area}; postojeći nazivi se preskaču.` : 'Najviše 100 stolova odjednom.'}</small>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
          <button className="btn primary" disabled={!ok}>Dodaj</button>
        </div>
      </form>
    </Modal>
  );
}

const TABLE_COLORS = ['#7c4422', '#3b3b3b', '#f4f1ea', '#2f7bc4', '#1f8a5b', '#b8322c', '#d98e04', '#6b3fa0'];

function TablePanel({ t, areas, onSave, onDelete, dirty }: { t: Table; areas: string[]; onSave: (p: Partial<Table>) => Promise<boolean>; onDelete: () => void; dirty: boolean }) {
  const [f, setF] = useState({ name: t.name, area: t.area, seats: String(t.seats), shape: t.shape, width: String(t.width), height: String(t.height), color: t.color ?? '', isRoom: !!t.isRoom });
  const [busy, setBusy] = useState(false);
  const w = Number(f.width), h = Number(f.height), seats = Number(f.seats);
  const ok = f.name.trim() && f.area.trim() && w >= 40 && w <= 600 && h >= 40 && h <= 600 && seats >= 1 && seats <= 50;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onSave({ name: f.name.trim(), area: f.area.trim(), seats, shape: f.shape, width: w, height: h, color: f.color || null, isRoom: f.isRoom });
    setBusy(false);
  };
  return (
    <form className="form" onSubmit={submit}>
      {t.openOrders.length > 0 && <div className="notice">Na stolu je otvoren račun.</div>}
      <label>Naziv (prikaz na kasi: „Sto 8“ → 008)<input className="input" value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>Prostorija
        <input className="input" list="tm-areas" value={f.area} maxLength={40} onChange={(e) => setF({ ...f, area: e.target.value })} />
        <datalist id="tm-areas">{areas.map((a) => <option key={a} value={a} />)}</datalist>
      </label>
      <label>Broj mesta<input className="input" inputMode="numeric" value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value.replace(/\D/g, '') })} /></label>
      <label>Oblik
        <div className="seg">
          <button type="button" className={`seg-btn ${f.shape === 'RECT' ? 'on' : ''}`} onClick={() => setF({ ...f, shape: 'RECT' })}>Pravougaoni</button>
          <button type="button" className={`seg-btn ${f.shape === 'ROUND' ? 'on' : ''}`} onClick={() => setF({ ...f, shape: 'ROUND' })}>Okrugli</button>
        </div>
      </label>
      <div className="grid2 tight">
        <label>Širina<input className="input" inputMode="numeric" value={f.width} onChange={(e) => setF({ ...f, width: e.target.value.replace(/\D/g, '') })} /></label>
        <label>Visina<input className="input" inputMode="numeric" value={f.height} onChange={(e) => setF({ ...f, height: e.target.value.replace(/\D/g, '') })} /></label>
      </div>
      <label>Boja stola
        <div className="tm-colors">
          <button type="button" className={`tm-color none ${!f.color ? 'on' : ''}`} title="Podrazumevana (drvo)" onClick={() => setF({ ...f, color: '' })} />
          {TABLE_COLORS.map((c) => <button key={c} type="button" className={`tm-color ${f.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setF({ ...f, color: c })} />)}
          <input type="color" className="tm-color-pick" value={f.color || '#7c4422'} onChange={(e) => setF({ ...f, color: e.target.value })} />
        </div>
      </label>
      <label className="check"><input type="checkbox" checked={f.isRoom} onChange={(e) => setF({ ...f, isRoom: e.target.checked })} /> Hotelska soba (račun može ostati otvoren preko zatvaranja smene i dana)</label>
      <small className="muted">Pozicija: {t.posX}, {t.posY}{dirty ? ' - raspored nije sačuvan' : ''}</small>
      <div className="modal-actions">
        <button type="button" className="btn danger-ghost" onClick={onDelete} disabled={t.openOrders.length > 0}>Obriši sto</button>
        <button className="btn primary" disabled={busy || !ok}>Sačuvaj sto</button>
      </div>
    </form>
  );
}

/** Mali prozor za unos naziva (prostorija, cenovnik, uloga). */
export function NameDialog({ title, label, initial = '', onClose, onSave }: { title: string; label: string; initial?: string; onClose: () => void; onSave: (n: string) => void }) {
  const [name, setName] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
        <label>{label}<input className="input" autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
          <button className="btn primary" disabled={!name.trim()}>Potvrdi</button>
        </div>
      </form>
    </Modal>
  );
}
