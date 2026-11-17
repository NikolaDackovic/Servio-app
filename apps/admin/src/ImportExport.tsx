import { useRef, useState } from 'react';
import { api } from '@shared/api';
import { ErrorBox, useToast } from '@shared/ui';
import { download, fileToBase64, saveBlob } from './stockShared';

type Entity = 'products' | 'partners' | 'document-lines';
const LABEL: Record<Entity, string> = { products: 'Artikli', partners: 'Partneri', 'document-lines': 'Stavke dokumenta' };

interface Preview {
  total: number; valid: number; invalid: number; creates: number; updates: number; format: string;
  columns: { key: string; label: string; present: boolean; required: boolean }[]; ignoredColumns: string[];
  rows: { row: number; values: Record<string, string>; action: 'create' | 'update' | null; errors: string[] }[];
  newCategories?: string[];
}

/** Uvoz: izbor fajla → pregled (šta će se desiti, greške po redovima) → potvrda. */
export function ImportPanel({ entity, documentId, onDone }: { entity: Entity; documentId?: string; onDone?: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const input = useRef<HTMLInputElement>(null);
  const [createCategories, setCreateCategories] = useState(false);
  const runPreview = async (f: { name: string; content: string }, cc = createCategories) =>
    setPreview(await api('POST', `/import/${entity}/preview`, { fileName: f.name, content: f.content, documentId, ...(entity === 'products' ? { createCategories: cc } : {}) }));
  const toggleCats = async (v: boolean) => {
    setCreateCategories(v);
    if (file) { setBusy(true); setError(undefined); try { await runPreview(file, v); } catch (e) { setError(e); } finally { setBusy(false); } }
  };

  const choose = async (f: File | undefined) => {
    setPreview(null); setResult(null); setError(undefined);
    if (!f) return;
    setBusy(true);
    try {
      const content = await fileToBase64(f);
      setFile({ name: f.name, content });
      await runPreview({ name: f.name, content });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const commit = async (skipInvalid: boolean) => {
    if (!file) return;
    setBusy(true); setError(undefined);
    try {
      const r = await api('POST', `/import/${entity}/commit`, { fileName: file.name, content: file.content, documentId, skipInvalid, ...(entity === 'products' ? { createCategories } : {}) });
      setResult(r); setPreview(null); toast('ok', `Uvoz završen: novih ${r.created}, izmenjenih ${r.updated}${r.skipped.length ? `, preskočeno ${r.skipped.length}` : ''}`);
      onDone?.();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const errorReport = (rows: { row: number; errors: string[] }[]) => {
    const csv = '﻿Red;Greška\r\n' + rows.flatMap((r) => r.errors.map((e) => `${r.row};"${e.replace(/"/g, '""')}"`)).join('\r\n');
    saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `greske-uvoza-${entity}.csv`);
  };

  return (
    <div>
      <div className="toolbar">
        <input ref={input} type="file" accept=".csv,.xlsx,.txt" onChange={(e) => choose(e.target.files?.[0])} />
        <button className="btn sm" onClick={() => download(`/import/${entity}/template?format=xlsx`).catch((e) => toast('err', e.message))}>Šablon XLSX</button>
        {entity === 'products' && <label className="check" title="Za prelazak sa drugog programa: grupe iz fajla se prave same">
          <input type="checkbox" checked={createCategories} onChange={(e) => void toggleCats(e.target.checked)} /> Napravi grupe koje ne postoje</label>}
        <button className="btn sm" onClick={() => download(`/import/${entity}/template?format=csv`).catch((e) => toast('err', e.message))}>Šablon CSV</button>
      </div>
      {busy && <p className="muted">Obrada…</p>}
      {error !== undefined && <ErrorBox error={error} />}
      {preview && (
        <>
          <div className={`notice ${preview.invalid ? 'warn' : ''}`}>
            {preview.total} redova: <strong>{preview.valid} ispravnih</strong> ({preview.creates} novih, {preview.updates} izmena), <strong>{preview.invalid} sa greškom</strong>.
            {preview.ignoredColumns.length > 0 && <> Kolone koje se ne koriste: {preview.ignoredColumns.join(', ')}.</>}
            {!!preview.newCategories?.length && <> Nove grupe: <strong>{preview.newCategories.join(', ')}</strong>.</>}
          </div>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Red</th><th>Akcija</th>{preview.columns.filter((c) => c.present).map((c) => <th key={c.key}>{c.label}</th>)}<th>Greške</th></tr></thead>
              <tbody>{preview.rows.map((r) => (
                <tr key={r.row} className={r.errors.length ? 'row-error' : ''}>
                  <td>{r.row}</td><td>{r.errors.length ? '-' : r.action === 'update' ? 'izmena' : 'novo'}</td>
                  {preview.columns.filter((c) => c.present).map((c) => <td key={c.key}>{r.values[c.key]}</td>)}
                  <td className="warn-text small">{r.errors.join('; ')}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
          <div className="toolbar" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            {preview.invalid > 0 && <button className="btn" onClick={() => errorReport(preview.rows.filter((r) => r.errors.length))}>Preuzmi izveštaj grešaka (CSV)</button>}
            <button className="btn" onClick={() => { setPreview(null); setFile(null); if (input.current) input.current.value = ''; }}>Otkaži</button>
            {preview.invalid > 0 && preview.valid > 0 && <button className="btn" disabled={busy} onClick={() => confirm(`Uvesti ${preview.valid} ispravnih redova i preskočiti ${preview.invalid} neispravnih?`) && commit(true)}>Uvezi ispravne, preskoči {preview.invalid}</button>}
            <button className="btn primary" disabled={busy || preview.invalid > 0} title={preview.invalid ? 'Fajl ima greške' : ''} onClick={() => commit(false)}>Uvezi sve ({preview.valid})</button>
          </div>
        </>
      )}
      {result && (
        <div className="notice ok">
          Uvoz završen: {result.created} novih, {result.updated} izmenjenih{result.skipped.length > 0 && <>, <strong>{result.skipped.length} preskočeno</strong> (redovi {result.skipped.map((s: any) => s.row).join(', ')}) <button className="btn sm" onClick={() => errorReport(result.skipped)}>Izveštaj</button></>}.
        </div>
      )}
    </div>
  );
}

export function ImportExport() {
  const toast = useToast();
  const [entity, setEntity] = useState<Exclude<Entity, 'document-lines'>>('products');
  const exp = (what: string, format: string) => download(`/export/${what}?format=${format}`).catch((e) => toast('err', e.message));
  return (
    <div className="page">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Izvoz</h3>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-start', gap: 8 }}>
          {[['products', 'Artikli'], ['partners', 'Partneri'], ['stock-balances', 'Stanje lagera']].map(([k, l]) => (
            <span key={k} className="row" style={{ gap: 4 }}><strong style={{ alignSelf: 'center' }}>{l}:</strong>
              <button className="btn sm" onClick={() => exp(k, 'xlsx')}>XLSX</button><button className="btn sm" onClick={() => exp(k, 'csv')}>CSV</button></span>
          ))}
        </div>
        <p className="muted small">CSV koristi „;“ i decimalni zarez (Excel sa srpskim podešavanjima), UTF-8 sa BOM-om. Izvezen fajl artikala može ponovo da se uvede.</p>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Uvoz</h3>
        <div className="seg">
          {(['products', 'partners'] as const).map((e) => <button key={e} className={`seg-btn ${entity === e ? 'on' : ''}`} onClick={() => setEntity(e)}>{LABEL[e]}</button>)}
        </div>
        <p className="muted small">
          {entity === 'products'
            ? 'Postojeći artikal (ista šifra) se menja, novi se dodaje. Kategorija i PDV oznaka moraju već postojati. Promena cene se beleži u istoriji cena.'
            : 'Partner sa istim PIB-om se menja; bez PIB-a se uvek dodaje novi. PIB se proverava kontrolnom cifrom.'}
          {' '}Ako fajl ima grešaka, ništa se ne uvozi - osim ako izričito izaberete da se neispravni redovi preskoče.
        </p>
        <ImportPanel key={entity} entity={entity} />
      </div>
      <p className="muted small">Stavke robnih dokumenata (šifra, količina, nabavna cena) uvoze se iz samog dokumenta: Robna dokumenta → nacrt → „Uvoz stavki“.</p>
    </div>
  );
}
