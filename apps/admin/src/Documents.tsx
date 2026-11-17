import { useState } from 'react';
import { api, fmt } from '@shared/api';
import { useAuth } from '@shared/auth';
import { ErrorBox, Spinner, useLoad } from '@shared/ui';
import { DOC_STATUS_LABEL } from './stockShared';
import { Column, DataTable } from './DataTable';
import { DOC_KINDS } from './DocScreen';
import { useTab } from './tabs';

interface DocRow { id: string; kind: string; status: string; displayNumber: string | null; docDate: string; warehouseName: string; partnerName: string | null; lineCount: number; externalNumber: string | null; total?: string; createdByName?: string }

/** Pregled dokumenata: svi robni dokumenti; dvoklik otvara dokument u novom tabu, "Novi" pravi dokument izabrane vrste. */
export function Documents() {
  const tab = useTab();
  const { can } = useAuth();
  const list = useLoad(() => api<{ data: DocRow[]; total: number }>('GET', '/stock/documents?pageSize=2000'), []);
  const [sel, setSel] = useState<string | null>(null);
  const [kind, setKind] = useState('RECEIPT');
  const open = (d: DocRow) => tab.open(`docid:${d.id}`, `${DOC_KINDS[d.kind]?.short ?? ''} ${d.displayNumber ? d.displayNumber.replace(/^[A-Z]+-/, '') : '(nacrt)'}`);
  const columns: Column<DocRow>[] = [
    { key: 'no', label: 'Broj', value: (d) => d.displayNumber ?? '', render: (d) => (d.displayNumber ? <span className="doc-code">{d.displayNumber}</span> : <span className="muted">nacrt</span>), width: 110 },
    { key: 'kind', label: 'Vrsta', value: (d) => DOC_KINDS[d.kind]?.title ?? d.kind, filter: 'select' },
    { key: 'date', label: 'Datum prometa', value: (d) => d.docDate, render: (d) => d.docDate.split('-').reverse().join('.'), width: 120 },
    { key: 'wh', label: 'Magacin', value: (d) => d.warehouseName, filter: 'select' },
    { key: 'partner', label: 'Partner', value: (d) => d.partnerName ?? '', filter: 'select' },
    { key: 'ext', label: 'Broj dokumenta', value: (d) => d.externalNumber ?? '' },
    { key: 'lines', label: 'Stavki', value: (d) => d.lineCount, align: 'right', width: 70 },
    ...(list.data?.data.some((d) => d.total !== undefined) ? [{ key: 'total', label: 'Iznos', value: (d: DocRow) => Number(d.total ?? 0), render: (d: DocRow) => (d.total ? fmt(d.total) : ''), align: 'right' } as Column<DocRow>] : []),
    { key: 'status', label: 'Status', value: (d) => DOC_STATUS_LABEL[d.status], filter: 'select', width: 110,
      render: (d) => <span className={`badge ${d.status === 'POSTED' ? 'paid' : d.status === 'CANCELLED' ? 'cancelled' : 'open'}`}>{DOC_STATUS_LABEL[d.status]}</span> },
  ];
  const selected = list.data?.data.find((d) => d.id === sel);
  return (
    <div className="page wide fill">
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Spinner /> : (
        <DataTable columns={columns} rows={list.data.data} rowKey={(d) => d.id} selectedKey={sel} onRowClick={(d) => setSel(d.id)} onRowDoubleClick={open}
          rowClass={(d) => (d.status === 'CANCELLED' ? 'inactive' : undefined)} empty="Nema dokumenata." />
      )}
      <div className="bar">
        <div className="bar-left">
          {can('stock.write') && <>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Vrsta novog dokumenta">
              {Object.entries(DOC_KINDS).map(([k, v]) => <option key={k} value={k}>{v.title}</option>)}
            </select>
            <button className="btn primary" onClick={() => tab.open(`doc:${kind}`)}>+ Novi</button>
          </>}
        </div>
        <div className="bar-right">
          <button className="btn" onClick={list.reload}>Osveži</button>
          <button className="btn primary" disabled={!selected} onClick={() => selected && open(selected)}>Otvori</button>
          <button className="btn" onClick={tab.close}>Zatvori</button>
        </div>
      </div>
    </div>
  );
}
