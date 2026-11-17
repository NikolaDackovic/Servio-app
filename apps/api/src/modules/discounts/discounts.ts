import { ToBool } from '../../common/to-bool';
import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { categories, discounts, products } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Invalid, NotFound } from '../../common/errors';
import { dec } from '../../common/money';
import { BUYER_ID_TYPES, BUYER_OPTIONAL_BASES } from '../../common/buyer';

const PCT_RE = /^\d{1,3}(\.\d{1,2})?$/;
const SCOPES = ['ALL', 'GROUP', 'PRODUCT'] as const;
type Scope = (typeof SCOPES)[number];

class CreateDiscountDto {
  @IsString() @Length(1, 60) name: string;
  @Matches(PCT_RE, { message: 'Procenat: broj sa najviše 2 decimale (npr. "10" ili "12.5")' }) percent: string;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
  /** Ceo račun, izabrane grupe ili izabrani proizvodi. */
  @IsOptional() @IsIn(SCOPES) scope?: Scope;
  @IsOptional() @IsArray() @ArrayMaxSize(2000) @IsUUID('all', { each: true }) targetIds?: string[];
}
class UpdateDiscountDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @Matches(PCT_RE) percent?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(SCOPES) scope?: Scope;
  @IsOptional() @IsArray() @ArrayMaxSize(2000) @IsUUID('all', { each: true }) targetIds?: string[];
}
class ListQuery {
  @IsOptional() @ToBool() @IsBoolean() includeInactive?: boolean;
}

function checkPercent(p: string) {
  const d = dec(p);
  if (d.lte(0) || d.gt(100)) throw Invalid('INVALID_PERCENT', 'Procenat popusta mora biti veći od 0 i najviše 100');
  return d.toFixed(2);
}

@Injectable()
export class DiscountsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Opseg popusta: za grupe/proizvode bar jedan cilj, i svi ciljevi pripadaju organizaciji. */
  private async target(tx: any, u: AuthUser, scope: Scope, ids: string[]) {
    const uniq = [...new Set(ids)];
    if (scope === 'ALL') return [];
    if (!uniq.length) throw Invalid('DISCOUNT_TARGETS', scope === 'GROUP' ? 'Izaberite bar jednu grupu' : 'Izaberite bar jedan proizvod');
    const t = scope === 'GROUP' ? categories : products;
    const own = await tx.select({ id: t.id }).from(t).where(and(inArray(t.id, uniq), eq(t.organizationId, u.organizationId)));
    if (own.length !== uniq.length) throw Invalid('DISCOUNT_TARGETS', scope === 'GROUP' ? 'Neke grupe ne postoje' : 'Neki proizvodi ne postoje');
    return uniq;
  }

  list(u: AuthUser, q: ListQuery) {
    const conds = [eq(discounts.organizationId, u.organizationId)];
    if (!q.includeInactive) conds.push(eq(discounts.active, true));
    return this.db.select().from(discounts).where(and(...conds)).orderBy(asc(discounts.sortOrder), asc(discounts.percent));
  }

  create(u: AuthUser, dto: CreateDiscountDto) {
    return this.db.transaction(async (tx) => {
      const scope = dto.scope ?? 'ALL';
      const [d] = await tx.insert(discounts).values({
        organizationId: u.organizationId, name: dto.name.trim(), percent: checkPercent(dto.percent), sortOrder: dto.sortOrder ?? 0,
        scope, targetIds: await this.target(tx, u, scope, dto.targetIds ?? []),
      }).returning();
      await audit(tx, u, 'discount.create', 'discount', d.id, { name: d.name, percent: d.percent });
      return d;
    });
  }

  update(u: AuthUser, id: string, dto: UpdateDiscountDto) {
    return this.db.transaction(async (tx) => {
      const patch: Record<string, unknown> = { ...dto, updatedAt: new Date() };
      if (dto.percent !== undefined) patch.percent = checkPercent(dto.percent);
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.scope !== undefined || dto.targetIds !== undefined) {
        const [cur] = await tx.select().from(discounts).where(and(eq(discounts.id, id), eq(discounts.organizationId, u.organizationId)));
        if (!cur) throw NotFound('Popust');
        const scope = (dto.scope ?? cur.scope) as Scope;
        patch.scope = scope;
        patch.targetIds = await this.target(tx, u, scope, dto.targetIds ?? (scope === cur.scope ? cur.targetIds : []));
      }
      const [d] = await tx.update(discounts).set(patch)
        .where(and(eq(discounts.id, id), eq(discounts.organizationId, u.organizationId))).returning();
      if (!d) throw NotFound('Popust');
      await audit(tx, u, 'discount.update', 'discount', id, dto as any);
      return d;
    });
  }
}

@ApiTags('discounts') @ApiBearerAuth()
@Controller()
export class DiscountsController {
  constructor(private readonly svc: DiscountsService) {}

  @Get('discounts') @RequirePermissions(P.ORDER_READ)
  list(@CurrentUser() u: AuthUser, @Query() q: ListQuery) { return this.svc.list(u, q); }

  @Post('discounts') @RequirePermissions(P.DISCOUNT_MANAGE)
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateDiscountDto) { return this.svc.create(u, dto); }

  @Patch('discounts/:id') @RequirePermissions(P.DISCOUNT_MANAGE)
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDiscountDto) {
    return this.svc.update(u, id, dto);
  }

  /** Šifarnici za identifikaciju kupca na računu. */
  @Get('fiscal/buyer-codes') @RequirePermissions(P.ORDER_READ)
  buyerCodes() { return { idTypes: BUYER_ID_TYPES, optionalBases: BUYER_OPTIONAL_BASES }; }
}

@Module({ controllers: [DiscountsController], providers: [DiscountsService] })
export class DiscountsModule {}
