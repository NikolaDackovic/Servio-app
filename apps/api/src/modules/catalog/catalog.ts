import {
  Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min,
} from 'class-validator';
import { and, asc, count, eq, ilike, or, SQL } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { categories, productPriceChanges, products, taxRates } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Invalid, NotFound } from '../../common/errors';
import { money } from '../../common/money';

const PRICE_RE = /^\d{1,10}(\.\d{1,2})?$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

class CreateCategoryDto {
  @IsString() @Length(1, 80) name: string;
  @IsOptional() @Matches(COLOR_RE) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
}
class UpdateCategoryDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @Matches(COLOR_RE) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

class CreateProductDto {
  @IsUUID() categoryId: string;
  @IsUUID() taxRateId: string;
  @IsString() @Length(1, 32) code: string;
  @IsOptional() @IsString() @Length(1, 32) barcode?: string;
  @IsString() @Length(1, 120) name: string;
  @IsOptional() @IsString() @Length(1, 12) unit?: string;
  /** Bruto cena kao decimalni string, npr. "180.00" */
  @Matches(PRICE_RE, { message: 'Cena mora biti decimalni broj sa najviše 2 decimale (npr. "180.00")' }) price: string;
  @IsOptional() @Matches(COLOR_RE) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
}
class UpdateProductDto {
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
class ProductQuery {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() @Length(1, 60) search?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() includeInactive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) pageSize?: number;
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

  async createCategory(u: AuthUser, dto: CreateCategoryDto) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.insert(categories).values({ organizationId: u.organizationId, ...dto, name: dto.name.trim() }).returning();
      await audit(tx, u, 'category.create', 'category', c.id, { name: c.name });
      return c;
    });
  }

  async updateCategory(u: AuthUser, id: string, dto: UpdateCategoryDto) {
    return this.db.transaction(async (tx) => {
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
      })
      .from(products).innerJoin(taxRates, eq(taxRates.id, products.taxRateId))
      .where(where).orderBy(asc(products.sortOrder), asc(products.name))
      .limit(pageSize).offset((page - 1) * pageSize);
    return { data: rows, page, pageSize, total };
  }

  async createProduct(u: AuthUser, dto: CreateProductDto) {
    return this.db.transaction(async (tx) => {
      await this.assertRefs(tx, u, dto.categoryId, dto.taxRateId);
      const [p] = await tx.insert(products).values({
        organizationId: u.organizationId, ...dto, name: dto.name.trim(), price: money(dto.price),
      }).returning();
      await tx.insert(productPriceChanges).values({ productId: p.id, oldPrice: null, newPrice: p.price, userId: u.userId });
      await audit(tx, u, 'product.create', 'product', p.id, { code: p.code, name: p.name, price: p.price });
      return p;
    });
  }

  async updateProduct(u: AuthUser, id: string, dto: UpdateProductDto) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(products)
        .where(and(eq(products.id, id), eq(products.organizationId, u.organizationId))).for('update');
      if (!current) throw NotFound('Proizvod');
      await this.assertRefs(tx, u, dto.categoryId, dto.taxRateId);
      const patch: Record<string, unknown> = { ...dto, updatedAt: new Date() };
      if (dto.price !== undefined) patch.price = money(dto.price);
      const [p] = await tx.update(products).set(patch).where(eq(products.id, id)).returning();
      if (dto.price !== undefined && money(dto.price) !== current.price) {
        // Promena cene ne utiče na već dodate stavke — one čuvaju snimak cene.
        await tx.insert(productPriceChanges).values({ productId: id, oldPrice: current.price, newPrice: p.price, userId: u.userId });
        await audit(tx, u, 'product.price.change', 'product', id, { from: current.price, to: p.price });
      }
      await audit(tx, u, 'product.update', 'product', id, { ...dto });
      return p;
    });
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

  @Get('products/:id/price-history') @RequirePermissions(P.CATALOG_READ)
  priceHistory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.priceHistory(u, id); }
}

@Module({ controllers: [CatalogController], providers: [CatalogService] })
export class CatalogModule {}
