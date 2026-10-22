import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db, Tx } from '../../db/db.module';
import { products, recipeLines, recipes, users } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { dec } from '../../common/money';
import { q4 } from './engine';
import { normNum, QTY_RE } from './stock';

class RecipeLineDto {
  @IsUUID() componentId: string;
  @Matches(QTY_RE, { message: 'Količina: broj sa najviše 4 decimale' }) quantity: string;
}
class CreateRecipeDto {
  @IsUUID() productId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RecipeLineDto) lines: RecipeLineDto[];
  @IsOptional() @IsString() @Length(0, 300) note?: string;
}
class UpdateRecipeDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RecipeLineDto) lines: RecipeLineDto[];
  @IsOptional() @IsString() @Length(0, 300) note?: string;
}
class RecipeQuery { @IsOptional() @IsUUID() productId?: string; }

/**
 * Normativi sa verzijama. Verzija je NACRT dok se ne aktivira; aktivna verzija se više ne menja
 * (izmena = nova verzija). Aktiviranjem nove verzije prethodna postaje RETIRED. Utrošak pri prodaji
 * beleži koja verzija je korišćena (stock_movements.recipe_id), pa se istorija ne menja.
 */
@Injectable()
export class RecipesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async validate(tx: Tx, u: AuthUser, productId: string, lines: RecipeLineDto[]) {
    const ids = lines.map((l) => l.componentId);
    if (new Set(ids).size !== ids.length) throw Invalid('DUPLICATE_COMPONENT', 'Ista komponenta je navedena više puta');
    if (ids.includes(productId)) throw Invalid('SELF_COMPONENT', 'Artikal ne može biti sopstvena komponenta');
    const [p] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, productId), eq(products.organizationId, u.organizationId)));
    if (!p) throw Invalid('INVALID_PRODUCT', 'Artikal ne postoji');
    const comps = await tx.select({ id: products.id, name: products.name, trackStock: products.trackStock })
      .from(products).where(and(inArray(products.id, ids), eq(products.organizationId, u.organizationId)));
    const errors: string[] = [];
    lines.forEach((l, i) => {
      const c = comps.find((x) => x.id === l.componentId);
      if (!c) errors.push(`Red ${i + 1}: komponenta ne postoji`);
      else if (!c.trackStock) errors.push(`Red ${i + 1}: „${c.name}“ nema uključeno vođenje zalihe — ne može da se troši`);
      if (dec(normNum(l.quantity)).lte(0)) errors.push(`Red ${i + 1}: količina mora biti veća od 0`);
    });
    if (errors.length) throw Invalid('INVALID_RECIPE', errors.join('; '), { errors });
  }

  async list(u: AuthUser, q: RecipeQuery, db: Db | Tx = this.db) {
    const conds = [eq(products.organizationId, u.organizationId)];
    if (q.productId) conds.push(eq(recipes.productId, q.productId));
    const rows = await db.select({ r: recipes, productName: products.name, productCode: products.code, createdBy: users.fullName })
      .from(recipes).innerJoin(products, eq(products.id, recipes.productId)).innerJoin(users, eq(users.id, recipes.createdById))
      .where(and(...conds)).orderBy(asc(products.name), desc(recipes.version));
    const ids = rows.map((r) => r.r.id);
    const lines = ids.length ? await db.select({ l: recipeLines, name: products.name, code: products.code, unit: products.unit })
      .from(recipeLines).innerJoin(products, eq(products.id, recipeLines.componentId)).where(inArray(recipeLines.recipeId, ids)) : [];
    return rows.map((r) => ({
      ...r.r, productName: r.productName, productCode: r.productCode, createdBy: r.createdBy,
      lines: lines.filter((l) => l.l.recipeId === r.r.id).map((l) => ({ ...l.l, componentName: l.name, componentCode: l.code, unit: l.unit })),
    }));
  }

  async create(u: AuthUser, dto: CreateRecipeDto) {
    return this.db.transaction(async (tx) => {
      await this.validate(tx, u, dto.productId, dto.lines);
      // serijalizacija po artiklu (brojevi verzija bez sudara)
      await tx.execute(sql`SELECT id FROM products WHERE id = ${dto.productId} FOR UPDATE`);
      const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${recipes.version}), 0)::int` }).from(recipes).where(eq(recipes.productId, dto.productId));
      const [r] = await tx.insert(recipes).values({ productId: dto.productId, version: max + 1, note: dto.note ?? null, createdById: u.userId }).returning();
      await tx.insert(recipeLines).values(dto.lines.map((l) => ({ recipeId: r.id, componentId: l.componentId, quantity: q4(dec(normNum(l.quantity))) })));
      await audit(tx, u, 'recipe.create', 'product', dto.productId, { recipeId: r.id, version: r.version });
      return (await this.list(u, { productId: dto.productId }, tx)).find((x) => x.id === r.id);
    });
  }

  async update(u: AuthUser, id: string, dto: UpdateRecipeDto) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(recipes).where(eq(recipes.id, id)).for('update');
      if (!r) throw NotFound('Normativ');
      if (r.status !== 'DRAFT') throw Conflict('RECIPE_NOT_DRAFT', 'Aktivan ili povučen normativ se ne menja — napravite novu verziju');
      await this.validate(tx, u, r.productId, dto.lines);
      await tx.delete(recipeLines).where(eq(recipeLines.recipeId, id));
      await tx.insert(recipeLines).values(dto.lines.map((l) => ({ recipeId: id, componentId: l.componentId, quantity: q4(dec(normNum(l.quantity))) })));
      if (dto.note !== undefined) await tx.update(recipes).set({ note: dto.note }).where(eq(recipes.id, id));
      await audit(tx, u, 'recipe.update', 'product', r.productId, { recipeId: id });
      return (await this.list(u, { productId: r.productId }, tx)).find((x) => x.id === id);
    });
  }

  async activate(u: AuthUser, id: string) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(recipes).where(eq(recipes.id, id)).for('update');
      if (!r) throw NotFound('Normativ');
      const [p] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, r.productId), eq(products.organizationId, u.organizationId)));
      if (!p) throw NotFound('Normativ');
      if (r.status === 'ACTIVE') return (await this.list(u, { productId: r.productId }, tx)).find((x) => x.id === id);
      if (r.status === 'RETIRED') throw Conflict('RECIPE_RETIRED', 'Povučena verzija se ne aktivira ponovo — napravite novu verziju');
      await tx.execute(sql`SELECT id FROM products WHERE id = ${r.productId} FOR UPDATE`);
      await tx.update(recipes).set({ status: 'RETIRED', retiredAt: new Date() }).where(and(eq(recipes.productId, r.productId), eq(recipes.status, 'ACTIVE')));
      await tx.update(recipes).set({ status: 'ACTIVE', activatedAt: new Date() }).where(eq(recipes.id, id));
      await audit(tx, u, 'recipe.activate', 'product', r.productId, { recipeId: id, version: r.version });
      return (await this.list(u, { productId: r.productId }, tx)).find((x) => x.id === id);
    });
  }

  /** Isključivanje normativa (artikal se dalje troši sam, ako ima vođenje zalihe). */
  async retire(u: AuthUser, id: string) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(recipes).where(eq(recipes.id, id)).for('update');
      if (!r) throw NotFound('Normativ');
      if (r.status !== 'ACTIVE') throw Conflict('RECIPE_NOT_ACTIVE', 'Samo aktivan normativ može da se povuče');
      await tx.update(recipes).set({ status: 'RETIRED', retiredAt: new Date() }).where(eq(recipes.id, id));
      await audit(tx, u, 'recipe.retire', 'product', r.productId, { recipeId: id });
      return (await this.list(u, { productId: r.productId }, tx)).find((x) => x.id === id);
    });
  }
}

@ApiTags('recipes') @ApiBearerAuth()
@Controller('recipes')
export class RecipesController {
  constructor(private readonly svc: RecipesService) {}
  @Get() @RequirePermissions(P.STOCK_READ)
  list(@CurrentUser() u: AuthUser, @Query() q: RecipeQuery) { return this.svc.list(u, q); }
  @Post() @RequirePermissions(P.STOCK_WRITE)
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateRecipeDto) { return this.svc.create(u, dto); }
  @Put(':id') @RequirePermissions(P.STOCK_WRITE)
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRecipeDto) { return this.svc.update(u, id, dto); }
  @Post(':id/activate') @HttpCode(200) @RequirePermissions(P.STOCK_WRITE)
  activate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.activate(u, id); }
  @Post(':id/retire') @HttpCode(200) @RequirePermissions(P.STOCK_WRITE)
  retire(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.retire(u, id); }
}

@Module({ controllers: [RecipesController], providers: [RecipesService] })
export class RecipesModule {}
