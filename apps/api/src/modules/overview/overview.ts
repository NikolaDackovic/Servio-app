import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { locationSettings } from '../settings/settings';
import { verifySecret } from '../../common/security';

/**
 * Početna strana ADMIN-a u jednom pozivu: promet otvorenog dana, upozorenja (zalihe ispod minimuma, fiskalni red,
 * neodštampano, nacrti dokumenata) i kontrolna lista za otvaranje lokala (šta još nije podešeno).
 */
@Injectable()
export class OverviewService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async one<T>(q: ReturnType<typeof sql>): Promise<T> {
    return (await this.db.execute(q)).rows[0] as T;
  }

  async overview(u: AuthUser) {
    const loc = u.locationId, org = u.organizationId;
    const day = await this.one<{ id: string; name: string; date: string } | undefined>(sql`
      SELECT id, name, date::text AS date FROM business_days WHERE location_id = ${loc} AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1`);
    let sales: Record<string, unknown> | null = null;
    if (day) {
      const o = await this.one<any>(sql`
        SELECT count(*) FILTER (WHERE status = 'PAID')::int AS "paidCount",
          coalesce(sum(total) FILTER (WHERE status = 'PAID'), 0)::text AS "paidTotal",
          count(*) FILTER (WHERE status = 'OPEN')::int AS "openCount",
          coalesce(sum(total) FILTER (WHERE status = 'OPEN'), 0)::text AS "openTotal"
        FROM orders WHERE business_day_id = ${day.id}`);
      const byMethod = (await this.db.execute(sql`
        SELECT p.method, sum(p.amount)::text AS amount FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE o.business_day_id = ${day.id} GROUP BY p.method`)).rows as { method: string; amount: string }[];
      const rf = await this.one<{ total: string }>(sql`SELECT coalesce(sum(total), 0)::text AS total FROM refunds WHERE business_day_id = ${day.id}`);
      sales = { ...o, byMethod: Object.fromEntries(byMethod.map((m) => [m.method, m.amount])), refunds: rf.total };
    }
    const low = (await this.db.execute(sql`
      SELECT p.name, p.unit, coalesce(sum(b.quantity), 0)::text AS qty, p.min_stock::text AS min
      FROM products p
      LEFT JOIN stock_balances b ON b.product_id = p.id AND b.warehouse_id IN (SELECT id FROM warehouses WHERE location_id = ${loc})
      WHERE p.organization_id = ${org} AND p.active AND p.min_stock IS NOT NULL
      GROUP BY p.id HAVING coalesce(sum(b.quantity), 0) < p.min_stock
      ORDER BY coalesce(sum(b.quantity), 0) / nullif(p.min_stock, 0) LIMIT 50`)).rows as { name: string; unit: string; qty: string; min: string }[];
    const w = await this.one<any>(sql`
      SELECT
        (SELECT count(*) FROM fiscal_receipts WHERE location_id = ${loc} AND status = 'FAILED')::int AS "fiscalFailed",
        (SELECT count(*) FROM fiscal_receipts WHERE location_id = ${loc} AND status = 'PENDING' AND created_at < now() - interval '5 minutes')::int AS "fiscalStuck",
        (SELECT count(*) FROM print_jobs WHERE location_id = ${loc} AND status = 'FAILED' AND created_at > now() - interval '1 day')::int AS "printFailed",
        (SELECT count(*) FROM stock_documents WHERE location_id = ${loc} AND status = 'DRAFT')::int AS "draftDocs"`);
    // podrazumevana šifra ADMIN naloga (0000) još nije promenjena
    const adm = await this.one<{ h: string | null } | undefined>(sql`SELECT password_hash AS h FROM users WHERE organization_id = ${org} AND username = 'admin' AND active`);
    w.defaultPassword = !!adm?.h && (await verifySecret('0000', adm.h));
    const st = await locationSettings(this.db, loc);
    const c = await this.one<any>(sql`
      SELECT
        (SELECT count(*) FROM categories WHERE organization_id = ${org} AND active)::int AS categories,
        (SELECT count(*) FROM products WHERE organization_id = ${org} AND active AND is_sellable)::int AS products,
        (SELECT count(*) FROM dining_tables WHERE location_id = ${loc})::int AS tables,
        (SELECT count(*) FROM users WHERE organization_id = ${org} AND active AND pin_hash IS NOT NULL)::int AS "pinUsers",
        (SELECT count(*) FROM printers WHERE location_id = ${loc} AND connection <> 'SIMULATED')::int AS printers,
        (SELECT count(*) FROM devices WHERE location_id = ${loc} AND kind = 'POS' AND active AND receipt_printer_id IS NULL)::int AS "posWithoutPrinter",
        (SELECT count(*) FROM partners WHERE organization_id = ${org})::int AS partners,
        (SELECT count(*) FROM stock_documents WHERE location_id = ${loc} AND status = 'POSTED')::int AS "postedDocs"`);
    // kontrolna lista: id = stranica ADMIN-a na kojoj se podešava
    const checklist = [
      { id: 'receiptLook', label: 'Podaci firme na računu (naziv, PIB, adresa)', done: !!(st.companyName && st.pib && st.address) },
      { id: 'groups', label: 'Grupe artikala (Topli napici, Hrana…)', done: c.categories > 0 },
      { id: 'products', label: 'Artikli sa cenama', done: c.products > 0, count: c.products },
      { id: 'tables', label: 'Mapa stolova', done: c.tables > 0, count: c.tables },
      { id: 'users', label: 'Konobari i kasiri sa PIN-om', done: c.pinUsers > 1, count: c.pinUsers },
      { id: 'groupPrinting', label: 'Štampači (šank, kuhinja, račun)', done: c.printers > 0, count: c.printers },
      { id: 'computers', label: 'Štampač računa izabran na svakoj kasi', done: c.posWithoutPrinter === 0 },
      { id: 'partners', label: 'Dobavljači (za ulazne fakture)', done: c.partners > 0, count: c.partners },
      { id: 'documents', label: 'Početno stanje robe (ulazna faktura ili popis)', done: c.postedDocs > 0 },
      { id: 'receiptLook', label: 'Fiskalizacija (LPFR/VPFR) - pravi računi', done: st.fiscalMode !== 'NONE' },
    ];
    return { day: day ?? null, sales, lowStock: low, warnings: w, checklist };
  }
}

@ApiTags('admin') @ApiBearerAuth()
@Controller('admin')
export class OverviewController {
  constructor(private readonly svc: OverviewService) {}

  @Get('overview') @RequirePermissions(P.REPORT_READ)
  overview(@CurrentUser() u: AuthUser) { return this.svc.overview(u); }
}

@Module({ controllers: [OverviewController], providers: [OverviewService] })
export class OverviewModule {}
