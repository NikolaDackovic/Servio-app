import { useEffect, useState } from 'react';
import { api, fmt, newIdempotencyKey, Order } from '@shared/api';
import { ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { RefundFlow, StornoFlow } from '@shared/pages/QtyFlows';
import { ReceiptSlip } from './ReceiptSlip';
import { tableLabel } from '@shared/pages/Tables';
import { Column, DataTable } from './DataTable';
import { n2, useDayRange } from './dayRange';
import { useTab } from './tabs';

const METHOD: Record<string, string> = { CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Virman', REPRESENTATION: 'Reprezentacija' };
const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('sr-Latn-RS', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
type Tri = 'all' | 'yes' | 'no';
const TRI: [Tri, string][] = [['all', 'Svi računi'], ['yes', 'Da'], ['no', 'Ne']];

/**
 * Pretraga računa (kao u Octopos-u): levo smene, Pronađi, korisnici, stolovi, otvoreni/storno/fiskalni, tip računa i isečak
 * izabranog računa; desno tabela (boja = status), u dnu prosek i zbir; dugmad Storniranje, Promeni način plaćanja, Kopija.
 */
export function AdminReceipts() {
  const toast = useToast();
  const tab = useTab();
  const range = useDayRange(3);
  const [q, setQ] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const list = useLoad(() => (q ? api<any[]>('GET', q).then((l) => l.filter((o) => o.status !== 'MERGED')) : Promise.resolve(null)), [q, run]);
  // prva pretraga čim se učita poslednja smena
  useEffect(() => { if (!q && range.ids.length) setQ(`/orders?dayIds=${range.ids.join(',')}&nonEmpty=true&pageSize=5000`); }, [range.ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const find = () => { if (range.ids.length) { setQ(`/orders?dayIds=${range.ids.join(',')}&nonEmpty=true&pageSize=5000`); setRun((x) => x + 1); } };
  const [openF, setOpenF] = useState<Tri>('all');
  const [stornoF, setStornoF] = useState<Tri>('all');
  const [fiscalF, setFiscalF] = useState<Tri>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'pay' | 'storno' | null>(null);
  const detail = useLoad(() => (sel ? api<Order>('GET', `/orders/${sel}`) : Promise.resolve(null)), [sel]);

  const all = list.data ?? [];
  const tname = (o: any) => (o.tableName ? tableLabel(o.tableName) : 'brzi');
  const isRep = (o: any) => (o.methods ?? '') === 'REPRESENTATION';
  const tri = (v: Tri, b: boolean) => v === 'all' || (v === 'yes') === b;
  const rows = all.filter((o) => tri(openF, o.status === 'OPEN') && tri(stornoF, o.status === 'CANCELLED') && tri(fiscalF, !!o.fiscalNumber));
  const o = detail.data;
  const rep = !!o && o.payments.length > 0 && o.payments.every((x) => x.method === 'REPRESENTATION');
  const isPaid = o?.status === 'PAID';
  const reload = () => { detail.reload(); setRun((x) => x + 1); };
  const copy = async () => {
    if (!o) return;
    try { await api('POST', `/orders/${o.id}/print-receipt`, { idempotencyKey: newIdempotencyKey('copy') }); toast('ok', 'Kopija računa je poslata na štampač kase'); }
    catch (e: any) { toast('err', e.message); }
  };
  const paidRows = (rs: any[]) => rs.filter((r) => r.status === 'PAID');
  const columns: Column<any>[] = [
    { key: 'st', label: '', value: (r) => r.status, render: (r) => <span className={`rx-dot ${r.status === 'CANCELLED' ? 'red' : r.status === 'OPEN' ? 'yellow' : 'green'}`} title={r.status === 'CANCELLED' ? 'Storniran' : r.status === 'OPEN' ? 'Otvoren' : 'Naplaćen'} />, filter: false, width: 16 },
    { key: 'no', label: 'Originalni broj', value: (r) => r.number, align: 'right', width: 58 },
    { key: 'fis', label: 'Broj fiskalnog isečka', value: (r) => r.fiscalNumber ?? '', optional: 2 },
    { key: 'kind', label: 'Tip računa', value: (r) => (isRep(r) ? 'REPREZENTACIJA' : 'PROMET'), filter: 'select', width: 96, optional: 3 },
    { key: 'table', label: 'Sto', value: (r) => tname(r), render: (r) => `${tname(r)}${r.tabName ? `, ${r.tabName}` : ''}`, filter: 'select', width: 70, optional: 3 },
    { key: 'user', label: 'Korisnik', value: (r) => r.waiterName, filter: 'select' },
    { key: 'created', label: 'Vreme kreiranja', value: (r) => r.openedAt, render: (r) => dt(r.openedAt), filter: false, width: 132, optional: 3 },
    { key: 'printed', label: 'Vreme štampanja', value: (r) => r.printedAt ?? '', render: (r) => dt(r.printedAt), filter: false, width: 132, optional: 1 },
    { key: 'disc', label: 'Popust', value: (r) => (r.discountPercent && r.discountPercent !== '0.00' ? `${Number(r.discountPercent)}%` : ''), filter: 'select', width: 64, optional: 2 },
    { key: 'buyer', label: 'Komitent', value: (r) => r.buyerId ?? '', optional: 1 },
    { key: 'pay', label: 'Način plaćanja', value: (r) => (r.methods ?? '').split(',').filter(Boolean).map((m: string) => METHOD[m] ?? m).join(', '), filter: 'select', width: 100 },
    { key: 'qty', label: 'Količina', value: (r) => Number(r.itemQty ?? 0), render: (r) => n2(Number(r.itemQty ?? 0)), align: 'right', filter: false, width: 70, optional: 2 },
    { key: 'total', label: 'Iznos', value: (r) => Number(r.total), render: (r) => <b>{fmt(r.total)}</b>, align: 'right', filter: false, width: 88 },
  ];

  return (
    <div className="page wide side-layout rx2">
      <aside className="side">
        {range.ui}
        <button className="btn primary side-find" disabled={!range.ids.length || list.loading} onClick={find}>{list.loading ? 'Tražim…' : 'Pronađi'}</button>
        <div className="rx-tri">
          {([['Otvoreni', openF, setOpenF], ['Storno', stornoF, setStornoF], ['Fiskalni', fiscalF, setFiscalF]] as [string, Tri, (v: Tri) => void][]).map(([l, v, set]) => (
            <label key={l}>{l}<select className="input" value={v} onChange={(e) => set(e.target.value as Tri)}>{TRI.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
          ))}
        </div>
        <div className="rx-slip">
          {!sel ? <small className="muted">Izaberite račun u tabeli - ovde se vidi isečak.</small> : <ReceiptSlip key={sel + run} orderId={sel} />}
        </div>
      </aside>
      <div className="side-main fill">
        {list.error ? <ErrorBox error={list.error} onRetry={reload} /> : list.loading && !list.data ? <Spinner /> : (
          <DataTable fit columns={columns} rows={rows} rowKey={(r) => r.id} selectedKey={sel} onRowClick={(r) => setSel(r.id)}
            rowClass={(r) => (r.status === 'CANCELLED' ? 'storno' : undefined)} empty="Nema računa za izabrane filtere."
            totals={(rs) => { const p = paidRows(rs), t = p.reduce((a, r) => a + Number(r.total), 0); return {
              user: <b>Prosek: {n2(p.length ? t / p.length : 0)}</b>, qty: <b>{n2(rs.reduce((a, r) => a + Number(r.itemQty ?? 0), 0))}</b>, total: <b>{n2(t)}</b> }; }} />
        )}
        <div className="bar">
          <div className="bar-left">
            <button className="btn danger-ghost" disabled={!o || (!(isPaid && !rep) && o.status !== 'OPEN')} onClick={() => setDialog('storno')}>Storniranje</button>
            <button className="btn" disabled={!isPaid || rep} onClick={() => setDialog('pay')} title="Npr. greškom kartica - prebaci na gotovinu">Promeni način plaćanja</button>
            <button className="btn" disabled={!isPaid} onClick={copy} title="Štampa KOPIJE na štampaču kase na kojoj je račun izdat">Kopija fiskalnog računa</button>
          </div>
          <div className="bar-right"><button className="btn" onClick={tab.close}>Zatvori</button></div>
        </div>
      </div>
      {dialog === 'pay' && o && <PayChange o={o} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); toast('ok', 'Način plaćanja je promenjen'); }} />}
      {dialog === 'storno' && o && o.status === 'PAID' && <RefundFlow order={o} onClose={() => setDialog(null)} onDone={(m) => { setDialog(null); reload(); toast('ok', m); }} />}
      {dialog === 'storno' && o && o.status === 'OPEN' && <StornoFlow order={o} onClose={() => setDialog(null)} onDone={(_, m) => { setDialog(null); reload(); toast('ok', m); }} />}
    </div>
  );
}

const PAY: [string, string][] = [['CASH', 'Gotovina'], ['CARD', 'Kartica'], ['TRANSFER', 'Virman']];
const AMOUNT_RE = /^[0-9]*([.,][0-9]{0,2})?$/;

/** Promena načina plaćanja: mala tabela iznosa po načinu (npr. kartica 4.000 → gotovina 4.000); zbir mora ostati isti. */
function PayChange({ o, onClose, onDone }: { o: Order; onClose: () => void; onDone: () => void }) {
  const total = o.payments.reduce((a, x) => a + Number(x.amount), 0);
  const init = Object.fromEntries(PAY.map(([m]) => [m, o.payments.filter((x) => x.method === m).reduce((a, x) => a + Number(x.amount), 0)]));
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(PAY.map(([m]) => [m, init[m] ? init[m].toFixed(2).replace('.', ',') : ''])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const n = (s: string) => Number((s || '0').replace(',', '.'));
  const sum = PAY.reduce((a, [m]) => a + n(v[m]), 0);
  const ok = Math.abs(sum - total) < 0.005 && PAY.every(([m]) => AMOUNT_RE.test(v[m]));
  const all = (m: string) => setV(Object.fromEntries(PAY.map(([k]) => [k, k === m ? total.toFixed(2).replace('.', ',') : ''])));
  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      await api('POST', `/orders/${o.id}/payments/change`, { parts: PAY.filter(([m]) => n(v[m]) > 0).map(([m]) => ({ method: m, amount: n(v[m]).toFixed(2) })) });
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Način plaćanja - račun #${o.number}`} onClose={onClose}>
      <div className="form">
        <table className="tbl pay-change">
          <thead><tr><th>Način</th><th className="num">Sada</th><th className="num">Novo</th><th /></tr></thead>
          <tbody>{PAY.map(([m, l]) => (
            <tr key={m}>
              <td><b>{l}</b></td>
              <td className="num">{init[m] ? fmt(init[m].toFixed(2)) : ''}</td>
              <td className="num"><input className="input num" inputMode="decimal" value={v[m]} placeholder="0,00" onChange={(e) => setV({ ...v, [m]: e.target.value })} /></td>
              <td><button type="button" className="btn sm" onClick={() => all(m)} title={`Ceo iznos: ${l}`}>Sve</button></td>
            </tr>
          ))}</tbody>
          <tfoot><tr><td>Ukupno</td><td className="num">{fmt(total.toFixed(2))}</td><td className={`num ${ok ? '' : 'err-text'}`}><b>{fmt(sum.toFixed(2))}</b></td><td /></tr></tfoot>
        </table>
        {!ok && <p className="err-text small">Zbir mora biti {fmt(total.toFixed(2))}.</p>}
        <p className="muted small">Dozvoljeno dok su dan i smena otvoreni. Fiskalizovan račun se menja povraćajem i novim računom.</p>
        {err !== undefined && <ErrorBox error={err} />}
        <div className="modal-actions">
          <button className="btn primary" disabled={busy || !ok} onClick={save}>{busy ? 'Čuvam…' : 'Potvrdi'}</button>
          <button className="btn" onClick={onClose}>Odustani</button>
        </div>
      </div>
    </Modal>
  );
}
