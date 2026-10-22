import { and, eq, inArray, sql } from 'drizzle-orm';
import { Tx } from '../../db/db.module';
import {
  categories, diningTables, kdsTickets, orderItems, orders, prepStations, printers, printJobs, products, users,
} from '../../db/schema';
import { RealtimeEvent } from '../../common/events';

type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;

export interface TicketLine { qty: string; name: string; note: string | null }
export interface TicketPayload {
  title: string;
  station: string;
  orderNumber: number;
  table: string | null;
  tab: string | null;
  waiter: string;
  batch: number | null;
  createdAt: string;
  lines: TicketLine[];
  reason?: string;
}

/** Kontekst zaglavlja tiketa: sto, konobar. */
async function header(tx: Tx, o: OrderRow) {
  const [r] = await tx.select({ waiter: users.fullName, table: diningTables.name })
    .from(orders).innerJoin(users, eq(users.id, orders.waiterId))
    .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
    .where(eq(orders.id, o.id));
  return { waiter: r?.waiter ?? '', table: r?.table ?? null };
}

/**
 * Pozicija za svaki artikal: pozicija artikla, a ako je nema — pozicija njegove kategorije.
 * Uzima se samo aktivna pozicija ISTOG lokala kao porudžbina; inače stavka ostaje nerutirana.
 */
async function resolveStations(tx: Tx, locationId: string, productIds: string[]) {
  if (!productIds.length) return new Map<string, typeof prepStations.$inferSelect & { printerActive: boolean | null }>();
  const rows = await tx.select({
    productId: products.id,
    stationId: sql<string | null>`coalesce(${products.prepStationId}, ${categories.prepStationId})`,
  }).from(products).innerJoin(categories, eq(categories.id, products.categoryId))
    .where(inArray(products.id, productIds));
  const stationIds = [...new Set(rows.map((r) => r.stationId).filter((x): x is string => !!x))];
  const stations = stationIds.length
    ? await tx.select({ s: prepStations, printerActive: printers.active }).from(prepStations)
      .leftJoin(printers, eq(printers.id, prepStations.printerId))
      .where(and(inArray(prepStations.id, stationIds), eq(prepStations.locationId, locationId), eq(prepStations.active, true)))
    : [];
  const byId = new Map(stations.map((x) => [x.s.id, { ...x.s, printerActive: x.printerActive }]));
  const out = new Map<string, typeof prepStations.$inferSelect & { printerActive: boolean | null }>();
  for (const r of rows) {
    const st = r.stationId ? byId.get(r.stationId) : undefined;
    if (st) out.set(r.productId, st);
  }
  return out;
}

const line = (i: ItemRow): TicketLine => ({ qty: i.quantity, name: i.name, note: i.note });

/**
 * Rutiranje jedne ture slanja (u ISTOJ transakciji kao i slanje):
 *  - po jedna KDS kartica po (račun, tura, pozicija) — jedinstveni indeks u bazi,
 *  - po jedan zadatak štampe po (račun, tura, pozicija) — dedupe_key je jedinstven u bazi,
 *  - stavke dobijaju snimak pozicije i kartice.
 * Stavke čiji artikal nema poziciju ostaju nerutirane (nema kartice ni štampe) — to se vidi na kasi.
 */
export async function routeBatch(tx: Tx, o: OrderRow, batch: number, items: ItemRow[]): Promise<RealtimeEvent[]> {
  const events: RealtimeEvent[] = [];
  const stationOf = await resolveStations(tx, o.locationId, [...new Set(items.map((i) => i.productId))]);
  const groups = new Map<string, { station: NonNullable<ReturnType<typeof stationOf.get>>; items: ItemRow[] }>();
  for (const i of items) {
    const st = stationOf.get(i.productId);
    if (!st) continue;
    const g = groups.get(st.id) ?? { station: st, items: [] };
    g.items.push(i);
    groups.set(st.id, g);
  }
  if (!groups.size) return events;
  const h = await header(tx, o);

  for (const { station, items: list } of groups.values()) {
    let ticketId: string | null = null;
    if (station.kdsEnabled) {
      const [t] = await tx.insert(kdsTickets).values({ locationId: o.locationId, orderId: o.id, stationId: station.id, batch })
        .onConflictDoNothing().returning();
      const ticket = t ?? (await tx.select().from(kdsTickets)
        .where(and(eq(kdsTickets.orderId, o.id), eq(kdsTickets.batch, batch), eq(kdsTickets.stationId, station.id))))[0];
      ticketId = ticket.id;
      events.push({ type: 'kds.ticket.created', locationId: o.locationId, stationId: station.id, data: { ticketId, orderId: o.id } });
    }
    await tx.update(orderItems).set({ prepStationId: station.id, kdsTicketId: ticketId })
      .where(inArray(orderItems.id, list.map((i) => i.id)));

    if (station.printerId && station.printerActive) {
      const payload: TicketPayload = {
        title: 'NARUDŽBINA', station: station.name, orderNumber: o.number, table: h.table, tab: o.tabName,
        waiter: h.waiter, batch, createdAt: new Date().toISOString(), lines: list.map(line),
      };
      const [job] = await tx.insert(printJobs).values({
        locationId: o.locationId, printerId: station.printerId, stationId: station.id, orderId: o.id,
        kind: 'ORDER_TICKET', dedupeKey: `ticket:${o.id}:${batch}:${station.id}`, payload,
      }).onConflictDoNothing().returning();
      if (job) events.push({ type: 'print.job.created', locationId: o.locationId, data: { jobId: job.id, printerId: job.printerId } });
    }
  }
  return events;
}

/**
 * Storno poslatih stavki: pozicija dobija STORNO tiket na štampaču (jednom po stavci — dedupe po stavci)
 * i KDS događaj da je stavka otkazana.
 */
export async function routeVoids(tx: Tx, o: OrderRow, voided: ItemRow[], reason: string, mode: 'item' | 'all'): Promise<RealtimeEvent[]> {
  const events: RealtimeEvent[] = [];
  const routed = voided.filter((i) => i.prepStationId);
  if (!routed.length) return events;
  const stationIds = [...new Set(routed.map((i) => i.prepStationId!))];
  const stations = await tx.select({ s: prepStations, printerActive: printers.active }).from(prepStations)
    .leftJoin(printers, eq(printers.id, prepStations.printerId)).where(inArray(prepStations.id, stationIds));
  const h = await header(tx, o);
  for (const { s, printerActive } of stations) {
    const list = routed.filter((i) => i.prepStationId === s.id);
    for (const i of list) {
      if (i.kdsTicketId) {
        events.push({ type: 'kds.item.voided', locationId: o.locationId, stationId: s.id, data: { ticketId: i.kdsTicketId, itemId: i.id } });
      }
    }
    if (s.printerId && printerActive) {
      const payload: TicketPayload = {
        title: 'STORNO', station: s.name, orderNumber: o.number, table: h.table, tab: o.tabName, waiter: h.waiter,
        batch: null, createdAt: new Date().toISOString(), lines: list.map(line), reason,
      };
      // Storno stavke se dešava najviše jednom (stavka je posle VOIDED); storno celog računa takođe (račun je posle CANCELLED).
      const key = mode === 'item' ? `void:${list[0].id}` : `voidall:${o.id}:${s.id}`;
      const [job] = await tx.insert(printJobs).values({
        locationId: o.locationId, printerId: s.printerId, stationId: s.id, orderId: o.id,
        kind: 'VOID_TICKET', dedupeKey: key, payload,
      }).onConflictDoNothing().returning();
      if (job) events.push({ type: 'print.job.created', locationId: o.locationId, data: { jobId: job.id, printerId: job.printerId } });
    }
  }
  return events;
}
