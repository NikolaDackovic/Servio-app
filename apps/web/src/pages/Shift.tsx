import { useState } from 'react';
import { api, cmpMoney, fmt, time } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Keypad, Modal, Spinner, useLoad, useToast } from '../ui';

const normalize = (v: string) => { const [i, d = ''] = v.split('.'); return `${i || '0'}.${(d + '00').slice(0, 2)}`; };

export function Shift() {
  const { can, me } = useAuth();
  const toast = useToast();
  const cur = useLoad(() => api('GET', '/shifts/current'), []);
  const [dialog, setDialog] = useState<null | 'open' | 'close' | 'PAY_IN' | 'PAY_OUT'>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState<any>(null);

  if (!me?.user.deviceId) return <div className="page"><div className="notice">Kasa (gotovina) se vodi po uređaju. Prijavite se na registrovanoj kasi (PIN prijava).</div></div>;
  if (cur.loading && !cur.data) return <Spinner />;
  if (cur.error) return <ErrorBox error={cur.error} onRetry={cur.reload} />;
  const s = cur.data;
  const manage = can('shift.manage');

  const run = async () => {
    setBusy(true);
    try {
      if (dialog === 'open') await api('POST', '/shifts/open', { openingCash: normalize(value) });
      if (dialog === 'close') setClosed(await api('POST', '/shifts/close', { countedCash: normalize(value) }));
      if (dialog === 'PAY_IN' || dialog === 'PAY_OUT') await api('POST', '/shifts/current/cash-movements', { type: dialog, amount: normalize(value), reason });
      toast('ok', 'Sačuvano');
      setDialog(null); setValue(''); setReason('');
      cur.reload();
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };

  const titles = { open: 'Otvaranje kase - početna gotovina', close: 'Zatvaranje kase - prebrojana gotovina', PAY_IN: 'Uplata u blagajnu', PAY_OUT: 'Isplata iz blagajne' };

  return (
    <div className="page narrow">
      {closed && (
        <div className="card">
          <h3>Kasa zatvorena (gotovina prebrojana)</h3>
          <ShiftNumbers data={closed} />
          <div className={`row big ${cmpMoney(closed.shift.difference, '0.00') === 0 ? '' : 'warn-text'}`}>
            <span>Razlika (prebrojano − očekivano)</span><strong>{fmt(closed.shift.difference)}</strong>
          </div>
          <button className="btn" onClick={() => setClosed(null)}>U redu</button>
        </div>
      )}
      {!s.shift ? (
        <div className="card">
          <h3>Kasa (gotovina) nije otvorena</h3>
          <p className="muted">Naplata na ovoj kasi nije moguća dok se kasa ne otvori sa početnim stanjem gotovine.</p>
          {manage ? <button className="btn primary lg" onClick={() => setDialog('open')}>Otvori kasu</button> : <p className="notice">Kasu otvara kasir ili menadžer.</p>}
        </div>
      ) : (
        <div className="card">
          <h3>Kasa otvorena od {time(s.shift.openedAt)}</h3>
          <ShiftNumbers data={s} />
          {manage && (
            <div className="btn-row">
              <button className="btn" onClick={() => setDialog('PAY_IN')}>Uplata</button>
              <button className="btn" onClick={() => setDialog('PAY_OUT')}>Isplata</button>
              <button className="btn primary" onClick={() => setDialog('close')}>Zatvori kasu (prebrojavanje)</button>
            </div>
          )}
        </div>
      )}
      {dialog && (
        <Modal title={titles[dialog]} onClose={() => setDialog(null)}>
          <div className="row big"><span>Iznos</span><strong>{fmt(normalize(value))}</strong></div>
          {(dialog === 'PAY_IN' || dialog === 'PAY_OUT') && <input className="input" placeholder="Razlog (obavezno)" value={reason} onChange={(e) => setReason(e.target.value)} />}
          <Keypad value={value} onChange={setValue} />
          <button className="btn primary lg block" onClick={run}
            disabled={busy || ((dialog === 'PAY_IN' || dialog === 'PAY_OUT') && (reason.trim().length < 2 || cmpMoney(normalize(value), '0.00') <= 0))}>
            {busy ? 'Čuvam…' : 'Potvrdi'}
          </button>
        </Modal>
      )}
    </div>
  );
}

function ShiftNumbers({ data }: { data: any }) {
  const m = (k: string) => data.payments.find((p: any) => p.method === k)?.total ?? '0.00';
  return (
    <div className="kv">
      <div><span>Početna gotovina</span><b>{fmt(data.shift.openingCash)}</b></div>
      <div><span>Gotovina (naplata)</span><b>{fmt(m('CASH'))}</b></div>
      <div><span>Kartica</span><b>{fmt(m('CARD'))}</b></div>
      <div><span>Virman</span><b>{fmt(m('TRANSFER'))}</b></div>
      <div><span>Uplate / isplate</span><b>{fmt(data.payIn)} / {fmt(data.payOut)}</b></div>
      <div className="strong"><span>Očekivana gotovina u kasi</span><b>{fmt(data.expectedCash)}</b></div>
    </div>
  );
}
