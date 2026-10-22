import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, fmt } from '@shared/api';
import { useAuth } from '@shared/auth';
import { Empty, ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { DOC_KIND_LABEL, DOC_STATUS_LABEL, fq, Partner, ProductPicker, Warehouse } from './stockShared';
import { ImportPanel } from './ImportExport';

interface DocLine { id?: string; productId: string; code: string; name: string; unit: string; quantity: string; unitCost: string | null; bookQuantity?: string | null; difference?: string | null; value?: string | null; note?: string | null }
interface Doc {
  id: string; kind: string; kindLabel: string; status: 'DRAFT' | 'POSTED' | 'CANCELLED'; number: number | null; displayNumber: string | null;
  warehouseId: string; warehouseName: string; targetWarehouseId: string | null; targetWarehouseName: string | null;
  partnerId: string | null; partnerName: string | null; docDate: string; externalNumber: string | null; note: string | null; version: number;
  createdByName: string; postedAt: string | null; cancelledAt: string | null; cancelReason: string | null; lines: DocLine[]; total: string;
}
interface DocRow { id: string; kind: string; kindLabel: string; status: string; displayNumber: string | null; docDate: string; warehouseName: string; partnerName: string | null; lineCount: number; externalNumber: string | null }

export function Documents() {
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useLoad(() => api<{ data: DocRow[]; total: number }>('GET', `/stock/documents?pageSize=100${kind ? `&kind=${kind}` : ''}${status ? `&status=${status}` : ''}`), [kind, status]);
  if (open) return <DocEditor id={open} onBack={() => { setOpen(null); list.reload(); }} />;
  return (
    <div className="page">
      <div className="toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>Robna dokumenta</h2>
        <button className="btn primary" onClick={() => setCreating(true)}>+ Novi dokument</button>
      </div>
      <div className="toolbar">
        <select className="input" style={{ maxWidth: 240 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Sve vrste</option>{Object.entries(DOC_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" style={{ maxWidth: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Svi statusi</option>{Object.entries(DOC_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Spinner /> : !list.data.data.length ? <Empty>Nema dokumenata.</Empty> : (
        <table className="tbl clickable">
          <thead><tr><th>Broj</th><th>Vrsta</th><th>Datum</th><th>Skladište</th><th>Partner</th><th>Br. fakture</th><th className="num">Stavki</th><th>Status</th></tr></thead>
          <tbody>{list.data.data.map((d) => (
            <tr key={d.id} onClick={() => setOpen(d.id)}>
              <td><strong>{d.displayNumber ?? '—'}</strong></td><td>{DOC_KIND_LABEL[d.kind]}</td><td>{d.docDate.split('-').reverse().join('.')}</td>
              <td>{d.warehouseName}</td><td>{d.partnerName ?? ''}</td><td>{d.externalNumber ?? ''}</td><td className="num">{d.lineCount}</td>
              <td><span className={`badge ${d.status === 'POSTED' ? 'paid' : d.status === 'CANCELLED' ? 'cancelled' : ''}`}>{DOC_STATUS_LABEL[d.status]}</span></td>
            </tr>))}
          </tbody>
        </table>
      )}
      {creating && <NewDoc onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
    </div>
  );
}

function NewDoc({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const whs = useLoad(() => api<Warehouse[]>('GET', '/warehouses'), []);
  const ps = useLoad(() => api<Partner[]>('GET', '/partners'), []);
  const [f, setF] = useState({ kind: 'RECEIPT', warehouseId: '', targetWarehouseId: '', partnerId: '', docDate: '', externalNumber: '' });
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (whs.data && !f.warehouseId) setF((x) => ({ ...x, warehouseId: whs.data!.find((w) => w.isDefault)?.id ?? whs.data![0]?.id ?? '' }));
  }, [whs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(undefined);
    const body: any = { kind: f.kind, warehouseId: f.warehouseId };
    if (f.kind === 'TRANSFER') body.targetWarehouseId = f.targetWarehouseId || null;
    if (f.partnerId) body.partnerId = f.partnerId;
    if (f.docDate) body.docDate = f.docDate;
    if (f.externalNumber.trim()) body.externalNumber = f.externalNumber.trim();
    try { onCreated((await api('POST', '/stock/documents', body)).id); } catch (err) { setError(err); }
  };
  const active = whs.data?.filter((w) => w.active) ?? [];
  return (
    <Modal title="Novi robni dokument" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Vrsta<select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {Object.entries(DOC_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>{f.kind === 'TRANSFER' ? 'Iz skladišta' : 'Skladište'}<select className="input" value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}>
          {active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        {f.kind === 'TRANSFER' && (
          <label>U skladište<select className="input" value={f.targetWarehouseId} onChange={(e) => setF({ ...f, targetWarehouseId: e.target.value })} required>
            <option value="">— izaberite —</option>
            {active.filter((w) => w.id !== f.warehouseId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        )}
        {['RECEIPT', 'RETURN', 'ISSUE'].includes(f.kind) && (
          <label>Partner{f.kind !== 'ISSUE' ? ' (obavezno pri knjiženju)' : ''}<select className="input" value={f.partnerId} onChange={(e) => setF({ ...f, partnerId: e.target.value })}>
            <option value="">— izaberite —</option>{ps.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.taxId ? ` (${p.taxId})` : ''}</option>)}</select></label>
        )}
        <div className="grid2">
          <label>Datum dokumenta<input className="input" type="date" value={f.docDate} onChange={(e) => setF({ ...f, docDate: e.target.value })} /><small className="muted">prazno = danas</small></label>
          {['RECEIPT', 'RETURN'].includes(f.kind) && <label>Broj fakture dobavljača<input className="input" value={f.externalNumber} onChange={(e) => setF({ ...f, externalNumber: e.target.value })} maxLength={60} /></label>}
        </div>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Otkaži</button><button className="btn primary" disabled={!f.warehouseId}>Napravi nacrt</button></div>
      </form>
    </Modal>
  );
}

/**
 * Editor dokumenta. Nacrt: stavke se menjaju lokalno i čuvaju dugmetom „Sačuvaj stavke“; knjiženje traži sačuvane stavke.
 * Proknjižen dokument je samo za čitanje; storno pravi suprotna kretanja.
 */
function DocEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const d = useLoad(() => api<Doc>('GET', `/stock/documents/${id}`), [id]);
  const [lines, setLines] = useState<DocLine[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [cancelling, setCancelling] = useState(false);
  const [importing, setImporting] = useState(false);
  useEffect(() => { if (d.data) { setLines(d.data.lines); setDirty(false); } }, [d.data]);
  if (d.error) return <div className="page"><ErrorBox error={d.error} onRetry={d.reload} /></div>;
  if (!d.data || !lines) return <Spinner />;
  const doc = d.data;
  const draft = doc.status === 'DRAFT';
  const isStocktake = doc.kind === 'STOCKTAKE';
  const needsCost = doc.kind === 'RECEIPT';

  const upd = (i: number, patch: Partial<DocLine>) => { setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l))); setDirty(true); };
  const run = async (fn: () => Promise<Doc>, msg: string) => {
    setBusy(true); setError(undefined);
    try { const r = await fn(); d.setData(r); toast('ok', msg); } catch (e) { setError(e); if ((e as ApiError).code === 'STALE_DOCUMENT') d.reload(); } finally { setBusy(false); }
  };
  const save = () => run(() => api('PUT', `/stock/documents/${id}/lines`, {
    expectedVersion: doc.version,
    lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity.replace(',', '.'), unitCost: l.unitCost ? l.unitCost.replace(',', '.') : null, note: l.note || null })),
  }), 'Stavke sačuvane');
  const postDoc = () => run(() => api('POST', `/stock/documents/${id}/post`, { expectedVersion: doc.version }), 'Dokument proknjižen');
  const fill = () => run(() => api('POST', `/stock/documents/${id}/fill-stocktake`, {}), 'Dodati su svi artikli sa zalihom (predlog = knjižno stanje)');
  const qtyOk = (q: string) => /^\d{1,11}([.,]\d{1,4})?$/.test(q);
  const invalid = lines.some((l) => !qtyOk(l.quantity) || (needsCost && !(l.unitCost && qtyOk(l.unitCost))));
  let localTotal = 0;
  for (const l of lines) if (l.unitCost && qtyOk(l.unitCost) && qtyOk(l.quantity)) localTotal += Number(l.quantity.replace(',', '.')) * Number(l.unitCost.replace(',', '.'));

  return (
    <div className="page">
      <div className="toolbar">
        <button className="btn" onClick={() => { if (!dirty || confirm('Izmene stavki nisu sačuvane. Napustiti?')) onBack(); }}>← Dokumenta</button>
        <h2 style={{ margin: 0, flex: 1 }}>{doc.kindLabel} {doc.displayNumber ?? '(nacrt)'}</h2>
        <span className={`badge ${doc.status === 'POSTED' ? 'paid' : doc.status === 'CANCELLED' ? 'cancelled' : ''}`}>{DOC_STATUS_LABEL[doc.status]}</span>
      </div>
      <div className="card small">
        <div>Skladište: <strong>{doc.warehouseName}</strong>{doc.targetWarehouseName && <> → <strong>{doc.targetWarehouseName}</strong></>}
          {doc.partnerName && <> · Partner: <strong>{doc.partnerName}</strong></>}{doc.externalNumber && <> · Faktura: {doc.externalNumber}</>}
          {' '}· Datum: {doc.docDate.split('-').reverse().join('.')} · Napravio: {doc.createdByName}</div>
        {doc.postedAt && <div>Proknjižen: {new Date(doc.postedAt).toLocaleString('sr-Latn-RS')}</div>}
        {doc.cancelledAt && <div className="warn-text">Storniran {new Date(doc.cancelledAt).toLocaleString('sr-Latn-RS')}: {doc.cancelReason}</div>}
        {draft && ['RECEIPT', 'RETURN'].includes(doc.kind) && !doc.partnerId && <div className="warn-text">Partner nije izabran — knjiženje neće biti dozvoljeno.</div>}
      </div>

      {draft && (
        <div className="toolbar">
          <div style={{ flex: 1, minWidth: 260 }}>
            <ProductPicker exclude={lines.map((l) => l.productId)}
              onPick={(p) => { setLines([...lines, { productId: p.id, code: p.code, name: p.name, unit: p.unit, quantity: isStocktake ? '0' : '1', unitCost: null }]); setDirty(true); }} />
          </div>
          {isStocktake && <button className="btn" disabled={busy || dirty} onClick={fill} title={dirty ? 'Prvo sačuvajte stavke' : ''}>Dodaj sve artikle sa zalihom</button>}
          <button className="btn" onClick={() => setImporting(true)} disabled={dirty}>Uvoz stavki (CSV/XLSX)</button>
        </div>
      )}

      {lines.length === 0 ? <Empty>Dokument nema stavki.</Empty> : (
        <table className="tbl">
          <thead><tr>
            <th>Šifra</th><th>Artikal</th><th>JM</th>
            {isStocktake && !draft && <th className="num">Knjižno</th>}
            <th className="num">{isStocktake ? 'Izbrojano' : 'Količina'}</th>
            {isStocktake && !draft && <th className="num">Razlika</th>}
            {(needsCost || !draft || isStocktake) && <th className="num">{needsCost ? 'Nabavna cena' : 'Cena'}</th>}
            {!draft && <th className="num">Vrednost</th>}
            {draft && <th />}
          </tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={l.productId}>
              <td><code>{l.code}</code></td><td>{l.name}</td><td>{l.unit}</td>
              {isStocktake && !draft && <td className="num">{fq(l.bookQuantity)}</td>}
              <td className="num">{draft
                ? <input className={`input num ${qtyOk(l.quantity) ? '' : 'invalid'}`} style={{ maxWidth: 120 }} inputMode="decimal" value={l.quantity} onChange={(e) => upd(i, { quantity: e.target.value })} />
                : fq(l.quantity)}</td>
              {isStocktake && !draft && <td className={`num ${l.difference?.startsWith('-') ? 'warn-text' : ''}`}>{fq(l.difference)}</td>}
              {(needsCost || !draft || isStocktake) && <td className="num">{draft && (needsCost || isStocktake)
                ? <input className={`input num ${!l.unitCost && needsCost ? 'invalid' : ''}`} style={{ maxWidth: 120 }} inputMode="decimal" value={l.unitCost ?? ''} placeholder={isStocktake ? 'PPNC' : ''} onChange={(e) => upd(i, { unitCost: e.target.value || null })} />
                : fq(l.unitCost)}</td>}
              {!draft && <td className="num">{l.value ? fmt(l.value) : '—'}</td>}
              {draft && <td><button className="btn sm danger-ghost" onClick={() => { setLines(lines.filter((_, j) => j !== i)); setDirty(true); }}>Ukloni</button></td>}
            </tr>))}
            <tr className="strong"><td colSpan={3}>Ukupno ({lines.length} stavki)</td><td colSpan={8} className="num">{draft ? (needsCost ? fmt(localTotal.toFixed(2)) : '') : fmt(doc.total)}</td></tr>
          </tbody>
        </table>
      )}
      {isStocktake && draft && <p className="muted small">Popis: unesite izbrojanu količinu. Pri knjiženju se beleži knjižno stanje u tom trenutku i knjiže se samo razlike (višak po unetoj ceni ili PPNC, manjak po PPNC).</p>}
      {error !== undefined && <ErrorBox error={error} />}
      <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
        {draft && <button className="btn" disabled={busy || !dirty || invalid} onClick={save}>Sačuvaj stavke</button>}
        {draft && can('stock.post') && <button className="btn primary" disabled={busy || dirty || !lines.length} title={dirty ? 'Prvo sačuvajte stavke' : ''} onClick={() => confirm(`Proknjižiti ${doc.kindLabel.toLowerCase()}? Posle knjiženja dokument se ne menja (samo storno).`) && postDoc()}>Proknjiži</button>}
        {doc.status !== 'CANCELLED' && can('stock.post') && <button className="btn danger-ghost" disabled={busy} onClick={() => setCancelling(true)}>{draft ? 'Odbaci nacrt' : 'Storniraj'}</button>}
      </div>
      {cancelling && <CancelDialog draft={draft} onClose={() => setCancelling(false)} onDone={(r) => { setCancelling(false); d.setData(r); toast('ok', draft ? 'Nacrt odbačen' : 'Dokument storniran'); }} id={id} />}
      {importing && <Modal title="Uvoz stavki u nacrt" onClose={() => setImporting(false)} wide>
        <ImportPanel entity="document-lines" documentId={id} onDone={() => { setImporting(false); d.reload(); }} />
      </Modal>}
    </div>
  );
}

function CancelDialog({ id, draft, onClose, onDone }: { id: string; draft: boolean; onClose: () => void; onDone: (d: Doc) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { onDone(await api('POST', `/stock/documents/${id}/cancel`, { reason: reason.trim() })); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={draft ? 'Odbacivanje nacrta' : 'Storno dokumenta'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {!draft && <p>Storno pravi suprotna kretanja po istim cenama; kartica ostaje potpuna. Ako je roba u međuvremenu potrošena, storno će biti odbijen.</p>}
        <label>Razlog<input className="input" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required /></label>
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Nazad</button><button className="btn danger" disabled={busy || reason.trim().length < 3}>{draft ? 'Odbaci' : 'Storniraj'}</button></div>
      </form>
    </Modal>
  );
}
