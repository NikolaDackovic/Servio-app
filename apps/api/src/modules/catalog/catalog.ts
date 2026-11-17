import { ToBool } from '../../common/to-bool';
import {
  Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { and, asc, count, eq, ilike, or, SQL, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { categories, locations, prepStations, printers, productImages, productPriceChanges, products, taxRates } from '../../db/schema';
import type { Response } from 'express';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Invalid, NotFound } from '../../common/errors';
import { money } from '../../common/money';
import { ColumnDef, mapColumns, parseBool, readTable, toCsv, toXlsx } from '../stock/tabular';

const PRICE_RE = /^\d{1,10}(\.\d{1,2})?$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const STOCK_QTY_RE = /^\d{1,10}(\.\d{1,4})?$/;

class CreateCategoryDto {
  @IsString() @Length(1, 80) name: string;
  @IsOptional() @Matches(COLOR_RE) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
  /** Pripremna pozicija (šank, kuhinja…); null = bez rutiranja */
  @IsOptional() @IsUUID() prepStationId?: string | null;
  /** Štampač grupe (Štampanje grupa); null = štampač kategorije. */
  @IsOptional() @IsUUID() printerId?: string | null;
  /** grupa za prodaju (kasa, QR meni); false = sirovine / trošak */
  @IsOptional() @IsBoolean() forSale?: boolean;
}
class UpdateCategoryDto {
  @IsOptional() @IsBoolean() forSale?: boolean;
  @IsOptional() @IsUUID() prepStationId?: string | null;
  /** Štampač grupe (Štampanje grupa); null = štampač kategorije. */
  @IsOptional() @IsUUID() printerId?: string | null;
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @Matches(COLOR_RE) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

class CreateProductDto {
  @IsOptional() @IsBoolean() trackStock?: boolean;
  @IsOptional() @IsUUID() purchaseTaxRateId?: string | null;
  @IsOptional() @Matches(STOCK_QTY_RE) minStock?: string | null;
  @IsOptional() @IsBoolean() isSellable?: boolean;
  /** Izmene koje kasa nudi čim se artikal otkuca (npr. "bez leda"). */
  @IsOptional() @IsArray() @ArrayMaxSize(24) @IsString({ each: true }) @Length(1, 40, { each: true }) noteOptions?: string[];
  @IsUUID() categoryId: string;
  @IsUUID() taxRateId: string;
  /** Prazno = automatski sledeći broj (1, 2, 3…). */
  @IsOptional() @IsString() @Length(0, 32) code?: string;
  @IsOptional() @IsString() @Length(1, 32) barcode?: string;
  @IsString() @Length(1, 120) name: string;
  @IsOptional() @IsString() @Length(1, 12) unit?: string;
  /** Bruto cena kao decimalni string, npr. "180.00" */
  @Matches(PRICE_RE, { message: 'Cena mora biti decimalni broj sa najviše 2 decimale (npr. "180.00")' }) price: string;
  @IsOptional() @Matches(COLOR_RE) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
  /** Pozicija artikla - ima prednost nad pozicijom kategorije; null = koristi kategoriju */
  @IsOptional() @IsUUID() prepStationId?: string | null;
}
class UpdateProductDto {
  @IsOptional() @IsBoolean() trackStock?: boolean;
  @IsOptional() @IsUUID() purchaseTaxRateId?: string | null;
  @IsOptional() @Matches(STOCK_QTY_RE) minStock?: string | null;
  @IsOptional() @IsBoolean() isSellable?: boolean;
  /** Izmene koje kasa nudi čim se artikal otkuca (npr. "bez leda"). */
  @IsOptional() @IsArray() @ArrayMaxSize(24) @IsString({ each: true }) @Length(1, 40, { each: true }) noteOptions?: string[];
  @IsOptional() @IsUUID() prepStationId?: string | null;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() taxRateId?: string;
  @IsOptional() @IsString() @Length(1, 32) barcode?: string;
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(1, 12) unit?: string;
  @IsOptional() @Matches(PRICE_RE) price?: string;
  @IsOptional() @Matches(COLOR_RE) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
class FormatQuery { @IsOptional() @IsIn(['csv', 'xlsx']) format?: 'csv' | 'xlsx'; }
class ImportFileDto { @IsString() @Length(1, 200) fileName: string; @IsString() @Length(1, 8_000_000) contentBase64: string; }
class ProductImageDto {
  @IsString() @MaxLength(420_000) dataUrl: string;
}
class ProductQuery {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() @Length(1, 60) search?: string;
  @IsOptional() @ToBool() @IsBoolean() includeInactive?: boolean;
  /** true = samo artikli za prodaju (kasa); false = samo sirovine */
  @IsOptional() @ToBool() @IsBoolean() sellable?: boolean;
  /** samo artikli sa vođenjem zalihe */
  @IsOptional() @ToBool() @IsBoolean() trackStock?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000) pageSize?: number;
}

@Injectable()
export class CatalogService {
  constructor(@Inject(DB) private readonly db: Db) {}

  taxRates(u: AuthUser) {
    return this.db.select().from(taxRates)
      .where(and(eq(taxRates.organizationId, u.organizationId), eq(taxRates.active, true))).orderBy(asc(taxRates.label));
  }

  listCategories(u: AuthUser) {
    return this.db.select().from(categories)
      .where(eq(categories.organizationId, u.organizationId))
      .orderBy(asc(categories.sortOrder), asc(categories.name));
  }

  /** Pozicija mora pripadati lokalu iste organizacije. */
  private async assertStation(tx: any, u: AuthUser, stationId?: string | null) {
    if (!stationId) return;
    const [s] = await tx.select({ id: prepStations.id }).from(prepStations)
      .innerJoin(locations, eq(locations.id, prepStations.locationId))
      .where(and(eq(prepStations.id, stationId), eq(locations.organizationId, u.organizationId)));
    if (!s) throw Invalid('INVALID_STATION', 'Pripremna pozicija ne postoji');
  }

/** Štampač grupe mora pripadati lokalu iste organizacije. */  private async assertPrinter(tx: any, u: AuthUser, printerId?: string | null) {    if (!printerId) return;    const [p] = await tx.select({ id: printers.id }).from(printers)      .innerJoin(locations, eq(locations.id, printers.locationId))      .where(and(eq(printers.id, printerId), eq(locations.organizationId, u.organizationId)));    if (!p) throw Invalid('INVALID_PRINTER', 'Štampač ne postoji');  }
  async createCategory(u: AuthUser, dto: CreateCategoryDto) {
    return this.db.transaction(async (tx) => {
      await this.assertStation(tx, u, dto.prepStationId);
      await this.assertPrinter(tx, u, dto.printerId);
      const [c] = await tx.insert(categories).values({ organizationId: u.organizationId, ...dto, name: dto.name.trim() }).returning();
      await audit(tx, u, 'category.create', 'category', c.id, { name: c.name });
      return c;
    });
  }

  async updateCategory(u: AuthUser, id: string, dto: UpdateCategoryDto) {
    return this.db.transaction(async (tx) => {
      await this.assertStation(tx, u, dto.prepStationId);
      await this.assertPrinter(tx, u, dto.printerId);
      const [c] = await tx.update(categories).set({ ...dto, updatedAt: new Date() })
        .where(and(eq(categories.id, id), eq(categories.organizationId, u.organizationId))).returning();
      if (!c) throw NotFound('Kategorija');
      await audit(tx, u, 'category.update', 'category', id, dto as any);
      return c;
    });
  }

  private async assertRefs(tx: any, u: AuthUser, categoryId?: string, taxRateId?: string) {
    if (categoryId) {
      const [c] = await tx.select({ id: categories.id }).from(categories)
        .where(and(eq(categories.id, categoryId), eq(categories.organizationId, u.organizationId)));
      if (!c) throw Invalid('INVALID_CATEGORY', 'Kategorija ne postoji');
    }
    if (taxRateId) {
      const [t] = await tx.select({ id: taxRates.id }).from(taxRates)
        .where(and(eq(taxRates.id, taxRateId), eq(taxRates.organizationId, u.organizationId), eq(taxRates.active, true)));
      if (!t) throw Invalid('INVALID_TAX_RATE', 'Poreska stopa ne postoji ili nije aktivna');
    }
  }

  async listProducts(u: AuthUser, q: ProductQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 100;
    const conds: SQL[] = [eq(products.organizationId, u.organizationId)];
    if (!q.includeInactive) conds.push(eq(products.active, true));
    if (q.categoryId) conds.push(eq(products.categoryId, q.categoryId));
    if (q.sellable !== undefined) conds.push(eq(products.isSellable, q.sellable));
    if (q.trackStock) conds.push(eq(products.trackStock, true));
    if (q.search) {
      const term = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`;
      conds.push(or(ilike(products.name, term), ilike(products.code, term), ilike(products.barcode, term))!);
    }
    const where = and(...conds);
    const [{ total }] = await this.db.select({ total: count() }).from(products).where(where);
    const rows = await this.db
      .select({
        id: products.id, code: products.code, barcode: products.barcode, name: products.name, unit: products.unit,
        price: products.price, color: products.color, sortOrder: products.sortOrder, active: products.active,
        categoryId: products.categoryId, taxRateId: products.taxRateId, taxLabel: taxRates.label, taxRate: taxRates.rate,
        prepStationId: products.prepStationId, trackStock: products.trackStock, isSellable: products.isSellable,
        imageAt: productImages.updatedAt, noteOptions: products.noteOptions,
        purchaseTaxRateId: products.purchaseTaxRateId, minStock: products.minStock,
      })
      .from(products).innerJoin(taxRates, eq(taxRates.id, products.taxRateId))
      .leftJoin(productImages, eq(productImages.productId, products.id))
      .where(where).orderBy(asc(products.sortOrder), asc(products.name))
      .limit(pageSize).offset((page - 1) * pageSize);
    return { data: rows, page, pageSize, total };
  }

  async createProduct(u: AuthUser, dto: CreateProductDto) {
    if (dto.noteOptions) dto.noteOptions = cleanOptions(dto.noteOptions);
    return this.db.transaction(async (tx) => {
      await this.assertRefs(tx, u, dto.categoryId, dto.taxRateId);
      if (dto.purchaseTaxRateId) await this.assertRefs(tx, u, undefined, dto.purchaseTaxRateId);
      await this.assertStation(tx, u, dto.prepStationId);
      // Šifra: ako nije uneta, sledeći broj posle najveće brojčane šifre (zaključano, da dva unosa ne dobiju isti broj)
      let code = dto.code?.trim();
      if (!code) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'product-code:' + u.organizationId}))`);
        const r = await tx.execute(sql`SELECT coalesce(max(code::bigint), 0) + 1 AS n FROM products WHERE organization_id = ${u.organizationId} AND code ~ '^[0-9]{1,15}$'`);
        code = String((r.rows[0] as any).n);
      }
      const [p] = await tx.insert(products).values({
        organizationId: u.organizationId, ...dto, code, name: dto.name.trim(), price: money(dto.price),
      }).returning();
      await tx.insert(productPriceChanges).values({ productId: p.id, oldPrice: null, newPrice: p.price, userId: u.userId });
      await audit(tx, u, 'product.create', 'product', p.id, { code: p.code, name: p.name, price: p.price });
      return p;
    });
  }

  async updateProduct(u: AuthUser, id: string, dto: UpdateProductDto) {
    if (dto.noteOptions) dto.noteOptions = cleanOptions(dto.noteOptions);
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(products)
        .where(and(eq(products.id, id), eq(products.organizationId, u.organizationId))).for('update');
      if (!current) throw NotFound('Proizvod');
      await this.assertRefs(tx, u, dto.categoryId, dto.taxRateId);
      if (dto.purchaseTaxRateId) await this.assertRefs(tx, u, undefined, dto.purchaseTaxRateId);
      await this.assertStation(tx, u, dto.prepStationId);
      const patch: Record<string, unknown> = { ...dto, updatedAt: new Date() };
      if (dto.price !== undefined) patch.price = money(dto.price);
      const [p] = await tx.update(products).set(patch).where(eq(products.id, id)).returning();
      if (dto.price !== undefined && money(dto.price) !== current.price) {
        // Promena cene ne utiče na već dodate stavke - one čuvaju snimak cene.
        await tx.insert(productPriceChanges).values({ productId: id, oldPrice: current.price, newPrice: p.price, userId: u.userId });
        await audit(tx, u, 'product.price.change', 'product', id, { from: current.price, to: p.price });
      }
      await audit(tx, u, 'product.update', 'product', id, { ...dto });
      return p;
    });
  }

  /** Slika se šalje kao data URL (pregledač je prethodno umanji); čuva se odvojeno od artikla. */
  async setImage(u: AuthUser, id: string, dataUrl: string) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) throw Invalid('INVALID_IMAGE', 'Slika mora biti PNG, JPEG ili WEBP');
    if (Buffer.byteLength(m[2], 'base64') > 300_000) throw Invalid('IMAGE_TOO_LARGE', 'Slika je veća od 300 KB');
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select({ id: products.id }).from(products)
        .where(and(eq(products.id, id), eq(products.organizationId, u.organizationId)));
      if (!p) throw NotFound('Proizvod');
      const now = new Date();
      await tx.insert(productImages).values({ productId: id, mime: m[1], data: m[2], updatedAt: now })
        .onConflictDoUpdate({ target: productImages.productId, set: { mime: m[1], data: m[2], updatedAt: now } });
      await audit(tx, u, 'product.image.set', 'product', id, { mime: m[1] });
      return { id, imageAt: now };
    });
  }

  async removeImage(u: AuthUser, id: string) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select({ id: products.id }).from(products)
        .where(and(eq(products.id, id), eq(products.organizationId, u.organizationId)));
      if (!p) throw NotFound('Proizvod');
      await tx.delete(productImages).where(eq(productImages.productId, id));
      await audit(tx, u, 'product.image.remove', 'product', id, {});
      return { id, imageAt: null };
    });
  }

  async image(id: string) {
    const [img] = await this.db.select().from(productImages).where(eq(productImages.productId, id));
    if (!img) throw NotFound('Slika');
    return img;
  }

  // ---------- Grupe: Excel / CSV ----------

  private readonly groupCols: ColumnDef[] = [
    { key: 'name', label: 'Grupa', aliases: ['naziv', 'grupa', 'name'], required: true },
    { key: 'category', label: 'Kategorija', aliases: ['kategorija', 'pozicija'], required: false },
    { key: 'color', label: 'Boja', aliases: ['boja', 'color'], required: false },
    { key: 'sortOrder', label: 'Redosled', aliases: ['redosled', 'redni broj'], required: false },
    { key: 'active', label: 'Aktivna', aliases: ['aktivna', 'aktivan'], required: false },
  ];

  async exportGroups(u: AuthUser, format: 'csv' | 'xlsx') {
    const rows = await this.db.select({ name: categories.name, st: prepStations.name, color: categories.color, sortOrder: categories.sortOrder, active: categories.active })
      .from(categories).leftJoin(prepStations, eq(prepStations.id, categories.prepStationId))
      .where(eq(categories.organizationId, u.organizationId)).orderBy(asc(categories.sortOrder), asc(categories.name));
    const headers = this.groupCols.map((c) => c.label);
    const data = rows.map((r) => [r.name, r.st ?? '', r.color ?? '', r.sortOrder, r.active ? 'da' : 'ne']);
    const body = format === 'csv' ? toCsv(headers, data) : await toXlsx('Grupe', headers, data);
    return { body, fileName: `grupe.${format}`, contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }

  /** Uvoz grupa: postojeće (po nazivu) se menjaju, nove se dodaju; sve ili ništa, greške po redovima. */
  async importGroups(u: AuthUser, dto: { fileName: string; contentBase64: string }) {
    const { table } = await readTable(dto.fileName, dto.contentBase64);
    const { idx, missing } = mapColumns(table.headers, this.groupCols);
    if (missing.length) throw Invalid('MISSING_COLUMNS', `Nedostaju kolone: ${missing.join(', ')}`);
    const stations = await this.db.select({ id: prepStations.id, name: prepStations.name }).from(prepStations).where(eq(prepStations.locationId, u.locationId));
    const errors: { row: number; message: string }[] = [];
    let created = 0; let updated = 0;
    try {
      await this.db.transaction(async (tx) => {
        for (const r of table.rows) {
          const c = (k: string) => (idx[k] === undefined ? '' : (r.cells[idx[k]] ?? '').trim());
          try {
            const name = c('name');
            if (!name) throw Invalid('NAME', 'Naziv grupe je obavezan');
            const color = c('color') ? c('color').toUpperCase() : undefined;
            if (color && !COLOR_RE.test(color)) throw Invalid('COLOR', 'Boja u formatu #RRGGBB');
            const stName = c('category');
            const st = stName ? stations.find((s) => s.name.toLowerCase() === stName.toLowerCase()) : undefined;
            if (stName && !st) throw Invalid('CATEGORY', `Kategorija "${stName}" ne postoji`);
            const sortOrder = c('sortOrder') ? Number(c('sortOrder')) : undefined;
            if (sortOrder !== undefined && !Number.isInteger(sortOrder)) throw Invalid('SORT', 'Redosled mora biti ceo broj');
            const active = c('active') ? parseBool(c('active')) : null;
            const patch: Record<string, unknown> = { ...(color ? { color } : {}), ...(st ? { prepStationId: st.id } : {}), ...(sortOrder !== undefined ? { sortOrder } : {}), ...(active === null ? {} : { active }) };
            const [ex] = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.organizationId, u.organizationId), eq(categories.name, name)));
            if (ex) { await tx.update(categories).set({ ...patch, updatedAt: new Date() }).where(eq(categories.id, ex.id)); updated++; }
            else { await tx.insert(categories).values({ organizationId: u.organizationId, name, ...patch }); created++; }
          } catch (e: any) { errors.push({ row: r.rowNumber, message: e.message }); }
        }
        if (errors.length) throw new Error('ROLLBACK');
      });
    } catch (e: any) {
      if (e.message !== 'ROLLBACK') throw e;
      throw Invalid('IMPORT_ERRORS', `Uvoz nije izvršen: ${errors.length} redova sa greškom`, { errors });
    }
    await this.db.transaction((tx) => audit(tx, u, 'category.import', 'organization', u.organizationId, { created, updated }));
    return { created, updated };
  }

  priceHistory(u: AuthUser, id: string) {
    return this.db.select({ oldPrice: productPriceChanges.oldPrice, newPrice: productPriceChanges.newPrice,
      userId: productPriceChanges.userId, changedAt: productPriceChanges.changedAt })
      .from(productPriceChanges).innerJoin(products, eq(products.id, productPriceChanges.productId))
      .where(and(eq(productPriceChanges.productId, id), eq(products.organizationId, u.organizationId)))
      .orderBy(asc(productPriceChanges.changedAt));
  }
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller()
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get('tax-rates') @RequirePermissions(P.CATALOG_READ)
  taxRates(@CurrentUser() u: AuthUser) { return this.svc.taxRates(u); }

  @Get('categories') @RequirePermissions(P.CATALOG_READ)
  categories(@CurrentUser() u: AuthUser) { return this.svc.listCategories(u); }

  @Post('categories') @RequirePermissions(P.CATALOG_WRITE)
  createCategory(@CurrentUser() u: AuthUser, @Body() dto: CreateCategoryDto) { return this.svc.createCategory(u, dto); }

  @Get('categories/export') @RequirePermissions(P.CATALOG_READ)
  async exportGroups(@CurrentUser() u: AuthUser, @Query() q: FormatQuery, @Res() res: Response) {
    const f = await this.svc.exportGroups(u, q.format ?? 'xlsx');
    res.setHeader('Content-Type', f.contentType); res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`); res.send(f.body);
  }
  @Post('categories/import') @HttpCode(200) @RequirePermissions(P.CATALOG_WRITE)
  importGroups(@CurrentUser() u: AuthUser, @Body() dto: ImportFileDto) { return this.svc.importGroups(u, dto); }

  @Patch('categories/:id') @RequirePermissions(P.CATALOG_WRITE)
  updateCategory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.svc.updateCategory(u, id, dto);
  }

  @Get('products') @RequirePermissions(P.CATALOG_READ)
  products(@CurrentUser() u: AuthUser, @Query() q: ProductQuery) { return this.svc.listProducts(u, q); }

  @Post('products') @RequirePermissions(P.CATALOG_WRITE)
  createProduct(@CurrentUser() u: AuthUser, @Body() dto: CreateProductDto) { return this.svc.createProduct(u, dto); }

  @Patch('products/:id') @RequirePermissions(P.CATALOG_WRITE)
  updateProduct(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.svc.updateProduct(u, id, dto);
  }

  @Put('products/:id/image') @RequirePermissions(P.CATALOG_WRITE)
  setImage(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProductImageDto) {
    return this.svc.setImage(u, id, dto.dataUrl);
  }

  @Delete('products/:id/image') @HttpCode(200) @RequirePermissions(P.CATALOG_WRITE)
  removeImage(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeImage(u, id); }

  /**
   * Javno (bez tokena), jer <img> ne šalje Authorization zaglavlje. Slika artikla nije poverljiv podatak,
   * a UUID artikla se ne može pogoditi. Klijent dodaje ?v=<imageAt>, pa se keš sme čuvati dugo.
   */
  @Public() @Get('products/:id/image')
  async image(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const img = await this.svc.image(id);
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(img.data, 'base64'));
  }

  @Get('products/:id/price-history') @RequirePermissions(P.CATALOG_READ)
  priceHistory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.priceHistory(u, id); }
}

@Module({ controllers: [CatalogController], providers: [CatalogService] })
export class CatalogModule {}

/** Opcije izmene: bez praznih i bez ponavljanja (bez obzira na velika/mala slova), redosled kako je unet. */
function cleanOptions(list: string[]) {
  const seen = new Set<string>();
  return list.map((s) => s.trim()).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
}
