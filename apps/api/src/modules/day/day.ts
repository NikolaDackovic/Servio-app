import {
  Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { businessDays, cashShifts, devices, diningTables, orders, roles, staffShifts, users } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { dec, money, sum } from '../../common/money';
import { computeSales } from '../reports/reports';
import { cashShiftSummary } from '../shifts/shifts';
import { findOpenDay } from './day.helpers';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class OpenDayDto {
  /** Datum poslovnog dana (podrazumevano: današnji datum u zoni lokala) */
  @IsOptional() @Matches(DATE_RE) date?: string;
  /** Naziv smene, npr. "Ponedeljak" (podrazumevano: naziv dana u nedelji; isti datum može imati "Ponedeljak1"…). */
  @IsOptional() @IsString() @Length(1, 40) name?: string;
}
class MergeDaysDto { @IsUUID() targetId: string; @IsUUID() sourceId: string; }
class SplitDayDto {
  /** Lokalno vreme preseka, npr. 2026-10-24T05:00 */
  @Matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/, { message: 'Vreme preseka: YYYY-MM-DDTHH:MM' }) at: string;
}
class CalendarQuery {
  @Matches(/^\d{4}-\d{2}$/, { message: 'Mesec u formatu YYYY-MM' }) month: string;
}
class StaffShiftsQuery {
  @IsOptional() @IsUUID() businessDayId?: string;
}

async function rows<T>(db: DbOrTx, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(q)).rows as T[];
}

type StaffShiftRow = typeof staffShifts.$inferSelect;

/**
 * Specifikacija pazara zaposlenog za jednu smenu:
 *  - naplaćeno po načinu plaćanja (plaćanja koja je on evidentirao u toj smeni) → to predaje
 *  - zaključeni računi koje je on zatvorio, storna koja je on uradio
 *  - otvoreni računi koji su i dalje na njemu (moraju se prebaciti pre kraja smene)
 */
export async function staffShiftSummary(db: DbOrTx, s: StaffShiftRow) {
  const until = s.endedAt ?? new Date();
  const collected = await rows<{ method: string; count: number; amount: string }>(db, sql`
    SELECT method, count(*)::int AS count, sum(amount)::numeric(14,2)::text AS amount
    FROM payments WHERE staff_shift_id = ${s.id} GROUP BY method ORDER BY method`);
  const [closed] = await rows<{ count: number; amount: string }>(db, sql`
    SELECT count(*)::int AS count, coalesce(sum(total),0)::numeric(14,2)::text AS amount
    FROM orders WHERE location_id = ${s.locationId} AND status = 'PAID' AND closed_by_id = ${s.userId}
      AND closed_at >= ${s.startedAt} AND closed_at <= ${until}`);
  // Pazar po pripremnoj poziciji (Šank, Kuhinja…) - za procenat bakšiša po delu lokala; iznosi su posle popusta.
  const byStation = await rows<{ name: string; kind: string; amount: string }>(db, sql`
    SELECT coalesce(ps.name, 'Ostalo') AS name, coalesce(ps.kind::text, 'OTHER') AS kind,
      sum(i.line_total - i.discount_amount)::numeric(14,2)::text AS amount
    FROM order_items i JOIN orders o ON o.id = i.order_id
    JOIN products p ON p.id = i.product_id JOIN categories c ON c.id = p.category_id
    LEFT JOIN prep_stations ps ON ps.id = coalesce(i.prep_station_id, p.prep_station_id, c.prep_station_id)
    WHERE o.location_id = ${s.locationId} AND o.status = 'PAID' AND o.closed_by_id = ${s.userId}
      AND o.closed_at >= ${s.startedAt} AND o.closed_at <= ${until} AND i.status <> 'VOIDED'
    GROUP BY 1, 2 ORDER BY 3 DESC`);
  const [voids] = await rows<{ count: number; amount: string }>(db, sql`
    SELECT count(*)::int AS count, coalesce(sum(i.line_total),0)::numeric(14,2)::text AS amount
    FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.location_id = ${s.locationId} AND i.voided_by_id = ${s.userId}
      AND i.voided_at >= ${s.startedAt} AND i.voided_at <= ${until}`);
  const openOrders = await db
    .select({ id: orders.id, number: orders.number, tableName: diningTables.name, total: orders.total,
      paidTotal: orders.paidTotal, openedAt: orders.openedAt })
    .from(orders).leftJoin(diningTables, eq(diningTables.id, orders.tableId))
    .where(and(eq(orders.locationId, s.locationId), eq(orders.waiterId, s.userId), eq(orders.status, 'OPEN')))
    .orderBy(asc(orders.openedAt));
  const [user] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, s.userId));
  // Povraćaji novca koje je zaposleni uradio u smeni: umanjuju ono što predaje (gotovinski i gotovinu za predaju).
  const [refunded] = await rows<{ count: number; amount: string; cash: string }>(db, sql`
    SELECT count(*)::int AS count, coalesce(sum(total),0)::numeric(14,2)::text AS amount,
      coalesce(sum(total) FILTER (WHERE method = 'CASH'),0)::numeric(14,2)::text AS cash
    FROM refunds WHERE location_id = ${s.locationId} AND created_by_id = ${s.userId} AND created_at >= ${s.startedAt} AND created_at <= ${until}`);
  const cash = money(dec(collected.find((c) => c.method === 'CASH')?.amount ?? '0.00').sub(dec(refunded.cash)));
  return {
    userId: s.userId, fullName: user?.fullName, startedAt: s.startedAt, endedAt: s.endedAt,
    collected: {
      // pazar: sve naplate, i reprezentacija (na kuću) - ona se pravda potpisanim računom, ne ide u gotovinu za predaju
      total: money(sum(collected.map((c) => c.amount)).sub(dec(refunded.amount))),
      representation: collected.find((c) => c.method === 'REPRESENTATION')?.amount ?? '0.00',
      cashToHandOver: cash, byMethod: collected,
    },
    closedReceipts: closed, voids, refunds: refunded, byStation,
    openOrders,
  };
}

/**
 * Prodaja smene po kategoriji (Šank, Kuhinja… redom kao na kasi), po artiklu sortirano po količini.
 * Samo naplaćeni računi (i reprezentacija); stornirane stavke se ne računaju.
 */
export async function soldByStation(db: DbOrTx, dayId: string) {
  const sold = await rows<{ stationId: string; stationName: string; kind: string; name: string; quantity: string; gross: string }>(db, sql`
    SELECT coalesce(ps.id::text, 'none') AS "stationId", coalesce(ps.name, 'Bez pozicije') AS "stationName", coalesce(ps.kind::text, 'OTHER') AS kind,
      oi.name, sum(oi.quantity)::text AS quantity, sum(oi.line_total - oi.discount_amount)::numeric(14,2)::text AS gross
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN prep_stations ps ON ps.id = coalesce(oi.prep_station_id, p.prep_station_id, c.prep_station_id)
    WHERE o.business_day_id = ${dayId} AND o.status = 'PAID' AND oi.status <> 'VOIDED'
    GROUP BY 1, 2, 3, 4, ps.sort_order
    ORDER BY coalesce(ps.sort_order, 999), 2, sum(oi.quantity) DESC, 4`);
  const stations: { id: string; name: string; kind: string; items: { name: string; quantity: string; gross: string }[] }[] = [];
  for (const r of sold) {
    let st = stations.find((x) => x.id === r.stationId);
    if (!st) stations.push(st = { id: r.stationId, name: r.stationName, kind: r.kind, items: [] });
    st.items.push({ name: r.name, quantity: r.quantity, gross: r.gross });
  }
  return stations;
}

@Injectable()
export class DayService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async current(u: AuthUser) {
    const d = await findOpenDay(this.db, u.locationId);
    if (!d) return { day: null };
    return { day: d, sales: await computeSales(this.db, u.locationId, { kind: 'day', businessDayId: d.id }) };
  }

  /**
   * Kraj dana (kasa): pazar svakog zaposlenog u otvorenoj smeni i prodaja artikala po pripremnoj poziciji
   * (Šank, Kuhinja…), sortirano po prodatoj količini. Samo naplaćeni računi; stornirane stavke se ne računaju.
   */
  async endOfDay(u: AuthUser) {
    const d = await findOpenDay(this.db, u.locationId);
    if (!d) throw Conflict('DAY_NOT_OPEN', 'Nema otvorene smene');
    const list = await this.db.select().from(staffShifts).where(eq(staffShifts.businessDayId, d.id)).orderBy(asc(staffShifts.startedAt));
    const staff = [];
    for (const s of list) staff.push({ id: s.id, status: s.status, summary: s.status === 'CLOSED' && s.summary ? s.summary : await staffShiftSummary(this.db, s) });
    return { day: d, staff, stations: await soldByStation(this.db, d.id) };
  }

  /** Predlog za otvaranje smene: današnji datum (zona lokala) i slobodan naziv (Petak, Petak1, Petak2…). */
  async next(u: AuthUser) {
    const [loc] = await rows<{ today: string }>(this.db, sql`
      SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM locations WHERE id = ${u.locationId}`);
    return { date: loc.today, name: await this.freeName(this.db, u.locationId, loc.today, dayName(loc.today)) };
  }

  private async freeName(tx: DbOrTx, locationId: string, date: string, base: string) {
    const taken = new Set((await tx.select({ name: businessDays.name }).from(businessDays)
      .where(and(eq(businessDays.locationId, locationId), eq(businessDays.date, date)))).map((r) => r.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 1; ; i++) if (!taken.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
  }

  async open(u: AuthUser, dto: OpenDayDto) {
    return this.db.transaction(async (tx) => {
      const existing = await findOpenDay(tx, u.locationId, true);
      if (existing) throw Conflict('DAY_ALREADY_OPEN', `Smena ${existing.name || existing.date} je već otvorena`, { dayId: existing.id });
      const [loc] = await rows<{ today: string }>(tx, sql`
        SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM locations WHERE id = ${u.locationId}`);
      const date = dto.date ?? loc.today;
      const [last] = await tx.select({ date: businessDays.date }).from(businessDays)
        .where(eq(businessDays.locationId, u.locationId)).orderBy(desc(businessDays.date)).limit(1);
      if (last && date < last.date) {
        throw Invalid('DAY_DATE_NOT_AFTER_LAST', `Datum ne može biti pre poslednje smene (${last.date})`, { lastDate: last.date });
      }
      const name = (dto.name ?? dayName(date)).trim();
      const free = await this.freeName(tx, u.locationId, date, name);
      if (free !== name) throw Conflict('DAY_NAME_TAKEN', `Smena "${name}" za ${date} već postoji - dodajte nešto nazivu, npr. "${free}"`, { suggested: free });
      const [d] = await tx.insert(businessDays).values({ locationId: u.locationId, date, name, openedById: u.userId }).returning();
      await audit(tx, u, 'day.open', 'business_day', d.id, { date, name });
      return d;
    });
  }

  /**
   * Zaključak dana. Dozvoljen tek kada nema otvorenih računa i otvorenih smena kasa.
   * Otvorene smene zaposlenih se zatvaraju sa specifikacijom; dan čuva snimak obračuna.
   */
  async close(u: AuthUser) {
    return this.db.transaction(async (tx) => {
      const d = await findOpenDay(tx, u.locationId, true);
      if (!d) throw Conflict('DAY_NOT_OPEN', 'Nema otvorenog poslovnog dana');

      const openOrders = await tx
        .select({ id: orders.id, number: orders.number, tableName: diningTables.name, waiterName: users.fullName, total: orders.total })
        .from(orders).innerJoin(users, eq(users.id, orders.waiterId)).leftJoin(diningTables, eq(diningTables.id, orders.tableId))
        // hotel: račun na sobi ostaje otvoren preko zatvaranja dana (naplata pri odjavi gosta)
        .where(and(eq(orders.locationId, u.locationId), eq(orders.status, 'OPEN'), sql`NOT coalesce(${diningTables.isRoom}, false)`));
      if (openOrders.length) {
        throw Conflict('DAY_HAS_OPEN_ORDERS', `Dan se ne može zaključiti: otvorenih računa ${openOrders.length}. Naplatite ih ili otkažite.`, { openOrders });
      }
      const openShifts = await tx
        .select({ id: cashShifts.id, deviceName: devices.name, openedAt: cashShifts.openedAt })
        .from(cashShifts).innerJoin(devices, eq(devices.id, cashShifts.deviceId))
        .where(and(eq(cashShifts.locationId, u.locationId), eq(cashShifts.status, 'OPEN')));
      if (openShifts.length) {
        throw Conflict('DAY_HAS_OPEN_CASH_SHIFTS', 'Dan se ne može zaključiti: postoje otvorene smene kase. Zatvorite ih (prebrojavanje gotovine).', { openShifts });
      }

      const now = new Date();
      const staff = await tx.select().from(staffShifts)
        .where(and(eq(staffShifts.businessDayId, d.id), eq(staffShifts.status, 'OPEN')));
      for (const s of staff) {
        const summary = await staffShiftSummary(tx, { ...s, endedAt: now });
        await tx.update(staffShifts).set({ status: 'CLOSED', endedAt: now, endedById: u.userId, summary })
          .where(eq(staffShifts.id, s.id));
      }

      const sales = await computeSales(tx, u.locationId, { kind: 'day', businessDayId: d.id });
      const shifts = await tx.select({ id: cashShifts.id }).from(cashShifts).where(eq(cashShifts.businessDayId, d.id));
      const cash = [];
      for (const s of shifts) cash.push(await cashShiftSummary(tx, s.id));
      const summary = { sales, cashShifts: cash, closedStaffShifts: staff.length };

      // Otvoreni računi soba prelaze u sledeći dan: naplata se knjiži u dan kada je izvršena.
      await tx.execute(sql`UPDATE orders SET business_day_id = NULL WHERE location_id = ${u.locationId} AND status = 'OPEN'
        AND table_id IN (SELECT id FROM dining_tables WHERE is_room)`);
      const [closed] = await tx.update(businessDays)
        .set({ status: 'CLOSED', closedAt: now, closedById: u.userId, summary })
        .where(eq(businessDays.id, d.id)).returning();
      await audit(tx, u, 'day.close', 'business_day', d.id, { date: d.date, gross: sales.sales.gross, orders: sales.sales.orders });
      return closed;
    });
  }

  /** Kalendar: svi poslovni dani u mesecu sa prometom (računato iz baze). */
  /** Snimak obračuna smene (isto kao pri zaključku): promet, smene kasa, broj zatvorenih smena zaposlenih. */
  private async summarize(tx: DbOrTx, locationId: string, dayId: string) {
    const sales = await computeSales(tx, locationId, { kind: 'day', businessDayId: dayId });
    const shifts = await tx.select({ id: cashShifts.id }).from(cashShifts).where(eq(cashShifts.businessDayId, dayId));
    const cash = [];
    for (const s of shifts) cash.push(await cashShiftSummary(tx, s.id));
    const [{ n }] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM staff_shifts WHERE business_day_id = ${dayId} AND status = 'CLOSED'`);
    return { sales, cashShifts: cash, closedStaffShifts: n };
  }

  /**
   * Spajanje smena: sve iz izvorne (računi, naplate, smene zaposlenih i kasa) prelazi u ciljnu, izvorna se briše.
   * Npr. greškom zatvorena pa ponovo otvorena smena istog dana (Ponedeljak + Ponedeljak1). Obe moraju biti zatvorene.
   */
  async merge(u: AuthUser, dto: MergeDaysDto) {
    if (dto.targetId === dto.sourceId) throw Invalid('SAME_DAY', 'Izaberite dve različite smene');
    return this.db.transaction(async (tx) => {
      const days = await tx.select().from(businessDays)
        .where(and(eq(businessDays.locationId, u.locationId), sql`${businessDays.id} IN (${dto.targetId}, ${dto.sourceId})`)).for('update');
      let target = days.find((d) => d.id === dto.targetId); let source = days.find((d) => d.id === dto.sourceId);
      if (!target || !source) throw NotFound('Smena');
      // ostaje početna (ranije otvorena) smena: Ponedeljak + Ponedeljak1 = Ponedeljak, bez obzira na redosled izbora
      if (source.openedAt < target.openedAt) [target, source] = [source, target];
      if (target.status !== 'CLOSED' || source.status !== 'CLOSED') throw Conflict('DAY_NOT_CLOSED', 'Spajaju se samo zatvorene smene');
      for (const t of ['orders', 'payments', 'refunds', 'staff_shifts', 'cash_shifts']) {
        await tx.execute(sql`UPDATE ${sql.raw(t)} SET business_day_id = ${target.id} WHERE business_day_id = ${source.id}`);
      }
      await tx.delete(businessDays).where(eq(businessDays.id, source.id));
      const closedAt = source.closedAt && target.closedAt && source.closedAt > target.closedAt ? source.closedAt : target.closedAt;
      const [d] = await tx.update(businessDays).set({ closedAt, summary: await this.summarize(tx, u.locationId, target.id) })
        .where(eq(businessDays.id, target.id)).returning();
      await audit(tx, u, 'day.merge', 'business_day', target.id, { from: { id: source.id, name: source.name, date: source.date } });
      return d;
    });
  }

  /**
   * Podela smene u zadato vreme (npr. dan nije zatvoren juče, presek u 05:00): sve posle preseka prelazi u novu smenu
   * sa datumom preseka. Ako je smena bila otvorena, stari deo se zatvara, a nova ostaje otvorena.
   */
  async split(u: AuthUser, id: string, dto: SplitDayDto) {
    return this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(businessDays).where(and(eq(businessDays.id, id), eq(businessDays.locationId, u.locationId))).for('update');
      if (!d) throw NotFound('Smena');
      const [{ at }] = await rows<{ at: Date }>(tx, sql`SELECT (${dto.at}::timestamp AT TIME ZONE (SELECT timezone FROM locations WHERE id = ${u.locationId})) AS at`);
      const cut = new Date(at);
      const date = dto.at.slice(0, 10);
      if (cut <= d.openedAt) throw Invalid('SPLIT_BEFORE_OPEN', 'Presek mora biti posle otvaranja smene');
      if (d.closedAt && cut >= d.closedAt) throw Invalid('SPLIT_AFTER_CLOSE', 'Presek mora biti pre zatvaranja smene');
      if (date < d.date) throw Invalid('SPLIT_DATE', 'Datum preseka je pre datuma smene');
      const name = await this.freeName(tx, u.locationId, date, dayName(date));
      const wasOpen = d.status === 'OPEN';
      // Stari deo se zatvara u trenutku preseka (pre unosa nove smene zbog pravila "jedna otvorena smena").
      await tx.update(businessDays).set({ status: 'CLOSED', closedAt: cut, closedById: d.closedById ?? u.userId }).where(eq(businessDays.id, d.id));
      const [n] = await tx.insert(businessDays).values({
        locationId: u.locationId, date, name, openedById: u.userId, openedAt: cut,
        status: wasOpen ? 'OPEN' : 'CLOSED', closedAt: wasOpen ? null : d.closedAt, closedById: wasOpen ? null : d.closedById,
      }).returning();
      await tx.execute(sql`UPDATE orders SET business_day_id = ${n.id} WHERE business_day_id = ${d.id}
        AND (closed_at >= ${cut} OR (closed_at IS NULL AND opened_at >= ${cut}) OR status = 'OPEN')`);
      // Uplate idu za svojim računom (inače bi pazar smene i računi smene bili različiti).
      await tx.execute(sql`UPDATE payments SET business_day_id = ${n.id} WHERE business_day_id = ${d.id}
        AND order_id IN (SELECT id FROM orders WHERE business_day_id = ${n.id})`);
      await tx.execute(sql`UPDATE refunds SET business_day_id = ${n.id} WHERE business_day_id = ${d.id} AND created_at >= ${cut}`);
      await tx.execute(sql`UPDATE staff_shifts SET business_day_id = ${n.id} WHERE business_day_id = ${d.id} AND started_at >= ${cut}`);
      await tx.execute(sql`UPDATE cash_shifts SET business_day_id = ${n.id} WHERE business_day_id = ${d.id} AND (opened_at >= ${cut} OR status = 'OPEN')`);
      await tx.update(businessDays).set({ summary: await this.summarize(tx, u.locationId, d.id) }).where(eq(businessDays.id, d.id));
      if (!wasOpen) await tx.update(businessDays).set({ summary: await this.summarize(tx, u.locationId, n.id) }).where(eq(businessDays.id, n.id));
      await audit(tx, u, 'day.split', 'business_day', d.id, { at: dto.at, newDayId: n.id, newName: name });
      return { before: d.id, after: n };
    });
  }

  async calendar(u: AuthUser, q: CalendarQuery) {
    return rows(this.db, sql`
      SELECT d.id, d.date::text AS date, d.name, d.status, d.opened_at AS "openedAt", d.closed_at AS "closedAt",
        ob.full_name AS "openedBy", cb.full_name AS "closedBy",
        (SELECT count(*)::int FROM orders o WHERE o.business_day_id = d.id AND o.status = 'PAID') AS orders,
        (SELECT coalesce(sum(o.total),0)::numeric(14,2)::text FROM orders o WHERE o.business_day_id = d.id AND o.status = 'PAID') AS gross,
        (SELECT (coalesce(sum(p.amount),0) - coalesce((SELECT sum(r.total) FROM refunds r WHERE r.business_day_id = d.id), 0))::numeric(14,2)::text FROM payments p WHERE p.business_day_id = d.id AND p.method <> 'REPRESENTATION') AS collected,
        (SELECT count(*)::int FROM orders o WHERE o.business_day_id = d.id AND o.status = 'OPEN') AS "openOrders"
      FROM business_days d
      JOIN users ob ON ob.id = d.opened_by_id LEFT JOIN users cb ON cb.id = d.closed_by_id
      WHERE d.location_id = ${u.locationId} AND to_char(d.date, 'YYYY-MM') = ${q.month}
      ORDER BY d.date`);
  }

  async detail(u: AuthUser, id: string) {
    const [d] = await this.db.select().from(businessDays)
      .where(and(eq(businessDays.id, id), eq(businessDays.locationId, u.locationId)));
    if (!d) throw NotFound('Poslovni dan');
    const sales = await computeSales(this.db, u.locationId, { kind: 'day', businessDayId: id });
    const shiftRows = await this.db.select({ id: cashShifts.id }).from(cashShifts)
      .where(eq(cashShifts.businessDayId, id)).orderBy(asc(cashShifts.openedAt));
    const cash = [];
    for (const s of shiftRows) cash.push(await cashShiftSummary(this.db, s.id));
    const staff = await this.db.select().from(staffShifts).where(eq(staffShifts.businessDayId, id)).orderBy(asc(staffShifts.startedAt));
    const staffOut = [];
    for (const s of staff) {
      staffOut.push({ id: s.id, status: s.status, ...(s.summary as object ?? await staffShiftSummary(this.db, s)) });
    }
    return { day: d, sales, cashShifts: cash, staffShifts: staffOut };
  }

  // ---------- smena zaposlenog ----------

  async myShift(u: AuthUser) {
    const [s] = await this.db.select().from(staffShifts)
      .where(and(eq(staffShifts.locationId, u.locationId), eq(staffShifts.userId, u.userId), eq(staffShifts.status, 'OPEN')));
    if (!s) {
      const openOrders = await this.db.select({ id: orders.id }).from(orders)
        .where(and(eq(orders.locationId, u.locationId), eq(orders.waiterId, u.userId), eq(orders.status, 'OPEN')));
      return { shift: null, openOrdersCount: openOrders.length };
    }
    return { shift: { id: s.id, status: s.status, businessDayId: s.businessDayId }, summary: await staffShiftSummary(this.db, s) };
  }

  async staffShift(u: AuthUser, id: string) {
    const [s] = await this.db.select().from(staffShifts)
      .where(and(eq(staffShifts.id, id), eq(staffShifts.locationId, u.locationId)));
    if (!s || (s.userId !== u.userId && !u.permissions.includes(P.ORDER_READ_ALL))) throw NotFound('Smena');
    return { shift: { id: s.id, status: s.status, businessDayId: s.businessDayId }, summary: s.summary ?? await staffShiftSummary(this.db, s) };
  }

  async listStaffShifts(u: AuthUser, q: StaffShiftsQuery) {
    const conds = [eq(staffShifts.locationId, u.locationId)];
    if (q.businessDayId) conds.push(eq(staffShifts.businessDayId, q.businessDayId));
    if (!u.permissions.includes(P.ORDER_READ_ALL)) conds.push(eq(staffShifts.userId, u.userId));
    return this.db.select({ id: staffShifts.id, userId: staffShifts.userId, fullName: users.fullName, status: staffShifts.status,
      startedAt: staffShifts.startedAt, endedAt: staffShifts.endedAt, businessDayId: staffShifts.businessDayId })
      .from(staffShifts).innerJoin(users, eq(users.id, staffShifts.userId))
      .where(and(...conds)).orderBy(desc(staffShifts.startedAt)).limit(200);
  }

  /** Kraj smene zaposlenog: dozvoljen tek kada na njemu nema otvorenih računa (prebaciti ih drugom). */
  async endMyShift(u: AuthUser) {
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(staffShifts)
        .where(and(eq(staffShifts.locationId, u.locationId), eq(staffShifts.userId, u.userId), eq(staffShifts.status, 'OPEN')))
        .for('update');
      if (!s) throw Conflict('NO_OPEN_STAFF_SHIFT', 'Nemate otvorenu smenu');
      const now = new Date();
      const summary = await staffShiftSummary(tx, { ...s, endedAt: now });
      if (summary.openOrders.length) {
        throw Conflict('STAFF_HAS_OPEN_ORDERS',
          `Na vama je još ${summary.openOrders.length} otvorenih računa. Prebacite ih drugom konobaru ili ih naplatite.`,
          { openOrders: summary.openOrders });
      }
      await tx.update(staffShifts).set({ status: 'CLOSED', endedAt: now, endedById: u.userId, summary })
        .where(eq(staffShifts.id, s.id));
      await audit(tx, u, 'staff_shift.end', 'staff_shift', s.id, {
        collected: summary.collected.total, cash: summary.collected.cashToHandOver, receipts: summary.closedReceipts.count,
      });
      return { shift: { id: s.id, status: 'CLOSED' }, summary };
    });
  }

  /** Aktivni zaposleni koji mogu da preuzmu račune (za prebacivanje). */
  async waiters(u: AuthUser) {
    return this.db.select({ id: users.id, fullName: users.fullName, role: roles.code, roleName: roles.name })
      .from(users).innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.organizationId, u.organizationId), eq(users.active, true),
        sql`${P.ORDER_WRITE} = ANY(${roles.permissions})`))
      .orderBy(asc(users.fullName));
  }
}

@ApiTags('business-days') @ApiBearerAuth()
@Controller()
export class DayController {
  constructor(private readonly svc: DayService) {}

  @Get('business-days/current') @RequirePermissions(P.ORDER_READ)
  current(@CurrentUser() u: AuthUser) { return this.svc.current(u); }

  @Get('business-days/current/end-of-day') @RequirePermissions(P.DAY_MANAGE)
  endOfDay(@CurrentUser() u: AuthUser) { return this.svc.endOfDay(u); }
  @Get('business-days/next') @RequirePermissions(P.ORDER_READ)
  next(@CurrentUser() u: AuthUser) { return this.svc.next(u); }
  @Post('business-days/open') @RequirePermissions(P.DAY_MANAGE)
  open(@CurrentUser() u: AuthUser, @Body() dto: OpenDayDto) { return this.svc.open(u, dto); }

  @Post('business-days/merge') @HttpCode(200) @RequirePermissions(P.DAY_MANAGE)
  merge(@CurrentUser() u: AuthUser, @Body() dto: MergeDaysDto) { return this.svc.merge(u, dto); }
  @Post('business-days/:id/split') @HttpCode(200) @RequirePermissions(P.DAY_MANAGE)
  split(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SplitDayDto) { return this.svc.split(u, id, dto); }
  @Post('business-days/current/close') @HttpCode(200) @RequirePermissions(P.DAY_MANAGE)
  close(@CurrentUser() u: AuthUser) { return this.svc.close(u); }

  @Get('business-days') @RequirePermissions(P.REPORT_READ)
  calendar(@CurrentUser() u: AuthUser, @Query() q: CalendarQuery) { return this.svc.calendar(u, q); }

  @Get('business-days/:id') @RequirePermissions(P.REPORT_READ)
  detail(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.detail(u, id); }

  @Get('staff-shifts/current') @RequirePermissions(P.ORDER_READ)
  myShift(@CurrentUser() u: AuthUser) { return this.svc.myShift(u); }

  @Post('staff-shifts/current/end') @HttpCode(200) @RequirePermissions(P.ORDER_READ)
  endMyShift(@CurrentUser() u: AuthUser) { return this.svc.endMyShift(u); }

  @Get('staff-shifts') @RequirePermissions(P.ORDER_READ)
  listStaffShifts(@CurrentUser() u: AuthUser, @Query() q: StaffShiftsQuery) { return this.svc.listStaffShifts(u, q); }

  @Get('staff-shifts/:id') @RequirePermissions(P.ORDER_READ)
  staffShift(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.staffShift(u, id); }

  @Get('staff/waiters') @RequirePermissions(P.ORDER_READ)
  waiters(@CurrentUser() u: AuthUser) { return this.svc.waiters(u); }
}

@Module({ controllers: [DayController], providers: [DayService] })
export class DayModule {}

const DAY_NAMES = ['Nedelja', 'Ponedeljak', 'Utorak', 'Sreda', 'Četvrtak', 'Petak', 'Subota'];
/** Naziv dana u nedelji za datum (YYYY-MM-DD). */
export const dayName = (date: string) => DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()];
