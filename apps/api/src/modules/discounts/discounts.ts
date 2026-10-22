import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { and, asc, eq } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { discounts } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Invalid, NotFound } from '../../common/errors';
import { dec } from '../../common/money';
import { BUYER_ID_TYPES, BUYER_OPTIONAL_BASES } from '../../common/buyer';

const PCT_RE = /^\d{1,3}(\.\d{1,2})?$/;

class CreateDiscountDto {
  @IsString() @Length(1, 60) name: string;
  @Matches(PCT_RE, { message: 'Procenat: broj sa najviše 2 decimale (npr. "10" ili "12.5")' }) percent: string;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
}
class UpdateDiscountDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @Matches(PCT_RE) percent?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
class ListQuery {
  @IsOptional() @Type(() => Boolean) @IsBoolean() includeInactive?: boolean;
}

function checkPercent(p: string) {
  const d = dec(p);
  if (d.lte(0) || d.gt(100)) throw Invalid('INVALID_PERCENT', 'Procenat popusta mora biti veći od 0 i najviše 100');
  return d.toFixed(2);
}

@Injectable()
export class DiscountsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(u: AuthUser, q: ListQuery) {
    const conds = [eq(discounts.organizationId, u.organizationId)];
    if (!q.includeInactive) conds.push(eq(discounts.active, true));
    return this.db.select().from(discounts).where(and(...conds)).orderBy(asc(discounts.sortOrder), asc(discounts.percent));
  }

  create(u: AuthUser, dto: CreateDiscountDto) {
    return this.db.transaction(async (tx) => {
      const [d] = await tx.insert(discounts).values({
        organizationId: u.organizationId, name: dto.name.trim(), percent: checkPercent(dto.percent), sortOrder: dto.sortOrder ?? 0,
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
