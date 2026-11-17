import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, fmt, fmtQty, Order, OrderItem, storage, Table } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Keypad, KeypadDialog, Spinner, useLoad } from '../ui';
import { floorSize, TableTile, tableLabel } from './Tables';

export type Pick = { item: OrderItem; qty: string };
const toNum = (s: string) => Number(s.replace(',', '.')) || 0;
const natural = (a: string, b: string) => a.localeCompare(b, 'sr', { numeric: true });

/**
 * Izbor količina: stavke redom, prazna kolona za količinu; dodir na red pa numerička tastatura desno.
 * "Izaberi sve" upisuje cele količine (npr. Kisela voda 5, Espresso 1), "Poništi" briše sve.
 */
function QtyPick({ title, items, confirmLabel, onCancel, onNext }: {
  title: string; items: OrderItem[]; confirmLabel: string; onCancel: () => void; onNext: (picks: Pick[]) => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [cur, setCur] = useState<string | null>(items[0]?.id ?? null);
  const current = items.find((i) => i.id === cur) ?? null;
  const over = items.filter((i) => toNum(vals[i.id] ?? '') > toNum(i.quantity));
  const picks = items.filter((i) => toNum(vals[i.id] ?? '') > 0).map((i) => ({ item: i, qty: String(toNum(vals[i.id])) }));
  const ok = picks.length > 0 && over.length === 0;
  return (
    <div className="kp-back">
      <div className="k-qp" role="dialog" aria-modal="true" aria-label={title}>
        <div className="kp-title">{title}</div>
        <div className="k-qp-body">
          <div className="k-qp-list" role="listbox" aria-label="Stavke">
            <div className="k-qp-row head"><span>Artikal</span><span>Kol.</span><span>{confirmLabel}</span></div>
            {items.map((i) => (
              <button key={i.id} type="button" role="option" aria-selected={cur === i.id}
                className={`k-qp-row ${cur === i.id ? 'cur' : ''} ${over.includes(i) ? 'bad' : ''}`} onClick={() => setCur(i.id)}>
                <span className="n">{i.name}{i.note && <small>{i.note}</small>}</span>
                <span className="q">{fmtQty(i.quantity)}</span>
                <span className="v">{vals[i.id] ? vals[i.id].replace('.', ',') : ''}</span>
              </button>
            ))}
          </div>
          <div className="k-qp-pad">
            <div className="k-qp-cur">{current ? <>{current.name}: <b>{vals[current.id]?.replace('.', ',') || '-'}</b> / {fmtQty(current.quantity)}</> : 'Izaberite stavku'}</div>
            <Keypad value={current ? vals[current.id] ?? '' : ''} disabled={!current} onChange={(v) => {
              if (!current) return;
              const d = v.indexOf('.');
              if (d >= 0 && v.length - d > 4) return;
              setVals((x) => ({ ...x, [current.id]: v }));
            }} />
            <div className="k-qp-sel">
              <button type="button" className="kp-btn ok" onClick={() => setVals(Object.fromEntries(items.map((i) => [i.id, String(toNum(i.quantity))])))}>IZABERI SVE</button>
              <button type="button" className="kp-btn plain" onClick={() => setVals({})}>PONIŠTI</button>
            </div>
          </div>
        </div>
        {over.length > 0 && <div className="kp-hint bad">Količina je veća od one na stolu: {over.map((i) => i.name).join(', ')}</div>}
        <div className="k-qp-actions">
          <button type="button" className="kp-btn go" disabled={!ok} onClick={() => onNext(picks)}>{confirmLabel.toUpperCase()}</button>
          <button type="button" className="kp-btn cancel" onClick={onCancel}>OTKAŽI</button>
        </div>
      </div>
    </div>
  );
}

/** Mapa stolova za izbor odredišta (isti crtež kao početna), po prostorijama. */
function TablePicker({ current, token, onCancel, onPick }: { current: string | null; token?: string; onCancel: () => void; onPick: (t: Table) => void }) {
  const tables = useLoad(() => api<Table[]>('GET', '/tables', undefined, token), [token]);
  const sorted = useMemo(() => [...(tables.data ?? [])].sort((a, b) => natural(a.name, b.name)), [tables.data]);
  const areas = [...new Set(sorted.map((t) => t.area))];
  const [area, setArea] = useState('');
  const cur = areas.includes(area) ? area : (sorted.find((t) => t.id === current)?.area ?? areas[0]);
  const inArea = sorted.filter((t) => t.area === cur);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  });
  const size = floorSize(inArea);
  const scale = box.w && box.h ? Math.min(box.w / size.w, box.h / size.h) : 0.5;
  return (
    <div className="kp-back">
      <div className="k-tp" role="dialog" aria-modal="true" aria-label="Izbor stola">
        <div className="kp-title">Na koji sto?</div>
        <div className="k-areas">{areas.map((a) => <button key={a} className={`k-area ${a === cur ? 'on' : ''}`} onClick={() => setArea(a)}>{a}</button>)}</div>
        <div className="k-floor-wrap" ref={ref}>
          {tables.loading && !tables.data ? <Spinner /> : tables.error ? <ErrorBox error={tables.error} /> : (
            <div className="k-floor" style={{ width: size.w * scale, height: size.h * scale }}>
              {inArea.map((t) => (
                <TableTile key={t.id} t={t} scale={scale} onClick={() => onPick(t)} style={{ position: 'absolute', left: t.posX * scale, top: t.posY * scale }}>
                  {t.id === current && <span className="k-tp-here">ovde</span>}
                </TableTile>
              ))}
            </div>
          )}
        </div>
        <div className="k-qp-actions"><button type="button" className="kp-btn cancel" onClick={onCancel}>OTKAŽI</button><span /></div>
      </div>
    </div>
  );
}

/**
 * Prebacivanje: količine → mapa stolova → PIN.
 * Bez oznake "drugom konobaru" unosi se svoja šifra (potvrda); sa oznakom - šifra konobara koji preuzima.
 * Sve stavke na prazan drugi sto = ceo račun prelazi (isti broj računa); inače se deo odvaja na sto / novu turu.
 */
export function TransferFlow({ order, token, onClose, onDone }: { order: Order; token?: string; onClose: () => void; onDone: (msg: string) => void }) {
  const { me } = useAuth();
  const live = order.items.filter((i) => i.status !== 'VOIDED');
  // prazan sto (otvoren, ništa otkucano) se prebacuje odmah na drugi sto
  const [step, setStep] = useState<'qty' | 'table' | 'pin'>(live.length ? 'qty' : 'table');
  const [picks, setPicks] = useState<Pick[]>([]);
  const [target, setTarget] = useState<Table | null>(null);
  const [toOther, setToOther] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (pin: string) => {
    if (!target) return;
    setBusy(true); setError(null);
    try {
      const who = await approve(pin, storage.deviceId ?? me?.user.deviceId);
      if (!toOther && who.user.id !== order.waiterId && who.user.id !== me?.user.userId) {
        throw new ApiError(403, 'FORBIDDEN', 'Unesite svoju šifru - ili označite „Prebacujem drugom konobaru“');
      }
      if (toOther && !who.user.permissions.includes('order.write')) throw new ApiError(403, 'FORBIDDEN', `${who.user.fullName} ne može da preuzme račun`);
      const all = picks.length === live.length && picks.every((p) => toNum(p.qty) === toNum(p.item.quantity));
      const others = target.openOrders.filter((x) => x.id !== order.id);
      let resultId = order.id;
      if (!live.length && others.length) throw new ApiError(409, 'TABLE_BUSY', 'Prazan sto se prebacuje na slobodan sto (izabrani sto ima otvoren račun)');
      if (all && target.id !== order.tableId && others.length === 0) {
        await api('POST', `/orders/${order.id}/move-table`, { toTableId: target.id }, token);
      } else {
        const body: any = { itemIds: picks.map((p) => p.item.id), quantities: picks.map((p) => p.qty) };
        if (target.id !== order.tableId && others.length) body.toOrderId = others[0].id;
        else body.toTableId = target.id;
        resultId = (await api('POST', `/orders/${order.id}/move-items`, body, token)).to.id;
      }
      let msg = `Prebačeno na sto ${tableLabel(target.name)}${target.id === order.tableId ? ' (nova tura)' : ''}`;
      if (toOther && who.user.id !== order.waiterId) {
        const r = await api('POST', '/orders/transfer', { orderIds: [resultId], toUserId: who.user.id }, token);
        msg += ` - preuzima ${r.toName}`;
      }
      onDone(msg);
    } catch (e) { setError(e); setBusy(false); }
  };

  if (step === 'qty') return <QtyPick title={`Prebacivanje - ${order.tableName ? tableLabel(order.tableName) : 'Brza prodaja'} #${order.number}`} items={live} confirmLabel="Prebaci" onCancel={onClose} onNext={(p) => { setPicks(p); setStep('table'); }} />;
  if (step === 'table') return <TablePicker current={order.tableId} token={token} onCancel={() => (live.length ? setStep('qty') : onClose())} onPick={(t) => { setTarget(t); setStep('pin'); }} />;
  return (
    <KeypadDialog title={`Prebacivanje na sto ${target ? tableLabel(target.name) : ''}`} secret minLen={1} busy={busy} error={error} confirmLabel="Prebaci"
      hint={toOther ? 'Šifra konobara koji preuzima račun' : 'Unesite svoju šifru (potvrda)'} onConfirm={run} onClose={() => setStep('table')}>
      <label className="kp-check"><input type="checkbox" checked={toOther} onChange={(e) => setToOther(e.target.checked)} /> Prebacujem drugom konobaru</label>
    </KeypadDialog>
  );
}

/**
 * Storniranje: količine poslatih stavki → razlog i PIN zaposlenog sa pravom storniranja (konobar bez prava zove menadžera).
 * Neposlate stavke se ne storniraju - one se brišu (Obriši stavku).
 */
export function StornoFlow({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (o: Order, msg: string) => void }) {
  const { me } = useAuth();
  // prijavljeni ima pravo (ADMIN, menadžer…): prazno polje + Potvrdi, bez šifre
  const self = (p: string) => !!me?.user.permissions.includes(p);
  const selfAuth = () => ({ accessToken: storage.token, user: { id: me!.user.userId, fullName: me!.user.fullName, permissions: me!.user.permissions } });
  const sent = order.items.filter((i) => i.status === 'SENT');
  const [step, setStep] = useState<'qty' | 'pin'>('qty');
  const [picks, setPicks] = useState<Pick[]>([]);
  const presets = ['Pogrešno uneto', 'Gost odustao', 'Reklamacija', 'Gost otišao'];
  const [reason, setReason] = useState(presets[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (pin: string) => {
    setBusy(true); setError(null);
    try {
      // ko ima pravo storniranja (npr. ADMIN, menadžer) samo potvrđuje - ostali kucaju šifru nekoga ko ima pravo
      const r = !pin && self('order.void') ? selfAuth() : await approve(pin, storage.deviceId ?? me?.user.deviceId);
      if (!r.user.permissions.includes('order.void')) throw new ApiError(403, 'FORBIDDEN', `${r.user.fullName} nema pravo storniranja - pozovite menadžera`);
      let o = await api<Order>('GET', `/orders/${order.id}`, undefined, r.accessToken);
      for (const p of picks) {
        const full = toNum(p.qty) >= toNum(p.item.quantity);
        o = await api<Order>('POST', `/orders/${order.id}/items/${p.item.id}/void`,
          { reason, expectedVersion: o.version, ...(full ? {} : { quantity: p.qty }) }, r.accessToken);
      }
      onDone(o, `Stornirano ${picks.length} ${picks.length === 1 ? 'stavka' : 'stavki'} (odobrio: ${r.user.fullName})`);
    } catch (e) { setError(e); setBusy(false); }
  };

  if (!sent.length) {
    return (
      <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="kp"><div className="kp-title">Storniranje</div>
          <div className="kp-hint">Na stolu nema poslatih stavki. Neposlate stavke se brišu dugmetom „Obriši stavku“.</div>
          <div className="kp-actions"><span /><button className="kp-btn ok" onClick={onClose}>U redu</button></div>
        </div>
      </div>
    );
  }
  if (step === 'qty') return <QtyPick title={`Storniranje - ${order.tableName ? tableLabel(order.tableName) : 'Brza prodaja'} #${order.number}`} items={sent} confirmLabel="Storniraj" onCancel={onClose} onNext={(p) => { setPicks(p); setStep('pin'); }} />;
  return (
    <KeypadDialog title={`Storno - ${picks.map((p) => `${p.qty.replace('.', ',')}× ${p.item.name}`).join(', ')}`} secret minLen={self('order.void') ? 0 : 1} busy={busy} error={error}
      confirmLabel="Storniraj" hint={self('order.void') ? 'Imate pravo storniranja: izaberite razlog i Storniraj (šifra nije potrebna)' : 'Razlog, pa PIN zaposlenog koji ima pravo storniranja'} onConfirm={run} onClose={() => setStep('qty')}>
      <div className="kp-chips">{presets.map((p) => <button key={p} type="button" className={`kp-chip ${reason === p ? 'on' : ''}`} onClick={() => setReason(p)}>{p}</button>)}</div>
    </KeypadDialog>
  );
}

type Refundable = { id: string; name: string; quantity: string; remaining: string; net: string };

/**
 * Povraćaj novca (refundacija naplaćenog računa): stavke sa još nevraćenom količinom → razlog i način povraćaja
 * → PIN zaposlenog sa pravom povraćaja. Posle povraćaja štampaju se dva primerka (kupac i lokal sa potpisom).
 */
export function RefundFlow({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (msg: string) => void }) {
  const { me } = useAuth();
  // prijavljeni ima pravo (ADMIN, menadžer…): prazno polje + Potvrdi, bez šifre
  const self = (p: string) => !!me?.user.permissions.includes(p);
  const selfAuth = () => ({ accessToken: storage.token, user: { id: me!.user.userId, fullName: me!.user.fullName, permissions: me!.user.permissions } });
  const r = useLoad(() => api<{ items: Refundable[] }>('GET', `/orders/${order.id}/refunds`), [order.id]);
  const [step, setStep] = useState<'qty' | 'pin'>('qty');
  const [picks, setPicks] = useState<Pick[]>([]);
  const presets = ['Reklamacija', 'Pogrešno naplaćeno', 'Gost odustao', 'Povrat robe'];
  const [reason, setReason] = useState(presets[0]);
  const paid = [...new Set(order.payments.filter((p) => p.method !== 'REPRESENTATION').map((p) => p.method))];
  const [method, setMethod] = useState<'CASH' | 'CARD' | 'TRANSFER'>(paid.length === 1 ? (paid[0] as any) : 'CASH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [key] = useState(() => `refund-${order.id}-${Date.now()}`);

  const run = async (pin: string) => {
    setBusy(true); setError(null);
    try {
      const a = !pin && self('order.refund') ? selfAuth() : await approve(pin, storage.deviceId ?? me?.user.deviceId);
      if (!a.user.permissions.includes('order.refund')) throw new ApiError(403, 'FORBIDDEN', `${a.user.fullName} nema pravo povraćaja novca - pozovite menadžera`);
      const all = (r.data?.items ?? []).filter((i) => toNum(i.remaining) > 0);
      const whole = picks.length === all.length && picks.every((p) => toNum(p.qty) >= toNum(p.item.quantity));
      const rf = await api('POST', `/orders/${order.id}/refunds`, {
        reason, method, idempotencyKey: key, ...(whole ? {} : { items: picks.map((p) => ({ itemId: p.item.id, quantity: String(toNum(p.qty)) })) }),
      }, a.accessToken);
      let printed = '';
      try { await api('POST', `/refunds/${rf.id}/print`, { idempotencyKey: `${key}-p` }, a.accessToken); printed = ', štampaju se 2 primerka'; }
      catch { printed = ' (štampač nije podešen)'; }
      onDone(`Povraćaj #${rf.number}: ${fmt(rf.total)} (${METHOD_LABEL[method]})${printed}`);
    } catch (e) { setError(e); setBusy(false); }
  };

  if (r.loading && !r.data) return <div className="kp-back"><div className="kp"><Spinner /></div></div>;
  const items = (r.data?.items ?? []).filter((i) => toNum(i.remaining) > 0)
    .map((i) => ({ id: i.id, name: i.name, quantity: i.remaining, note: null }) as unknown as OrderItem);
  if (r.error || !items.length) {
    return (
      <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="kp"><div className="kp-title">Povraćaj novca</div>
          {r.error ? <ErrorBox error={r.error} /> : <div className="kp-hint">Sve stavke ovog računa su već vraćene.</div>}
          <div className="kp-actions"><span /><button className="kp-btn ok" onClick={onClose}>U redu</button></div>
        </div>
      </div>
    );
  }
  if (step === 'qty') {
    return <QtyPick title={`Povraćaj novca - račun #${order.number}`} items={items} confirmLabel="Vrati" onCancel={onClose}
      onNext={(p) => { setPicks(p); setStep('pin'); }} />;
  }
  return (
    <KeypadDialog title={`Povraćaj - ${picks.map((p) => `${p.qty.replace('.', ',')}× ${p.item.name}`).join(', ')}`} secret minLen={self('order.refund') ? 0 : 1} busy={busy} error={error}
      confirmLabel="Vrati novac" hint={self('order.refund') ? 'Imate pravo povraćaja: razlog, način i Vrati novac (šifra nije potrebna)' : 'Razlog, način povraćaja, pa PIN zaposlenog koji ima pravo povraćaja'} onConfirm={run} onClose={() => setStep('qty')}>
      <div className="kp-chips">{presets.map((p) => <button key={p} type="button" className={`kp-chip ${reason === p ? 'on' : ''}`} onClick={() => setReason(p)}>{p}</button>)}</div>
      <div className="kp-chips">{(['CASH', 'CARD', 'TRANSFER'] as const).map((m) => (
        <button key={m} type="button" className={`kp-chip ${method === m ? 'on' : ''}`} onClick={() => setMethod(m)}>{METHOD_LABEL[m]}</button>
      ))}</div>
    </KeypadDialog>
  );
}
/** PIN odobrenja: na kasi prijava na tu kasu, u ADMIN-u (bez kase) ADMIN prijava šifrom. */
const approve = (pin: string, deviceId: string | null | undefined) => (deviceId ? api('POST', '/auth/pin', { deviceId, pin }) : api('POST', '/auth/admin-pin', { pin }));
const METHOD_LABEL = { CASH: 'Gotovina', CARD: 'Kartica', TRANSFER: 'Prenos na račun' } as const;
