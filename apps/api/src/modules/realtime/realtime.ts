import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq } from 'drizzle-orm';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { DB, Db } from '../../db/db.module';
import { devices, roles, users } from '../../db/schema';
import { JwtPayload } from '../../common/auth-context';
import { EventBus, RealtimeEvent } from '../../common/events';
import { P } from '../../common/permissions';

export const WS_PATH = '/api/v1/ws';
const HEARTBEAT_MS = 15_000;

interface Client { ws: WebSocket; locationId: string; stationId: string | null; alive: boolean }

/**
 * WebSocket kanal: `ws://host/api/v1/ws?token=<JWT>&stationId=<opciono>`.
 * - Pristup imaju samo aktivni korisnici sa pravom order.read ili kds.use (provera u bazi pri povezivanju).
 * - Klijent dobija samo događaje svog lokala; sa stationId samo događaje te pozicije + opšte događaje lokala.
 * - Server šalje ping na 15 s i prekida "mrtve" veze; klijent sam prikazuje prekid i ponovo se povezuje,
 *   pa ponovo učitava stanje preko REST-a (događaji su samo obaveštenja).
 */
export function attachRealtime(app: INestApplication) {
  const server = app.getHttpServer() as import('http').Server;
  const jwt = app.get(JwtService);
  const db = app.get<Db>(DB);
  const bus = app.get(EventBus);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const clients = new Set<Client>();

  async function authorize(req: IncomingMessage) {
    const url = new URL(req.url ?? '', 'http://x');
    const token = url.searchParams.get('token');
    if (!token) return null;
    let p: JwtPayload;
    try { p = await jwt.verifyAsync<JwtPayload>(token); } catch { return null; }
    const [u] = await db.select({ active: users.active, permissions: roles.permissions })
      .from(users).innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.id, p.sub), eq(users.organizationId, p.org)));
    if (!u?.active) return null;
    if (!u.permissions.includes(P.ORDER_READ) && !u.permissions.includes(P.KDS_USE)) return null;
    if (p.dev) {
      const [d] = await db.select({ active: devices.active }).from(devices).where(and(eq(devices.id, p.dev), eq(devices.locationId, p.loc)));
      if (!d?.active) return null;
    }
    const st = url.searchParams.get('stationId');
    return { locationId: p.loc, stationId: st && /^[0-9a-f-]{36}$/i.test(st) ? st : null };
  }

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!(req.url ?? '').startsWith(WS_PATH)) return; // ostale upgrade zahteve ne diramo
    authorize(req).then((ctx) => {
      if (!ctx) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const c: Client = { ws, ...ctx, alive: true };
        clients.add(c);
        ws.on('pong', () => { c.alive = true; });
        ws.on('close', () => clients.delete(c));
        ws.on('error', () => clients.delete(c));
        ws.on('message', (m) => { if (String(m) === 'ping') ws.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() })); });
        ws.send(JSON.stringify({ type: 'hello', at: new Date().toISOString(), stationId: c.stationId }));
      });
    }).catch(() => socket.destroy());
  };
  server.on('upgrade', onUpgrade);

  const unsubscribe = bus.subscribe((e: RealtimeEvent) => {
    const msg = JSON.stringify({ type: e.type, stationId: e.stationId ?? null, data: e.data, at: new Date().toISOString() });
    for (const c of clients) {
      if (c.locationId !== e.locationId) continue;
      if (c.stationId && e.stationId && c.stationId !== e.stationId) continue;
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
    }
  });

  const hb = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); clients.delete(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* zatvorena veza */ }
    }
  }, HEARTBEAT_MS);
  hb.unref();

  // Otvorene WebSocket veze bi sprečile gašenje HTTP servera — zatvaramo ih pre app.close().
  const close = app.close.bind(app);
  app.close = async () => {
    clearInterval(hb);
    unsubscribe();
    server.off('upgrade', onUpgrade);
    for (const c of clients) c.ws.terminate();
    clients.clear();
    wss.close();
    return close();
  };
  return { clientCount: () => clients.size };
}
