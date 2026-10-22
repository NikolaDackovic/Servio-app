import { Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { sql, SQL } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { Invalid } from '../../common/errors';
import { dec, money, sum } from '../../common/money';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class SalesQuery {
  /** Lokalni datum početka (uključivo), npr. 2026-10-22. Ne koristi se uz businessDayId. */
  @IsOptional() @Matches(DATE_RE) from?: string;
  /** Lokalni datum kraja (uključivo) */
  @IsOptional() @Matches(DATE_RE) to?: string;
  /** Izveštaj za jedan poslovni dan (sav promet tog dana, i posle ponoći) */
  @IsOptional() @IsUUID() businessDayId?: string;
  @IsOptional() @IsUUID() waiterId?: string;
  @IsOptional() @IsUUID() deviceId?: string;
}

export type SalesScope =
  | { kind: 'range'; from: string; to: string }
  | { kind: 'day'; businessDayId: string };

export interface SalesFilters { waiterId?: string; deviceId?: string }

/**
 * Izveštaji se računaju isključivo iz baze, u vremenskoj zoni lokala.
 *
 * Definicije (dosledne u svim izveštajima):
 *  - "Promet" = zbir iznosa ZAKLJUČENIH (PAID) računa. Stornirane stavke nisu uključene.
 *  - "Naplata" = zbir svih plaćanja (uključuje i delimične naplate još otvorenih računa).
 *  - "Storna" = vrednost storniranih stavki.
 * Za period po datumu: vreme zatvaranja / plaćanja / storniranja je u periodu.
 * Za poslovni dan: zapisi pripadaju tom danu (business_day_id), bez obzira na sat (i posle ponoći).
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async sales(u: AuthUser, q: SalesQuery) {
    let scope: SalesScope;
    if (q.businessDayId) scope = { kind: 'day', businessDayId: q.businessDayId };
    else {
      if (!q.from || !q.to) throw Invalid('INVALID_RANGE', 'Navedite period (from, to) ili poslovni dan (businessDayId)');
      if (q.from > q.to) throw Invalid('INVALID_RANGE', 'Datum "od" je posle datuma "do"');
      scope = { kind: 'range', from: q.from, to: q.to };
    }
    return computeSales(this.db, u.locationId, scope, { waiterId: q.waiterId, deviceId: q.deviceId });
  }
}

async function rows<T>(db: DbOrTx, q: SQL): Promise<T[]> {
  return (await db.execute(q)).rows as T[];
}

/** Zajednički obračun za izveštaj, zaključak dana i kalendar. */
export async function computeSales(db: DbOrTx, locationId: string, scope: SalesScope, f: SalesFilters = {}) {
  const [loc] = await rows<{ tz: string }>(db, sql`SELECT timezone AS tz FROM locations WHERE id = ${locationId}`);
  const tz = loc.tz;

  let oScope: SQL, pScope: SQL, vScope: SQL;
  if (scope.kind === 'range') {
    const start = sql`(${scope.from}::date)::timestamp AT TIME ZONE ${tz}`;
    const end = sql`((${scope.to}::date) + 1)::timestamp AT TIME ZONE ${tz}`;
    oScope = sql`o.closed_at >= ${start} AND o.closed_at < ${end}`;
    pScope = sql`p.created_at >= ${start} AND p.created_at < ${end}`;
    vScope = sql`i.voided_at >= ${start} AND i.voided_at < ${end}`;
  } else {
    oScope = sql`o.business_day_id = ${scope.businessDayId}`;
    pScope = sql`p.business_day_id = ${scope.businessDayId}`;
    vScope = sql`o.business_day_id = ${scope.businessDayId}`;
  }
  const extra = sql`${f.waiterId ? sql`AND o.waiter_id = ${f.waiterId}` : sql``} ${f.deviceId ? sql`AND o.device_id = ${f.deviceId}` : sql``}`;
  const oFilter = sql`o.location_id = ${locationId} AND o.status = 'PAID' AND ${oScope} ${extra}`;

  const [totals] = await rows<{ orders: number; gross: string }>(db, sql`
    SELECT count(*)::int AS orders, coalesce(sum(o.total),0)::numeric(14,2)::text AS gross
    FROM orders o WHERE ${oFilter}`);

  const taxes = await rows<{ label: string; rate: string; gross: string }>(db, sql`
    SELECT i.tax_label AS label, i.tax_rate::text AS rate, sum(i.line_total)::numeric(14,2)::text AS gross
    FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE ${oFilter} AND i.status <> 'VOIDED'
    GROUP BY i.tax_label, i.tax_rate ORDER BY i.tax_label`);

  const byProduct = await rows<{ productId: string; name: string; quantity: string; gross: string }>(db, sql`
    SELECT i.product_id AS "productId", min(i.name) AS name, sum(i.quantity)::numeric(12,3)::text AS quantity,
           sum(i.line_total)::numeric(14,2)::text AS gross
    FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE ${oFilter} AND i.status <> 'VOIDED'
    GROUP BY i.product_id ORDER BY sum(i.line_total) DESC`);

  const byWaiter = await rows<{ waiterId: string; name: string; orders: number; gross: string }>(db, sql`
    SELECT o.waiter_id AS "waiterId", u.full_name AS name, count(*)::int AS orders, sum(o.total)::numeric(14,2)::text AS gross
    FROM orders o JOIN users u ON u.id = o.waiter_id
    WHERE ${oFilter} GROUP BY o.waiter_id, u.full_name ORDER BY sum(o.total) DESC`);

  const byHour = await rows<{ hour: number; orders: number; gross: string }>(db, sql`
    SELECT extract(hour FROM o.closed_at AT TIME ZONE ${tz})::int AS hour, count(*)::int AS orders,
           sum(o.total)::numeric(14,2)::text AS gross
    FROM orders o WHERE ${oFilter} GROUP BY 1 ORDER BY 1`);

  const pFilter = sql`o.location_id = ${locationId} AND ${pScope} ${extra}`;
  const paymentsByMethod = await rows<{ method: string; mode: string; count: number; amount: string }>(db, sql`
    SELECT p.method, p.mode, count(*)::int AS count, sum(p.amount)::numeric(14,2)::text AS amount
    FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${pFilter}
    GROUP BY p.method, p.mode ORDER BY p.method`);

  const [voids] = await rows<{ count: number; amount: string }>(db, sql`
    SELECT count(*)::int AS count, coalesce(sum(i.line_total),0)::numeric(14,2)::text AS amount
    FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.location_id = ${locationId} AND i.status = 'VOIDED' AND ${vScope} ${extra}`);

  const [open] = await rows<{ count: number; total: string; paid: string }>(db, sql`
    SELECT count(*)::int AS count, coalesce(sum(total),0)::numeric(14,2)::text AS total,
           coalesce(sum(paid_total),0)::numeric(14,2)::text AS paid
    FROM orders WHERE location_id = ${locationId} AND status = 'OPEN'`);

  const taxSummary = taxes.map((t) => {
    const r = dec(t.rate);
    const tax = r.isZero() ? dec(0) : dec(t.gross).mul(r).div(r.add(100)).toDecimalPlaces(2);
    return { label: t.label, rate: t.rate, gross: t.gross, tax: money(tax), net: money(dec(t.gross).sub(tax)) };
  });

  return {
    period: scope.kind === 'range' ? { from: scope.from, to: scope.to, timezone: tz } : { businessDayId: scope.businessDayId, timezone: tz },
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

@ApiTags('reports') @ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}
  @Get('sales') @RequirePermissions(P.REPORT_READ)
  sales(@CurrentUser() u: AuthUser, @Query() q: SalesQuery) { return this.svc.sales(u, q); }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
