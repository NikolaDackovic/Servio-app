import { Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { NotFound } from '../../common/errors';
import { dec } from '../../common/money';
import { DOC_LABEL, DOC_PREFIX } from './stock';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
class LevelsQuery { @IsOptional() @IsUUID() warehouseId?: string; }
class AsOfQuery { @Matches(DATE_RE) date: string; @IsOptional() @IsUUID() warehouseId?: string; }
class CardQuery { @IsUUID() productId: string; @Matches(DATE_RE) from: string; @Matches(DATE_RE) to: string; }
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
class SoldQuery {
  @Matches(/^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,400}$/, { message: 'dayIds: lista smena' }) dayIds: string;
  @IsOptional() @Matches(TIME_RE) timeFrom?: string;
  @IsOptional() @Matches(TIME_RE) timeTo?: string;
}
class SalesQuery { @IsUUID() productId: string; @Matches(DATE_RE) from: string; @Matches(DATE_RE) to: string; }

/** Robni izveštaji za ADMIN: Zalihe (sa minimalnom zalihom), Stanje robe na dan, prodaja artikla (kartica proizvoda). */
@Injectable()
export class StockReportsService {
  constructor(@Inject(DB) readonly db: Db) {}

  /** Zalihe: sve što se prati na zalihi (sirovine i komadni artikli), ukupno po skladištima ili za jedno skladište. */
  async levels(u: AuthUser, q: LevelsQuery) {
    const r = await this.db.execute(sql`
      SELECT p.id AS "productId", p.code, p.name, p.unit, p.is_sellable AS "isSellable", p.min_stock::text AS "minStock",
        coalesce(sum(b.quantity), 0)::text AS quantity,
        coalesce(sum(b.quantity * b.avg_cost), 0)::numeric(14,2)::text AS value
      FROM products p
      LEFT JOIN stock_balances b ON b.product_id = p.id
        AND b.warehouse_id IN (SELECT w.id FROM warehouses w WHERE w.location_id = ${u.locationId})
        ${q.warehouseId ? sql`AND b.warehouse_id = ${q.warehouseId}` : sql``}
      WHERE p.organization_id = ${u.organizationId} AND p.track_stock AND p.active
      GROUP BY p.id ORDER BY p.is_sellable, p.name`);
    return r.rows.map((x: any) => ({ ...x, belowMin: x.minStock !== null && Number(x.quantity) < Number(x.minStock) }));
  }

  /** Stanje robe na početku izabranog dana (pre otvaranja): poslednje kretanje pre ponoći tog datuma u zoni lokala. */
  async asOf(u: AuthUser, q: AsOfQuery) {
    const r = await this.db.execute(sql`
      WITH tz AS (SELECT timezone FROM locations WHERE id = ${u.locationId}),
      last AS (
        SELECT DISTINCT ON (m.warehouse_id, m.product_id) m.warehouse_id, m.product_id, m.balance_after, m.avg_cost_after
        FROM stock_movements m
        WHERE m.warehouse_id IN (SELECT w.id FROM warehouses w WHERE w.location_id = ${u.locationId})
          ${q.warehouseId ? sql`AND m.warehouse_id = ${q.warehouseId}` : sql``}
          AND m.created_at < ((${q.date}::date)::timestamp AT TIME ZONE (SELECT timezone FROM tz))
        ORDER BY m.warehouse_id, m.product_id, m.seq DESC)
      SELECT p.id AS "productId", p.code, p.name, p.unit, p.is_sellable AS "isSellable",
        sum(l.balance_after)::text AS quantity, sum(l.balance_after * l.avg_cost_after)::numeric(14,2)::text AS value
      FROM last l JOIN products p ON p.id = l.product_id
      GROUP BY p.id ORDER BY p.is_sellable, p.name`);
    return r.rows;
  }

  /**
   * Specifikacija izdatih artikala: prodato po artiklu za izabrane smene (i vreme naplate od-do), razloženo po
   * korisniku, stolu, popustu, grupi, kategoriji (pripremna pozicija), magacinu i vrsti računa - ADMIN filtrira i sabira.
   */
  async soldItems(u: AuthUser, q: SoldQuery) {
    const ids = q.dayIds.split(',');
    const tz = sql`(SELECT timezone FROM locations WHERE id = ${u.locationId})`;
    const r = await this.db.execute(sql`
      WITH ord AS (
        SELECT o.id, o.waiter_id, o.table_id, o.discount_percent,
          CASE WHEN EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.method <> 'REPRESENTATION') THEN 'representation' ELSE 'regular' END AS kind
        FROM orders o
        WHERE o.location_id = ${u.locationId} AND o.status = 'PAID' AND o.business_day_id IN (${sql.join(ids.map((x) => sql`${x}::uuid`), sql`, `)})
          ${q.timeFrom ? sql`AND to_char(o.closed_at AT TIME ZONE ${tz}, 'HH24:MI') >= ${q.timeFrom}` : sql``}
          ${q.timeTo ? sql`AND to_char(o.closed_at AT TIME ZONE ${tz}, 'HH24:MI') <= ${q.timeTo}` : sql``})
      SELECT i.product_id AS "productId", p.code, i.name, i.unit_price::text AS "unitPrice",
        sum(i.quantity)::text AS quantity, sum(i.line_total - i.discount_amount)::numeric(14,2)::text AS total,
        us.full_name AS waiter, coalesce(t.name, '') AS "tableName", ord.discount_percent::text AS "discountPercent", ord.kind,
        coalesce(c.name, '') AS "groupName", coalesce(ps.name, '') AS "stationName",
        coalesce(w.name, (SELECT dw.name FROM warehouses dw WHERE dw.location_id = ${u.locationId} AND dw.is_default LIMIT 1), '') AS "warehouseName"
      FROM order_items i JOIN ord ON ord.id = i.order_id
      JOIN products p ON p.id = i.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN prep_stations ps ON ps.id = coalesce(i.prep_station_id, p.prep_station_id, c.prep_station_id)
      LEFT JOIN warehouses w ON w.id = ps.warehouse_id
      JOIN users us ON us.id = ord.waiter_id
      LEFT JOIN dining_tables t ON t.id = ord.table_id
      WHERE i.status <> 'VOIDED'
      GROUP BY i.product_id, p.code, i.name, i.unit_price, us.full_name, t.name, ord.discount_percent, ord.kind, c.name, ps.name, w.name
      ORDER BY i.name LIMIT 20000`);
    return r.rows;
  }

  /** Kartica proizvoda (prodaja): kada je i koliko artikal prodat, po računima, za period po datumu smene. */
  async productSales(u: AuthUser, q: SalesQuery) {
    const r = await this.db.execute(sql`
      SELECT o.number, o.closed_at AS "closedAt", o.status, bd.date::text AS "dayDate", bd.name AS "dayName",
        t.name AS "tableName", us.full_name AS waiter, i.quantity::text AS quantity, i.unit_price::text AS "unitPrice",
        (i.line_total - i.discount_amount)::numeric(14,2)::text AS total, i.status AS "itemStatus", i.void_reason AS "voidReason"
      FROM order_items i JOIN orders o ON o.id = i.order_id
      JOIN users us ON us.id = o.waiter_id
      LEFT JOIN dining_tables t ON t.id = o.table_id
      LEFT JOIN business_days bd ON bd.id = o.business_day_id
      WHERE o.location_id = ${u.locationId} AND i.product_id = ${q.productId}
        AND bd.date BETWEEN ${q.from} AND ${q.to} AND o.status IN ('PAID', 'CANCELLED')
      ORDER BY o.closed_at NULLS LAST, o.number`);
    const rows = r.rows as any[];
    const sold = rows.filter((x) => x.status === 'PAID' && x.itemStatus !== 'VOIDED');
    return {
      rows,
      totals: {
        quantity: sold.reduce((a, x) => a + Number(x.quantity), 0).toFixed(3),
        amount: sold.reduce((a, x) => a + Number(x.total), 0).toFixed(2),
        voided: rows.filter((x) => x.itemStatus === 'VOIDED').reduce((a, x) => a + Number(x.quantity), 0).toFixed(3),
      },
    };
  }
}

/**
 * Kartica proizvoda (jedna tabela za sve): datum, ulaz, izlaz, stanje, ko je kreirao, dokument.
 * Oznake dokumenata: KS = kasa (prodaja), UF = ulazna faktura, ostale po vrsti robnog dokumenta, ST = storno.
 * Artikal koji se prati na zalihi (sirovina, komadni artikal) ima kretanja zalihe; ostali artikli imaju prodaju sa kase.
 */
export async function productCard(db: Db, u: AuthUser, q: { productId: string; from: string; to: string }) {
  const [p] = (await db.execute(sql`SELECT id, code, name, unit, track_stock AS "trackStock", price::text AS price,
    (SELECT rate FROM tax_rates WHERE id = products.tax_rate_id)::text AS "taxRate" FROM products
    WHERE id = ${q.productId} AND organization_id = ${u.organizationId}`)).rows as any[];
  if (!p) throw NotFound('Proizvod');
  const tz = sql`(SELECT timezone FROM locations WHERE id = ${u.locationId})`;
  const fromTs = sql`((${q.from}::date)::timestamp AT TIME ZONE ${tz})`;
  const toTs = sql`(((${q.to}::date) + 1)::timestamp AT TIME ZONE ${tz})`;
  if (p.trackStock) {
    const wh = sql`(SELECT w.id FROM warehouses w WHERE w.location_id = ${u.locationId})`;
    const open = (await db.execute(sql`SELECT coalesce(sum(b), 0)::text AS q FROM (
        SELECT DISTINCT ON (m.warehouse_id) m.balance_after AS b FROM stock_movements m
        WHERE m.product_id = ${q.productId} AND m.warehouse_id IN ${wh} AND m.created_at < ${fromTs}
        ORDER BY m.warehouse_id, m.seq DESC) x`)).rows[0] as { q: string };
    const r = await db.execute(sql`
      SELECT m.created_at AS at, m.quantity::text AS quantity, m.source, d.kind AS "docKind", d.number AS "docNumber",
        d.external_number AS "externalNumber", pa.name AS partner, o.number AS "orderNumber", t.name AS "tableName",
        coalesce(cu.full_name, wu.full_name) AS "user", m.recipe_id IS NOT NULL AS "byRecipe", rf.number AS "refundNumber",
        m.unit_cost::text AS "unitCost", oi.unit_price::text AS "salePrice", oi.tax_rate::text AS "saleTax"
      FROM stock_movements m
      LEFT JOIN order_items oi ON oi.id = m.order_item_id AND oi.product_id = m.product_id
      LEFT JOIN stock_documents d ON d.id = m.document_id
      LEFT JOIN partners pa ON pa.id = d.partner_id
      LEFT JOIN orders o ON o.id = m.order_id
      LEFT JOIN dining_tables t ON t.id = o.table_id
      LEFT JOIN users cu ON cu.id = m.created_by_id
      LEFT JOIN users wu ON wu.id = o.waiter_id
      LEFT JOIN refunds rf ON rf.id = m.refund_id
      WHERE m.product_id = ${q.productId} AND m.warehouse_id IN ${wh} AND m.created_at >= ${fromTs} AND m.created_at < ${toTs}
      ORDER BY m.seq LIMIT 5000`);
    let bal = dec(open.q); let tin = dec(0); let tout = dec(0);
    const rows = (r.rows as any[]).map((x) => {
      const qn = dec(x.quantity); bal = bal.add(qn);
      if (qn.gt(0)) tin = tin.add(qn); else tout = tout.add(qn.neg());
      const doc = x.source === 'SALE' ? `KS-${x.orderNumber}` : x.source === 'REFUND' ? `RF-${x.refundNumber}`
        : x.docKind ? `${DOC_PREFIX[x.docKind as keyof typeof DOC_PREFIX]}-${x.docNumber ?? '?'}` : '-';
      return {
        at: x.at, in: qn.gt(0) ? qn.toFixed(3) : null, out: qn.lt(0) ? qn.neg().toFixed(3) : null, balance: bal.toFixed(3),
        user: x.user, document: x.source === 'REVERSAL' ? `ST ${doc}` : doc, partner: x.partner ?? null,
        unitCost: x.unitCost, salePrice: x.salePrice ?? null, taxRate: x.saleTax ?? p.taxRate ?? null,
        description: x.source === 'REFUND' ? `Povraćaj (refundacija), račun #${x.orderNumber}${x.byRecipe ? ' (normativ)' : ''}` : x.source === 'SALE' ? `Kasa${x.tableName ? `, ${x.tableName}` : ''}${x.byRecipe ? ' (normativ)' : ''}`
          : `${DOC_LABEL[x.docKind as keyof typeof DOC_LABEL] ?? 'Dokument'}${x.partner ? `, ${x.partner}` : ''}${x.externalNumber ? `, br. ${x.externalNumber}` : ''}`,
      };
    });
    return { product: p, tracked: true, opening: dec(open.q).toFixed(3), closing: bal.toFixed(3), totals: { in: tin.toFixed(3), out: tout.toFixed(3) }, rows };
  }
  const r = await db.execute(sql`
    SELECT o.closed_at AS at, i.quantity::text AS quantity, o.number AS "orderNumber", t.name AS "tableName", us.full_name AS "user",
      i.unit_price::text AS "salePrice", i.tax_rate::text AS "taxRate"
    FROM order_items i JOIN orders o ON o.id = i.order_id
    JOIN users us ON us.id = o.waiter_id
    LEFT JOIN dining_tables t ON t.id = o.table_id
    WHERE o.location_id = ${u.locationId} AND i.product_id = ${q.productId} AND o.status = 'PAID' AND i.status <> 'VOIDED'
      AND o.closed_at >= ${fromTs} AND o.closed_at < ${toTs}
    ORDER BY o.closed_at LIMIT 5000`);
  const back = (await db.execute(sql`
    SELECT rf.created_at AS at, ri.quantity::text AS quantity, rf.number AS "refundNumber", o.number AS "orderNumber", us.full_name AS "user"
    FROM refund_items ri JOIN refunds rf ON rf.id = ri.refund_id JOIN order_items i ON i.id = ri.order_item_id
    JOIN orders o ON o.id = rf.order_id JOIN users us ON us.id = rf.created_by_id
    WHERE rf.location_id = ${u.locationId} AND i.product_id = ${q.productId} AND rf.created_at >= ${fromTs} AND rf.created_at < ${toTs}`)).rows as any[];
  let tout = dec(0); let tin = dec(0);
  const rows: { at: string; in: string | null; out: string | null; balance: string | null; user: string; document: string; description: string; partner: string | null; unitCost: string | null; salePrice: string | null; taxRate: string | null }[] = (r.rows as any[]).map((x) => {
    tout = tout.add(dec(x.quantity));
    return { at: x.at, in: null, out: dec(x.quantity).toFixed(3), balance: null, user: x.user, document: `KS-${x.orderNumber}`, description: `Kasa${x.tableName ? `, ${x.tableName}` : ''}`, partner: null, unitCost: null, salePrice: x.salePrice, taxRate: x.taxRate };
  });
  for (const x of back) {
    tin = tin.add(dec(x.quantity));
    rows.push({ at: x.at, in: dec(x.quantity).toFixed(3), out: null, balance: null, user: x.user, document: `RF-${x.refundNumber}`, description: `Povraćaj (refundacija), račun #${x.orderNumber}`, partner: null, unitCost: null, salePrice: null, taxRate: p.taxRate ?? null });
  }
  rows.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return { product: p, tracked: false, opening: null, closing: null, totals: { in: tin.toFixed(3), out: tout.toFixed(3) }, rows };
}

@ApiTags('stock') @ApiBearerAuth()
@Controller()
export class StockReportsController {
  constructor(private readonly svc: StockReportsService) {}
  @Get('stock/levels') @RequirePermissions(P.STOCK_READ)
  levels(@CurrentUser() u: AuthUser, @Query() q: LevelsQuery) { return this.svc.levels(u, q); }
  @Get('stock/as-of') @RequirePermissions(P.STOCK_READ)
  asOf(@CurrentUser() u: AuthUser, @Query() q: AsOfQuery) { return this.svc.asOf(u, q); }
  @Get('reports/sold-items') @RequirePermissions(P.REPORT_READ)
  soldItems(@CurrentUser() u: AuthUser, @Query() q: SoldQuery) { return this.svc.soldItems(u, q); }
  @Get('reports/product-sales') @RequirePermissions(P.REPORT_READ)
  productSales(@CurrentUser() u: AuthUser, @Query() q: SalesQuery) { return this.svc.productSales(u, q); }
  @Get('reports/product-card') @RequirePermissions(P.STOCK_READ)
  productCard(@CurrentUser() u: AuthUser, @Query() q: CardQuery) { return productCard(this.svc.db, u, q); }
}

@Module({ controllers: [StockReportsController], providers: [StockReportsService] })
export class StockReportsModule {}
