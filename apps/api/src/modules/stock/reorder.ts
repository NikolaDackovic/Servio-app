import { Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';

class ReorderQuery {
  /** period za prosečnu potrošnju (dana) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(180) days?: number;
  /** za koliko dana treba da bude robe posle nabavke */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) cover?: number;
}

/**
 * Predlog narudžbine: za artikle sa vođenjem zalihe
 *   dnevna potrošnja = prodaja (utrošak) u poslednjih N dana / N
 *   cilj = max(minimalna zaliha, dnevna potrošnja × dana pokrivenosti)
 *   predlog = cilj − trenutno stanje (zaokruženo naviše: komadi na ceo broj, ostalo na 0,1)
 * Grupisano po dobavljaču iz poslednje proknjižene ulazne fakture, sa poslednjom nabavnom cenom.
 */
@Injectable()
export class ReorderService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async suggest(u: AuthUser, q: ReorderQuery) {
    const days = q.days ?? 14, cover = q.cover ?? 7;
    const rows = (await this.db.execute(sql`
      WITH bal AS (
        SELECT b.product_id, sum(b.quantity) AS q FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
        WHERE w.location_id = ${u.locationId} GROUP BY b.product_id),
      used AS (
        SELECT product_id, -sum(quantity) AS q FROM stock_movements
        WHERE location_id = ${u.locationId} AND source = 'SALE' AND created_at >= now() - make_interval(days => ${days})
        GROUP BY product_id),
      last AS (
        SELECT DISTINCT ON (l.product_id) l.product_id, l.unit_cost, d.partner_id, pa.name AS partner
        FROM stock_document_lines l JOIN stock_documents d ON d.id = l.document_id LEFT JOIN partners pa ON pa.id = d.partner_id
        WHERE d.location_id = ${u.locationId} AND d.status = 'POSTED' AND d.kind IN ('RECEIPT', 'RECEIPT_NOTE')
        ORDER BY l.product_id, d.posted_at DESC NULLS LAST)
      SELECT p.id, p.code, p.name, p.unit, p.min_stock::text AS "minStock", coalesce(bal.q, 0)::text AS stock, coalesce(used.q, 0)::text AS used,
        last.unit_cost::text AS "lastCost", last.partner_id AS "partnerId", last.partner
      FROM products p
      LEFT JOIN bal ON bal.product_id = p.id LEFT JOIN used ON used.product_id = p.id LEFT JOIN last ON last.product_id = p.id
      WHERE p.organization_id = ${u.organizationId} AND p.active AND p.track_stock
        AND (p.min_stock IS NOT NULL OR coalesce(used.q, 0) > 0)
      ORDER BY last.partner NULLS LAST, p.name`)).rows as any[];
    const items = rows.map((r) => {
      const stock = Number(r.stock), used = Math.max(0, Number(r.used)), min = r.minStock !== null ? Number(r.minStock) : 0;
      const daily = used / days;
      const target = Math.max(min, daily * cover);
      const step = r.unit === 'kom' ? 1 : 0.1;
      const need = target - stock;
      const suggest = need > 0 ? Math.ceil(need / step - 1e-9) * step : 0;
      return {
        productId: r.id, code: r.code, name: r.name, unit: r.unit, stock: r.stock, minStock: r.minStock,
        dailyUse: daily.toFixed(3), target: target.toFixed(3), suggest: suggest.toFixed(step === 1 ? 0 : 1),
        lastCost: r.lastCost, partnerId: r.partnerId, partner: r.partner,
      };
    }).filter((x) => Number(x.suggest) > 0);
    return { days, cover, items };
  }
}

@ApiTags('stock') @ApiBearerAuth()
@Controller('stock')
export class ReorderController {
  constructor(private readonly svc: ReorderService) {}
  @Get('reorder') @RequirePermissions(P.STOCK_READ)
  reorder(@CurrentUser() u: AuthUser, @Query() q: ReorderQuery) { return this.svc.suggest(u, q); }
}

@Module({ controllers: [ReorderController], providers: [ReorderService] })
export class ReorderModule {}
