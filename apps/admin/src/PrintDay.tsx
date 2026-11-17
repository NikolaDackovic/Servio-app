import { useState } from 'react';
import { api, newIdempotencyKey } from '@shared/api';
import { useLoad, useToast } from '@shared/ui';

/** Štampa specifikacije pazara (smene) na izabrani štampač lokala. */
export function PrintDay({ dayId }: { dayId: string }) {
  const toast = useToast();
  const printers = useLoad(() => api<{ id: string; name: string; windowsName: string | null; active: boolean }[]>('GET', '/printers').catch(() => []), []);
  const [printer, setPrinter] = useState('');
  const [busy, setBusy] = useState(false);
  const active = (printers.data ?? []).filter((p) => p.active);
  const pid = printer || active[0]?.id || '';
  const go = async () => {
    setBusy(true);
    try { await api('POST', `/business-days/${dayId}/print`, { printerId: pid, idempotencyKey: newIdempotencyKey('spec') }); toast('ok', 'Specifikacija poslata na štampač'); }
    catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  return (
    <div className="print-day">
      <select className="input" value={pid} onChange={(e) => setPrinter(e.target.value)}>
        {active.length === 0 && <option value="">nema štampača</option>}
        {active.map((p) => <option key={p.id} value={p.id}>{p.windowsName || p.name}</option>)}
      </select>
      <button className="btn primary" disabled={busy || !pid} onClick={go}>🖨 {busy ? 'Šaljem…' : 'Štampaj specifikaciju'}</button>
    </div>
  );
}
