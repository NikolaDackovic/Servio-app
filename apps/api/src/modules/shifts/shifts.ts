import {
  Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { cashMovements, cashShifts, orders, payments } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { dec, money } from '../../common/money';
import { requireOpenDay } from '../day/day.helpers';

const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

class OpenShiftDto {
  @Matches(AMOUNT_RE, { message: 'Početna gotovina mora biti decimalni iznos (npr. "5000.00")' }) openingCash: string;
}
class CloseShiftDto {
  /** Prebrojana gotovina; ako se izostavi, uzima se očekivana (kasa bez prebrojavanja pri zatvaranju). */
  @IsOptional() @Matches(AMOUNT_RE) countedCash?: string;
}
class CashMovementDto {
  @IsIn(['PAY_IN', 'PAY_OUT']) type: 'PAY_IN' | 'PAY_OUT';
  @Matches(AMOUNT_RE) amount: string;
  @IsString() @Length(2, 200) reason: string;
}

export function requireDevice(u: AuthUser): string {
  if (!u.deviceId) {
    throw Invalid('DEVICE_REQUIRED', 'Ova akcija zahteva prijavu na registrovanoj kasi (uređaju)');
  }
  return u.deviceId;
}

/** Vraća otvorenu smenu za uređaj prijavljenog korisnika (opciono zaključanu FOR UPDATE). */
export async function findOpenShift(tx: DbOrTx, u: AuthUser, lock = false) {
  const q = tx.select().from(cashShifts)
    .where(and(eq(cashShifts.deviceId, requireDevice(u)), eq(cashShifts.status, 'OPEN')));
  const [s] = lock ? await q.for('update') : await q;
  return s;
}

/**
 * Očekivana gotovina = početna + gotovinske naplate (primenjeni iznos, kusur je već oduzet)
 *                      + uplate u blagajnu − isplate iz blagajne.
 */
export async function cashShiftSummary(tx: DbOrTx, shiftId: string) {
  const [shift] = await tx.select().from(cashShifts).where(eq(cashShifts.id, shiftId));
  const byMethod = await tx
    .select({ method: payments.method, total: sql<string>`coalesce(sum(${payments.amount}),0)::numeric(14,2)::text`, count: sql<number>`count(*)::int` })
    .from(payments).where(eq(payments.shiftId, shiftId)).groupBy(payments.method);
  const mv = await tx
    .select({ type: cashMovements.type, total: sql<string>`coalesce(sum(${cashMovements.amount}),0)::numeric(14,2)::text` })
    .from(cashMovements).where(eq(cashMovements.shiftId, shiftId)).groupBy(cashMovements.type);
  const cash = dec(byMethod.find((m) => m.method === 'CASH')?.total);
  const payIn = dec(mv.find((m) => m.type === 'PAY_IN')?.total);
  const payOut = dec(mv.find((m) => m.type === 'PAY_OUT')?.total);
  const expectedCash = dec(shift.openingCash).add(cash).add(payIn).sub(payOut);
  return {
    shift,
    payments: byMethod,
    payIn: money(payIn), payOut: money(payOut),
    expectedCash: money(expectedCash),
  };
}


@Injectable()
export class ShiftsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  summary(tx: DbOrTx, shiftId: string) {
    return cashShiftSummary(tx, shiftId);
  }

  async current(u: AuthUser) {
    const s = await findOpenShift(this.db, u);
    if (!s) return { shift: null };
    return this.summary(this.db, s.id);
  }

  async open(u: AuthUser, dto: OpenShiftDto) {
    const deviceId = requireDevice(u);
    return this.db.transaction(async (tx) => {
      const day = await requireOpenDay(tx, u);
      const existing = await findOpenShift(tx, u);
      if (existing) throw Conflict('SHIFT_ALREADY_OPEN', 'Na ovoj kasi je već otvorena smena', { shiftId: existing.id });
      const [s] = await tx.insert(cashShifts).values({
        locationId: u.locationId, deviceId, businessDayId: day.id, openedById: u.userId, openingCash: money(dto.openingCash),
      }).returning();
      await audit(tx, u, 'shift.open', 'shift', s.id, { openingCash: s.openingCash });
      return s;
    });
  }

  async movement(u: AuthUser, dto: CashMovementDto) {
    return this.db.transaction(async (tx) => {
      const s = await findOpenShift(tx, u, true);
      if (!s) throw Conflict('NO_OPEN_SHIFT', 'Nema otvorene smene na ovoj kasi');
      const [m] = await tx.insert(cashMovements).values({
        shiftId: s.id, type: dto.type, amount: money(dto.amount), reason: dto.reason, createdById: u.userId,
      }).returning();
      await audit(tx, u, `shift.${dto.type.toLowerCase()}`, 'shift', s.id, { amount: m.amount, reason: m.reason });
      return m;
    });
  }

  /** Nenaplaćeni računi u lokalu (svih konobara) — šta blokira zatvaranje smene. */
  async closeCheck(u: AuthUser) {
    const r = await this.db.execute(sql`
      SELECT o.id, o.number, o.total::text AS total, t.name AS "tableName", o.tab_name AS "tabName", us.full_name AS "waiterName"
      FROM orders o JOIN users us ON us.id = o.waiter_id LEFT JOIN dining_tables t ON t.id = o.table_id
      WHERE o.location_id = ${u.locationId} AND o.status = 'OPEN' AND NOT coalesce(t.is_room, false)
        AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)
      ORDER BY o.opened_at`);
    return { openOrders: r.rows };
  }

  async close(u: AuthUser, dto: CloseShiftDto) {
    return this.db.transaction(async (tx) => {
      const s = await findOpenShift(tx, u, true);
      if (!s) throw Conflict('NO_OPEN_SHIFT', 'Nema otvorene smene na ovoj kasi');
      // Smena se ne zatvara dok u lokalu postoji nenaplaćen sto (račun sa stavkama).
      // Prazni računi (otvoren sto bez ijednog artikla) se pri tome samo zatvaraju.
      const open = await tx.select({ id: orders.id, number: orders.number,
        items: sql<number>`(select count(*)::int from order_items oi where oi.order_id = "orders"."id")`,
        room: sql<boolean>`exists (select 1 from dining_tables t where t.id = "orders"."table_id" and t.is_room)` })
        .from(orders).where(and(eq(orders.locationId, u.locationId), eq(orders.status, 'OPEN')));
      // hotelske sobe ne blokiraju zatvaranje (gost plaća pri odjavi)
      const unpaid = open.filter((o) => o.items > 0 && !o.room);
      if (unpaid.length) {
        throw Conflict('SHIFT_HAS_OPEN_ORDERS', `Smena ne može da se zatvori: ${unpaid.length} nenaplaćen${unpaid.length === 1 ? ' sto' : 'ih stolova'}. Svi stolovi moraju biti naplaćeni.`,
          { openOrders: unpaid.map((o) => o.number) });
      }
      for (const o of open.filter((x) => x.items === 0)) {
        // samo prazni računi otvoreni na ovoj kasi (drugi konobari upravo otvaraju svoje stolove)
        await tx.update(orders).set({ status: 'CANCELLED', closedAt: new Date(), closedById: u.userId, updatedAt: new Date(), version: sql`${orders.version} + 1` })
          .where(and(eq(orders.id, o.id), eq(orders.deviceId, s.deviceId)));
      }
      const sum = await this.summary(tx, s.id);
      const counted = dec(dto.countedCash ?? sum.expectedCash);
      const [closed] = await tx.update(cashShifts).set({
        status: 'CLOSED', closedById: u.userId, closedAt: new Date(),
        expectedCash: sum.expectedCash, countedCash: money(counted),
        difference: money(counted.sub(dec(sum.expectedCash))),
      }).where(eq(cashShifts.id, s.id)).returning();
      await audit(tx, u, 'shift.close', 'shift', s.id, {
        expectedCash: closed.expectedCash, countedCash: closed.countedCash, difference: closed.difference,
      });
      return { ...sum, shift: closed };
    });
  }

  async report(u: AuthUser, id: string) {
    const [s] = await this.db.select({ id: cashShifts.id }).from(cashShifts)
      .where(and(eq(cashShifts.id, id), eq(cashShifts.locationId, u.locationId)));
    if (!s) throw NotFound('Smena');
    return this.summary(this.db, id);
  }

  list(u: AuthUser) {
    return this.db.select().from(cashShifts).where(eq(cashShifts.locationId, u.locationId))
      .orderBy(desc(cashShifts.openedAt)).limit(100);
  }
}

@ApiTags('shifts') @ApiBearerAuth()
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly svc: ShiftsService) {}

  @Get() @RequirePermissions(P.SHIFT_MANAGE)
  list(@CurrentUser() u: AuthUser) { return this.svc.list(u); }

  @Get('current') @RequirePermissions(P.ORDER_READ)
  current(@CurrentUser() u: AuthUser) { return this.svc.current(u); }

  @Post('open') @RequirePermissions(P.SHIFT_MANAGE)
  open(@CurrentUser() u: AuthUser, @Body() dto: OpenShiftDto) { return this.svc.open(u, dto); }

  @Post('current/cash-movements') @RequirePermissions(P.SHIFT_MANAGE)
  movement(@CurrentUser() u: AuthUser, @Body() dto: CashMovementDto) { return this.svc.movement(u, dto); }

  /** Pre zatvaranja smene: nenaplaćeni računi u lokalu (svih konobara), da kasa odmah pokaže šta blokira zatvaranje. */
  @Get('close-check') @RequirePermissions(P.ORDER_READ)
  closeCheck(@CurrentUser() u: AuthUser) { return this.svc.closeCheck(u); }

  @Post('close') @HttpCode(200) @RequirePermissions(P.SHIFT_MANAGE)
  close(@CurrentUser() u: AuthUser, @Body() dto: CloseShiftDto) { return this.svc.close(u, dto); }

  @Get(':id/report') @RequirePermissions(P.SHIFT_MANAGE)
  report(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.report(u, id); }
}

@Module({ controllers: [ShiftsController], providers: [ShiftsService] })
export class ShiftsModule {}
