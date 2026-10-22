import {
  Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { businessDays, cashShifts, devices, diningTables, orders, roles, staffShifts, users } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { money, sum } from '../../common/money';
import { computeSales } from '../reports/reports';
import { cashShiftSummary } from '../shifts/shifts';
import { findOpenDay } from './day.helpers';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class OpenDayDto {
  /** Datum poslovnog dana (podrazumevano: današnji datum u zoni lokala) */
  @IsOptional() @Matches(DATE_RE) date?: string;
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
  const cash = collected.find((c) => c.method === 'CASH')?.amount ?? '0.00';
  return {
    userId: s.userId, fullName: user?.fullName, startedAt: s.startedAt, endedAt: s.endedAt,
    collected: {
      total: money(sum(collected.filter((c) => c.method !== 'REPRESENTATION').map((c) => c.amount))),
      representation: collected.find((c) => c.method === 'REPRESENTATION')?.amount ?? '0.00',
      cashToHandOver: cash, byMethod: collected,
    },
    closedReceipts: closed, voids,
    openOrders,
  };
}

@Injectable()
export class DayService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async current(u: AuthUser) {
    const d = await findOpenDay(this.db, u.locationId);
    if (!d) return { day: null };
    return { day: d, sales: await computeSales(this.db, u.locationId, { kind: 'day', businessDayId: d.id }) };
  }

  async open(u: AuthUser, dto: OpenDayDto) {
    return this.db.transaction(async (tx) => {
      const existing = await findOpenDay(tx, u.locationId, true);
      if (existing) throw Conflict('DAY_ALREADY_OPEN', `Poslovni dan ${existing.date} je već otvoren`, { dayId: existing.id });
      const [loc] = await rows<{ today: string }>(tx, sql`
        SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM locations WHERE id = ${u.locationId}`);
      const date = dto.date ?? loc.today;
      const [last] = await tx.select({ date: businessDays.date }).from(businessDays)
        .where(eq(businessDays.locationId, u.locationId)).orderBy(desc(businessDays.date)).limit(1);
      if (last && date <= last.date) {
        throw Invalid('DAY_DATE_NOT_AFTER_LAST', `Datum mora biti posle poslednjeg poslovnog dana (${last.date})`, { lastDate: last.date });
      }
      const [d] = await tx.insert(businessDays).values({ locationId: u.locationId, date, openedById: u.userId }).returning();
      await audit(tx, u, 'day.open', 'business_day', d.id, { date });
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
        .where(and(eq(orders.locationId, u.locationId), eq(orders.status, 'OPEN')));
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

      const [closed] = await tx.update(businessDays)
        .set({ status: 'CLOSED', closedAt: now, closedById: u.userId, summary })
        .where(eq(businessDays.id, d.id)).returning();
      await audit(tx, u, 'day.close', 'business_day', d.id, { date: d.date, gross: sales.sales.gross, orders: sales.sales.orders });
      return closed;
    });
  }

  /** Kalendar: svi poslovni dani u mesecu sa prometom (računato iz baze). */
  async calendar(u: AuthUser, q: CalendarQuery) {
    return rows(this.db, sql`
      SELECT d.id, d.date::text AS date, d.status, d.opened_at AS "openedAt", d.closed_at AS "closedAt",
        ob.full_name AS "openedBy", cb.full_name AS "closedBy",
        (SELECT count(*)::int FROM orders o WHERE o.business_day_id = d.id AND o.status = 'PAID') AS orders,
        (SELECT coalesce(sum(o.total),0)::numeric(14,2)::text FROM orders o WHERE o.business_day_id = d.id AND o.status = 'PAID') AS gross,
        (SELECT coalesce(sum(p.amount),0)::numeric(14,2)::text FROM payments p WHERE p.business_day_id = d.id AND p.method <> 'REPRESENTATION') AS collected,
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

  @Post('business-days/open') @RequirePermissions(P.DAY_MANAGE)
  open(@CurrentUser() u: AuthUser, @Body() dto: OpenDayDto) { return this.svc.open(u, dto); }

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
