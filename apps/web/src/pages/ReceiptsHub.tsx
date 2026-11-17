import { useState } from 'react';
import { api, fiscalText, fmt, fmtQty, newIdempotencyKey, Order, time } from '../api';
import { Empty, ErrorBox, Spinner, useLoad, useToast } from '../ui';
import { tableLabel } from './Tables';
import { VoidDialog } from './OrderScreen';
import { RefundFlow, TransferFlow } from './QtyFlows';
import { TransferDialog } from './MyShift';
import { ReceiptSlip } from '../ReceiptSlip';

export interface Viewer { token: string; name: string; userId: string; permissions: string[] }
const isRepresentation = (o: Order) => o.payments.length > 0 && o.payments.every((p) => p.method === 'REPRESENTATION');
const METHOD: Record<string, string> ={ CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Virman', REPRESENTATION: 'Reprezentacija' };

/** Status računa za kolonu u listi: otvoren (nije naplaćen), naplaćen, storniran (crveno). */
function statusOf(o: any): { cls: string; text: string } {
  if (o.status === 'PAID') return { cls: 'paid', text: 'Naplaćen' };
  if (o.status === 'CANCELLED') return { cls: 'void', text: 'Storniran' };
  return { cls: 'open', text: o.paidTotal !== '0.00' ? 'Delimično naplaćen' : 'Otvoren' };
}

/**
 * Pregled računa (posle PIN-a): svi računi dana u jednoj listi (status u posebnoj koloni, storno crveno),
 * desno sve što je bilo na izabranom stolu. Gore: Presek stanja / pazar (tabela + štampa + razduživanje), Prodati artikli.
 * Dole: Prebacivanje, Storniranje, Prebaci sve otvorene stolove, Otvori sto, Zatvori.
 */
export function ReceiptsHub({ viewer, onOpenOrder, onClose }: { viewer: Viewer; onOpenOrder: (id: string) => void; onClose: () => void }) {
  const toast = useToast();
  const { token } = viewer;
  const [sel, setSel] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'move' | 'transferAll' | 'void' | 'presek' | 'sold' | 'refund'>(null);
  // desno: stavke računa ili isečak tačno kao odštampan (naplaćen račun - podrazumevano isečak)
  const [view, setView] = useState<'items' | 'slip' | null>(null);

  const day = useLoad(() => api('GET', '/business-days/current', undefined, token), [token]);
  const list = useLoad(() => (day.data?.day
    ? api<any[]>('GET', `/orders?nonEmpty=true&pageSize=200&businessDayId=${day.data.day.id}`, undefined, token)
      .then((l) => l.filter((o) => o.status !== 'MERGED'))
    : Promise.resolve([] as any[])), [day.data?.day?.id, token]);
  const detail = useLoad(() => (sel ? api<Order>('GET', `/orders/${sel}`, undefined, token) : Promise.resolve(null)), [sel, token, list.data]);

  const rows = list.data ?? [];
  const selected = rows.find((o) => o.id === sel) ?? null;
  const myOpen = rows.filter((o) => o.status === 'OPEN' && o.waiterId === viewer.userId);
  const reload = () => { list.reload(); };

  const voidSelected = async (reason: string, approver: string, who: string) => {
    setDialog(null);
    try {
      const o = await api<Order>('GET', `/orders/${selected.id}`, undefined, token);
      await api('POST', `/orders/${o.id}/void-all`, { reason, expectedVersion: o.version }, approver);
      toast('ok', `Račun #${o.number} storniran (odobrio: ${who})`);
      reload();
    } catch (e: any) { toast('err', e.message); }
  };

  const o = detail.data && detail.data.id === sel ? detail.data : null;
  const v = view ?? (o?.status === 'PAID' ? 'slip' : 'items');
  return (
    <div className="kx-hub">
      <div className="kx-hub-head">
        <div className="kx-hub-title">Pregled računa <span>{viewer.name}</span></div>
        <button className="kx-hub-x" onClick={onClose} aria-label="Zatvori">✕</button>
      </div>
      <div className="kx-hub-tabs">
        <button className="kx-hub-print" onClick={() => setDialog('presek')}>PRESEK STANJA / PAZAR</button>
        <button className="kx-hub-print gray" onClick={() => setDialog('sold')}>PRODATI ARTIKLI</button>
        <span className="kx-hub-count">{rows.length} računa danas</span>
      </div>

      <div className="kx-hub-split">
        <div className="kx-hub-list">
          {day.data && !day.data.day && <div className="k-notice">Poslovni dan nije otvoren - nema računa za prikaz.</div>}
          {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> :
            rows.length === 0 ? <Empty>Nema računa.</Empty> : (
              <div className="kx-rows" role="listbox" aria-label="Računi">
                <div className="kx-row head" aria-hidden><span>#</span><span>Sto · konobar</span><span>Vreme</span><span>Status</span><span className="r">Iznos</span></div>
                {rows.map((r) => {
                  const st = statusOf(r);
                  return (
                    <button key={r.id} role="option" aria-selected={sel === r.id} className={`kx-row ${st.cls} ${sel === r.id ? 'sel' : ''}`} onClick={() => setSel(r.id)}>
                      <b>{r.number}</b>
                      <span className="kx-row-main">{r.tableName ? tableLabel(r.tableName) : 'Brza prodaja'}{r.tabName ? ` · ${r.tabName}` : ''}<small>{r.waiterName}</small></span>
                      <span className="kx-row-time">{time(r.openedAt)}{r.closedAt ? `-${time(r.closedAt)}` : ''}</span>
                      <span className={`kx-st ${st.cls}`}>{st.text}</span>
                      <strong>{fmt(r.total)}</strong>
                    </button>
                  );
                })}
              </div>
            )}
        </div>

        <aside className="kx-hub-detail" aria-label="Sadržaj računa">
          {!sel ? <div className="kx-detail-empty">Izaberite račun iz liste - ovde se vidi sve što je bilo na stolu.</div>
            : !o ? <Spinner /> : (
              <>
                <div className="kx-view" role="tablist">
                  <button role="tab" aria-selected={v !== 'slip'} className={v !== 'slip' ? 'on' : ''} onClick={() => setView('items')}>STAVKE</button>
                  <button role="tab" aria-selected={v === 'slip'} className={v === 'slip' ? 'on' : ''} onClick={() => setView('slip')}>ISEČAK</button>
                </div>
                {v === 'slip' ? <div className="kx-slip"><ReceiptSlip key={o.id + o.version} orderId={o.id} token={token} /></div> : <OrderDetail o={o} />}
              </>
            )}
        </aside>
      </div>

      <div className="kx-hub-actions">
        <button className="k-key blue" disabled={!o || o.status !== 'OPEN'} onClick={() => setDialog('move')}>PREBACIVANJE</button>
        <button className="k-key red" disabled={!selected || selected.status !== 'OPEN' || selected.paidTotal !== '0.00'} onClick={() => setDialog('void')}
          title="Storno nenaplaćenog računa uz PIN zaposlenog koji ima pravo storniranja">STORNIRANJE</button>
        <button className="k-key red" disabled={!o || o.status !== 'PAID' || isRepresentation(o)} onClick={() => setDialog('refund')}
          title={o && isRepresentation(o) ? 'Reprezentacija nije naplaćena - nema novca za povraćaj' : 'Povraćaj novca za naplaćen račun (ceo ili deo stavki), uz PIN menadžera'}>POVRAĆAJ</button>
        <button className="k-key blue" disabled={!myOpen.length} onClick={() => setDialog('transferAll')}>PREBACI SVE OTVORENE STOLOVE{myOpen.length ? ` (${myOpen.length})` : ''}</button>
        <button className="k-key blue" disabled={!selected || selected.status !== 'OPEN'} onClick={() => selected && onOpenOrder(selected.id)}>OTVORI STO</button>
        <button className="k-key red" onClick={onClose}>ZATVORI</button>
      </div>

      {dialog === 'move' && o && <TransferFlow order={o} token={token} onClose={() => setDialog(null)} onDone={(msg) => { setDialog(null); toast('ok', msg); reload(); }} />}
      {dialog === 'transferAll' && <TransferDialog orderIds={myOpen.map((x) => x.id)} token={token} excludeUserId={viewer.userId}
        onClose={() => setDialog(null)} onDone={(n, name) => { setDialog(null); toast('ok', `Prebačeno ${n} stolova na: ${name}`); reload(); }} />}
      {dialog === 'void' && selected && <VoidDialog title={`Storno računa #${selected.number}`} onClose={() => setDialog(null)} onConfirm={voidSelected} />}
      {dialog === 'refund' && o && <RefundFlow order={o} onClose={() => setDialog(null)} onDone={(msg) => { setDialog(null); toast('ok', msg); reload(); }} />}
      {dialog === 'presek' && <Presek token={token} name={viewer.name} openCount={myOpen.length} onClose={() => setDialog(null)} />}
      {dialog === 'sold' && <Sold token={token} canRead={viewer.permissions.includes('report.read')} day={day.data?.day} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Sve što je bilo na računu: stavke (stornirane precrtane), popust, naplate, fiskalni status. */
export function OrderDetail({ o }: { o: Order }) {
  const st = statusOf(o);
  // povraćaji novca (refundacije) ovog računa
  const rf = useLoad(() => (o.status === 'PAID' ? api<{ refunds: any[] }>('GET', `/orders/${o.id}/refunds`).then((x) => x.refunds).catch(() => []) : Promise.resolve([])), [o.id, o.version]);
  // reprezentacija (na kuću) je regularan račun - isti fiskalni prikaz kao svaki račun
  const fx = o.status === 'PAID' ? fiscalText(o.fiscal) : null;
  return (
    <div className="kx-detail">
      <div className={`kx-detail-head ${st.cls}`}>
        <b>{o.tableName ? tableLabel(o.tableName) : 'Brza prodaja'}{o.tabName ? ` · ${o.tabName}` : ''} - #{o.number}</b>
        <span>{st.text}</span>
      </div>
      <div className="kx-detail-meta">{o.waiterName} · {time(o.openedAt)}{o.closedAt ? ` - ${time(o.closedAt)}` : ''}</div>
      {fx && <div className="kx-detail-fiscal">{o.fiscal?.invoiceNumber ? `Broj: ${o.fiscal.invoiceNumber} · ` : ''}{fx.text}</div>}
      <div className="kx-detail-items">
        {o.items.map((i) => (
          <div key={i.id} className={`kx-detail-line ${i.status === 'VOIDED' ? 'void' : ''}`}>
            <span className="q">{fmtQty(i.quantity)}</span>
            <span className="n">{i.name}{i.note && <small>{i.note}</small>}{i.status === 'VOIDED' && <small className="why">storno: {i.voidReason}</small>}</span>
            <span className="s">{fmt(i.lineTotal)}</span>
          </div>
        ))}
      </div>
      <div className="kx-detail-sum">
        {o.discountTotal !== '0.00' && <div><span>Popust {o.discountPercent.replace(/\.00$/, '')}%</span><span>−{fmt(o.discountTotal)}</span></div>}
        <div className="total"><span>Ukupno</span><span>{fmt(o.total)}</span></div>
        {o.payments.map((p) => <div key={p.id}><span>{METHOD[p.method] ?? p.method}{p.method === 'REPRESENTATION' ? (p.note && p.note !== 'Reprezentacija' ? ` - ${p.note}` : '') : p.mode === 'TEST' ? ' (TEST)' : ''}</span><span>{fmt(p.amount)}</span></div>)}
        {o.status === 'OPEN' && <div className="due"><span>Za naplatu</span><span>{fmt(o.remaining)}</span></div>}
        {o.buyerId && <div><span>Kupac</span><span>{o.buyerIdLabel}: {o.buyerId}</span></div>}
        {(rf.data ?? []).map((r) => (
          <div key={r.id} className="refund" title={r.reason}><span>Povraćaj #{r.number} ({METHOD[r.method] ?? r.method}) · {r.items.map((i: any) => `${fmtQty(i.quantity)}× ${i.name}`).join(', ')}</span><span>−{fmt(r.total)}</span></div>
        ))}
      </div>
    </div>
  );
}

/** Presek stanja = pazar: jednostavna crno-bela tabela, štampa na štampaču kase i razduživanje. */
function Presek({ token, name, openCount, onClose }: { token: string; name: string; openCount: number; onClose: () => void }) {
  const toast = useToast();
  const cur = useLoad(() => api('GET', '/staff-shifts/current', undefined, token), [token]);
  const [busy, setBusy] = useState(false);
  const s = cur.data?.summary;
  const m = (k: string) => s?.collected.byMethod.find((x: any) => x.method === k)?.amount ?? '0.00';

  const print = async () => {
    setBusy(true);
    try {
      const r = await api('POST', '/staff-shifts/current/print', { idempotencyKey: newIdempotencyKey('pazar') }, token);
      toast('ok', r.job.status === 'PENDING' ? 'Pazar poslat na štampač kase' : `Štampa pazara: ${r.job.status}`);
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  const end = async () => {
    setBusy(true);
    try {
      await api('POST', '/staff-shifts/current/end', undefined, token);
      toast('ok', 'Razduženo - smena konobara je završena');
      await print();
      onClose();
    } catch (e: any) { toast('err', e.message); setBusy(false); }
  };

  return (
    <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kp wide" role="dialog" aria-modal="true" aria-label="Presek stanja">
        <div className="kp-title">Presek stanja - {name.split(' · ')[0]}</div>
        {cur.loading && !cur.data ? <Spinner /> : cur.error ? <ErrorBox error={cur.error} /> : !s ? (
          <div className="kp-hint">Nema otvorene smene - smena počinje prvim računom u otvorenom danu.</div>
        ) : (
          <>
            <div className="kp-hint">Od {time(s.startedAt)} · zatvorenih računa: {s.closedReceipts.count}</div>
            <table className="bw-table">
              <tbody>
                <tr><td>Gotovina</td><td className="num">{fmt(m('CASH'))}</td></tr>
                <tr><td>Kartica</td><td className="num">{fmt(m('CARD'))}</td></tr>
                <tr><td>Virman</td><td className="num">{fmt(m('TRANSFER'))}</td></tr>
                <tr><td>Reprezentacija</td><td className="num">{fmt(m('REPRESENTATION'))}</td></tr>
                <tr className="strong"><td>UKUPNO</td><td className="num">{fmt(s.collected.total)}</td></tr>
                <tr className="strong big"><td>ZA PREDAJU (gotovina)</td><td className="num">{fmt(s.collected.cashToHandOver)}</td></tr>
                {s.voids.count > 0 && <tr><td>Storna ({s.voids.count})</td><td className="num">{fmt(s.voids.amount)}</td></tr>}
              </tbody>
            </table>
            {openCount > 0 && <div className="kp-hint bad">Nenaplaćenih stolova: {openCount} - razduživanje nije moguće dok se ne naplate ili prebace.</div>}
          </>
        )}
        <div className="kp-actions three">
          <button className="kp-btn ok" disabled={busy || !s} onClick={print}>Štampaj</button>
          <button className="kp-btn go" disabled={busy || !s || openCount > 0} onClick={end}>Razduži se</button>
          <button className="kp-btn cancel" onClick={onClose}>Zatvori</button>
        </div>
      </div>
    </div>
  );
}

function Sold({ token, canRead, day, onClose }: { token: string; canRead: boolean; day: any; onClose: () => void }) {
  const r = useLoad(() => (canRead && day ? api('GET', `/reports/sales?from=${day.date}&to=${day.date}`, undefined, token) : Promise.resolve(null)), [token, day?.id]);
  return (
    <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kp wide" role="dialog" aria-modal="true" aria-label="Prodati artikli">
        <div className="kp-title">Prodati artikli - danas</div>
        {!canRead ? <div className="kp-hint">Nemate pravo na pregled prodatih artikala.</div>
          : r.loading && !r.data ? <Spinner /> : r.error ? <ErrorBox error={r.error} /> : !r.data ? <div className="kp-hint">Poslovni dan nije otvoren.</div> : (
            <div className="bw-scroll">
              <table className="bw-table">
                <tbody>
                  {r.data.byProduct.length === 0 && <tr><td>Nema prodaje.</td></tr>}
                  {r.data.byProduct.map((p: any) => <tr key={p.productId}><td>{p.name}</td><td className="num">{fmtQty(p.quantity)}</td><td className="num">{fmt(p.gross)}</td></tr>)}
                  <tr className="strong"><td>UKUPNO</td><td /><td className="num">{fmt(r.data.sales.gross)}</td></tr>
                </tbody>
              </table>
            </div>
          )}
        <div className="kp-actions"><span /><button className="kp-btn ok" onClick={onClose}>Zatvori</button></div>
      </div>
    </div>
  );
}
