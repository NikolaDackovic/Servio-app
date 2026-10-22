import { Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { Invalid } from '../../common/errors';
import { dec, money, sum } from '../../common/money';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class SalesQuery {
  /** Lokalni datum početka (uključivo), npr. 2026-10-22 */
  @Matches(DATE_RE) from: string;
  /** Lokalni datum kraja (uključivo) */
  @Matches(DATE_RE) to: string;
  @IsOptional() @IsUUID() waiterId?: string;
  @IsOptional() @IsUUID() deviceId?: string;
}

/**
 * Izveštaji se računaju isključivo iz baze, u vremenskoj zoni lokala.
 *
 * Definicije (dosledne u svim izveštajima):
 *  - "Promet" = zbir iznosa ZAKLJUČENIH (PAID) računa čije je vreme zatvaranja u periodu. Stornirane stavke nisu uključene.
 *  - "Naplata" = zbir svih plaćanja evidentiranih u periodu (uključuje i delimične naplate još otvorenih računa).
 *    Za period bez delimično naplaćenih otvorenih računa promet = naplata (proverava se testom).
 *  - "Storna" = vrednost stavki storniranih u periodu (vreme storniranja).
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
    return (await this.db.execute(q)).rows as T[];
  }

  async sales(u: AuthUser, q: SalesQuery) {
    if (q.from > q.to) throw Invalid('INVALID_RANGE', 'Datum "od" je posle datuma "do"');
    const [loc] = await this.rows<{ tz: string }>(sql`SELECT timezone AS tz FROM locations WHERE id = ${u.locationId}`);
    const tz = loc.tz;
    // [from 00:00, to+1 00:00) u zoni lokala → UTC
    const start = sql`(${q.from}::date)::timestamp AT TIME ZONE ${tz}`;
    const end = sql`((${q.to}::date) + 1)::timestamp AT TIME ZONE ${tz}`;
    const oFilter = sql`o.location_id = ${u.locationId} AND o.status = 'PAID' AND o.closed_at >= ${start} AND o.closed_at < ${end}
      ${q.waiterId ? sql`AND o.waiter_id = ${q.waiterId}` : sql``}
      ${q.deviceId ? sql`AND o.device_id = ${q.deviceId}` : sql``}`;

    const [totals] = await this.rows<{ orders: number; gross: string }>(sql`
      SELECT count(*)::int AS orders, coalesce(sum(o.total),0)::numeric(14,2)::text AS gross
      FROM orders o WHERE ${oFilter}`);

    const taxes = await this.rows<{ label: string; rate: string; gross: string }>(sql`
      SELECT i.tax_label AS label, i.tax_rate::text AS rate, sum(i.line_total)::numeric(14,2)::text AS gross
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE ${oFilter} AND i.status <> 'VOIDED'
      GROUP BY i.tax_label, i.tax_rate ORDER BY i.tax_label`);

    const byProduct = await this.rows<{ productId: string; name: string; quantity: string; gross: string }>(sql`
      SELECT i.product_id AS "productId", min(i.name) AS name, sum(i.quantity)::numeric(12,3)::text AS quantity,
             sum(i.line_total)::numeric(14,2)::text AS gross
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE ${oFilter} AND i.status <> 'VOIDED'
      GROUP BY i.product_id ORDER BY sum(i.line_total) DESC`);

    const byWaiter = await this.rows<{ waiterId: string; name: string; orders: number; gross: string }>(sql`
      SELECT o.waiter_id AS "waiterId", u.full_name AS name, count(*)::int AS orders, sum(o.total)::numeric(14,2)::text AS gross
      FROM orders o JOIN users u ON u.id = o.waiter_id
      WHERE ${oFilter} GROUP BY o.waiter_id, u.full_name ORDER BY sum(o.total) DESC`);

    const byHour = await this.rows<{ hour: number; orders: number; gross: string }>(sql`
      SELECT extract(hour FROM o.closed_at AT TIME ZONE ${tz})::int AS hour, count(*)::int AS orders,
             sum(o.total)::numeric(14,2)::text AS gross
      FROM orders o WHERE ${oFilter} GROUP BY 1 ORDER BY 1`);

    const pFilter = sql`o.location_id = ${u.locationId} AND p.created_at >= ${start} AND p.created_at < ${end}
      ${q.waiterId ? sql`AND o.waiter_id = ${q.waiterId}` : sql``}
      ${q.deviceId ? sql`AND p.device_id = ${q.deviceId}` : sql``}`;
    const paymentsByMethod = await this.rows<{ method: string; mode: string; count: number; amount: string }>(sql`
      SELECT p.method, p.mode, count(*)::int AS count, sum(p.amount)::numeric(14,2)::text AS amount
      FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${pFilter}
      GROUP BY p.method, p.mode ORDER BY p.method`);

    const [voids] = await this.rows<{ count: number; amount: string }>(sql`
      SELECT count(*)::int AS count, coalesce(sum(i.line_total),0)::numeric(14,2)::text AS amount
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.location_id = ${u.locationId} AND i.status = 'VOIDED' AND i.voided_at >= ${start} AND i.voided_at < ${end}`);

    const [open] = await this.rows<{ count: number; total: string; paid: string }>(sql`
      SELECT count(*)::int AS count, coalesce(sum(total),0)::numeric(14,2)::text AS total,
             coalesce(sum(paid_total),0)::numeric(14,2)::text AS paid
      FROM orders WHERE location_id = ${u.locationId} AND status = 'OPEN'`);

    const taxSummary = taxes.map((t) => {
      const r = dec(t.rate);
      const tax = r.isZero() ? dec(0) : dec(t.gross).mul(r).div(r.add(100)).toDecimalPlaces(2);
      return { label: t.label, rate: t.rate, gross: t.gross, tax: money(tax), net: money(dec(t.gross).sub(tax)) };
    });

    return {
      period: { from: q.from, to: q.to, timezone: tz },
      sales: { orders: totals.orders, gross: totals.gross, averageOrder: totals.orders ? money(dec(totals.gross).div(totals.orders)) : '0.00' },
      taxes: taxSummary,
      payments: {
        total: money(sum(paymentsByMethod.map((p) => p.amount))),
        byMethod: paymentsByMethod,
        containsTestPayments: paymentsByMethod.some((p) => p.mode === 'TEST'),
      },
      byProduct, byWaiter, byHour,
      voids,
      openOrdersNow: open,
    };
  }
}

@ApiTags('reports') @ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}
  @Get('sales') @RequirePermissions(P.REPORT_READ)
  sales(@CurrentUser() u: AuthUser, @Query() q: SalesQuery) { return this.svc.sales(u, q); }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
