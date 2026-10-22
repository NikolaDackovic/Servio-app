import { useEffect, useRef, useState } from 'react';
import { storage } from './api';

export type RtStatus = 'connecting' | 'open' | 'lost';
export interface RtEvent { type: string; stationId: string | null; data: any; at: string }

/**
 * Veza sa serverom u realnom vremenu (WebSocket /api/v1/ws).
 * - Ponovno povezivanje sa rastućim razmakom (1 s → 15 s).
 * - Klijent šalje "ping" na 10 s; bez odgovora 25 s → veza se smatra prekinutom (status "lost").
 * - Posle svakog (ponovnog) povezivanja poziva se onReconnect: ekran mora ponovo da učita stanje preko REST-a,
 *   jer su događaji samo obaveštenja i neki su mogli biti propušteni dok veze nije bilo.
 */
export function useRealtime(opts: { stationId?: string | null; onEvent: (e: RtEvent) => void; onReconnect?: () => void; enabled?: boolean }) {
  const [status, setStatus] = useState<RtStatus>('connecting');
  const [since, setSince] = useState<number | null>(null);
  const cb = useRef(opts);
  cb.current = opts;
  const enabled = opts.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let lastMsg = Date.now();
    let reconnectTimer: number | undefined;
    let first = true;

    const connect = () => {
      const token = storage.token;
      if (!token || closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const q = new URLSearchParams({ token });
      if (cb.current.stationId) q.set('stationId', cb.current.stationId);
      setStatus((s) => (s === 'open' ? 'connecting' : s));
      ws = new WebSocket(`${proto}://${location.host}/api/v1/ws?${q}`);
      ws.onopen = () => {
        retry = 0; lastMsg = Date.now();
        setStatus('open'); setSince(null);
        if (!first) cb.current.onReconnect?.();
        first = false;
      };
      ws.onmessage = (m) => {
        lastMsg = Date.now();
        try {
          const e = JSON.parse(m.data) as RtEvent;
          if (e.type !== 'hello' && e.type !== 'pong') cb.current.onEvent(e);
        } catch { /* nepoznata poruka */ }
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus('lost'); setSince((s) => s ?? Date.now());
        const delay = Math.min(15000, 1000 * 2 ** retry++);
        reconnectTimer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    const hb = window.setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.send('ping'); } catch { /* */ }
        if (Date.now() - lastMsg > 25000) ws.close(); // tiho mrtva veza (npr. ispao kabl)
      }
    }, 10000);
    const online = () => { if (ws?.readyState !== WebSocket.OPEN) { window.clearTimeout(reconnectTimer); retry = 0; connect(); } };
    window.addEventListener('online', online);

    return () => {
      closed = true;
      window.clearInterval(hb); window.clearTimeout(reconnectTimer);
      window.removeEventListener('online', online);
      ws?.close();
    };
  }, [enabled, opts.stationId]);

  return { status, lostSince: since };
}
