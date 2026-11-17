import { Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';

class AuditQuery {
  @IsOptional() @IsIn(['product', 'category', 'discount', 'price_list', 'user', 'role', 'order', 'business_day', 'stock_document', 'device', 'table', 'location', 'happy_hour'])
  entity?: string;
  @IsOptional() @IsString() @Length(1, 64) entityId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
}

/**
 * Dodatni podaci za tabelu proizvoda u ADMIN-u (kao Octopos / Garson):
 * nabavna cena sa PDV-om i marža, "gde je u normativu", dnevnik promena.
 */
@Injectable()
export class ProductInsightsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Nabavna cena po proizvodu (prosečna ponderisana sa lagera lokala, bez PDV-a i sa ulaznim PDV-om).
   * Artikal sa aktivnim normativom: zbir (količina komponente × nabavna cena komponente).
   */
  async costs(u: AuthUser) {
    const r = await this.db.execute(sql`
      WITH bal AS (
        SELECT b.product_id,
          CASE WHEN sum(greatest(b.quantity, 0)) > 0 THEN sum(greatest(b.quantity, 0) * b.avg_cost) / sum(greatest(b.quantity, 0)) ELSE max(b.avg_cost) END AS cost
        FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
        WHERE w.location_id = ${u.locationId} GROUP BY b.product_id),
      rec AS (
        SELECT r.product_id, sum(l.quantity * coalesce(bal.cost, 0)) AS cost
        FROM recipes r JOIN recipe_lines l ON l.recipe_id = r.id LEFT JOIN bal ON bal.product_id = l.component_id
        WHERE r.status = 'ACTIVE' GROUP BY r.product_id)
      SELECT p.id AS "productId", round(coalesce(rec.cost, bal.cost), 4)::text AS cost,
        round(coalesce(rec.cost, bal.cost) * (1 + coalesce(pt.rate, t.rate) / 100), 2)::text AS "costWithVat"
      FROM products p
      JOIN tax_rates t ON t.id = p.tax_rate_id
      LEFT JOIN tax_rates pt ON pt.id = p.purchase_tax_rate_id
      LEFT JOIN bal ON bal.product_id = p.id
      LEFT JOIN rec ON rec.product_id = p.id
      WHERE p.organization_id = ${u.organizationId} AND coalesce(rec.cost, bal.cost) > 0`);
    return r.rows;
  }

  /** Gde je u normativu: artikli čiji aktivni normativ (ili nacrt) troši ovu sirovinu. */
  /** Poslednja nabavka artikla (proknjižena ulazna faktura / otpremnica): cena bez PDV-a, datum, dobavljač - predlog pri unosu. */
  async lastCost(u: AuthUser, id: string) {
    const r = await this.db.execute(sql`
      SELECT l.unit_cost::text AS "unitCost", d.doc_date::text AS "date", p.name AS "partner"
      FROM stock_document_lines l JOIN stock_documents d ON d.id = l.document_id
      LEFT JOIN partners p ON p.id = d.partner_id
      WHERE l.product_id = ${id} AND d.location_id = ${u.locationId} AND d.status = 'POSTED'
        AND d.kind IN ('RECEIPT', 'RECEIPT_NOTE') AND l.unit_cost IS NOT NULL
      ORDER BY d.posted_at DESC NULLS LAST LIMIT 1`);
    return (r.rows[0] as { unitCost: string; date: string; partner: string | null } | undefined) ?? null;
  }

  async usedIn(u: AuthUser, id: string) {
    const r = await this.db.execute(sql`
      SELECT p.id AS "productId", p.code, p.name, r.status, r.version, l.quantity::text AS quantity, c.unit
      FROM recipe_lines l
      JOIN recipes r ON r.id = l.recipe_id AND r.status IN ('ACTIVE', 'DRAFT')
      JOIN products p ON p.id = r.product_id AND p.organization_id = ${u.organizationId}
      JOIN products c ON c.id = l.component_id
      WHERE l.component_id = ${id}
      ORDER BY r.status, p.name`);
    return r.rows;
  }

  /** Dnevnik promena (revizijski trag): ko je, kada i šta menjao. */
  async auditLog(u: AuthUser, q: AuditQuery) {
    const r = await this.db.execute(sql`
      SELECT a.id, a.created_at AS "at", a.action, a.entity, a.entity_id AS "entityId", a.data, us.full_name AS "user"
      FROM audit_logs a LEFT JOIN users us ON us.id = a.user_id
      WHERE a.organization_id = ${u.organizationId}
        ${q.entity ? sql`AND a.entity = ${q.entity}` : sql``}
        ${q.entityId ? sql`AND a.entity_id = ${q.entityId}` : sql``}
      ORDER BY a.created_at DESC LIMIT ${q.limit ?? 200}`);
    return r.rows;
  }
}

@ApiTags('catalog') @ApiBearerAuth()
@Controller()
export class ProductInsightsController {
  constructor(private readonly svc: ProductInsightsService) {}
  @Get('products/costs') @RequirePermissions(P.STOCK_READ)
  costs(@CurrentUser() u: AuthUser) { return this.svc.costs(u); }
  @Get('products/:id/last-cost') @RequirePermissions(P.STOCK_READ)
  lastCost(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.lastCost(u, id); }
  @Get('products/:id/used-in') @RequirePermissions(P.CATALOG_READ)
  usedIn(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.usedIn(u, id); }
  @Get('audit-logs') @RequirePermissions(P.AUDIT_READ)
  auditLog(@CurrentUser() u: AuthUser, @Query() q: AuditQuery) { return this.svc.auditLog(u, q); }
}

@Module({ controllers: [ProductInsightsController], providers: [ProductInsightsService] })
export class ProductInsightsModule {}
