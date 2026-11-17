import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested } from 'class-validator';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { diningTables, orders, users } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';

const SHAPES = ['RECT', 'ROUND'] as const;

class CreateTableDto {
  @IsString() @Length(1, 40) name: string;
  @IsOptional() @IsString() @Length(1, 40) area?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) seats?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) posX?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) posY?: number;
  @IsOptional() @IsInt() @Min(40) @Max(600) width?: number;
  @IsOptional() @IsInt() @Min(40) @Max(600) height?: number;
  @IsOptional() @IsIn(SHAPES) shape?: (typeof SHAPES)[number];
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) color?: string | null;
  /** Hotelska soba: račun ostaje otvoren preko zatvaranja dana. */
  @IsOptional() @IsBoolean() isRoom?: boolean;
}
class UpdateTableDto {
  @IsOptional() @IsString() @Length(1, 40) name?: string;
  @IsOptional() @IsString() @Length(1, 40) area?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) seats?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) posX?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) posY?: number;
  @IsOptional() @IsInt() @Min(40) @Max(600) width?: number;
  @IsOptional() @IsInt() @Min(40) @Max(600) height?: number;
  @IsOptional() @IsIn(SHAPES) shape?: (typeof SHAPES)[number];
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) color?: string | null;
  /** Hotelska soba: račun ostaje otvoren preko zatvaranja dana. */
  @IsOptional() @IsBoolean() isRoom?: boolean;
}
class LayoutItemDto {
  @IsUUID() id: string;
  @IsInt() @Min(0) @Max(5000) posX: number;
  @IsInt() @Min(0) @Max(5000) posY: number;
  @IsInt() @Min(40) @Max(600) width: number;
  @IsInt() @Min(40) @Max(600) height: number;
}
class LayoutDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => LayoutItemDto) tables: LayoutItemDto[];
}

@Injectable()
export class TablesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Stolovi sa stanjem izvedenim iz otvorenih porudžbina u bazi (ne iz klijenta). */
  async list(u: AuthUser) {
    const tables = await this.db.select().from(diningTables)
      .where(and(eq(diningTables.locationId, u.locationId), eq(diningTables.active, true)))
      .orderBy(asc(diningTables.area), asc(diningTables.name));
    const open = await this.db
      .select({
        id: orders.id, tableId: orders.tableId, number: orders.number, total: orders.total, paidTotal: orders.paidTotal,
        openedAt: orders.openedAt, waiterId: orders.waiterId, waiterName: users.fullName, guests: orders.guests,
        tabName: orders.tabName, qrGuest: sql<boolean>`${users.username} = 'qr-gost'`,
      })
      .from(orders).innerJoin(users, eq(users.id, orders.waiterId))
      .where(and(eq(orders.locationId, u.locationId), eq(orders.status, 'OPEN'), sql`${orders.tableId} IS NOT NULL`))
      .orderBy(asc(orders.openedAt));
    return tables.map((t) => {
      const mine = open.filter((o) => o.tableId === t.id);
      return {
        ...t,
        status: mine.length === 0 ? 'FREE' : mine.some((o) => o.paidTotal !== '0.00') ? 'PARTIALLY_PAID' : 'OCCUPIED',
        openOrders: mine,
      };
    });
  }

  /** Naziv stola je jedinstven po lokalu, i među neaktivnim (obrisan sto se vraća pod istim imenom). */
  private async assertNameFree(tx: any, u: AuthUser, name: string, exceptId?: string) {
    const [t] = await tx.select({ id: diningTables.id, active: diningTables.active }).from(diningTables)
      .where(and(eq(diningTables.locationId, u.locationId), eq(diningTables.name, name)));
    if (t && t.id !== exceptId) {
      throw Conflict('TABLE_NAME_TAKEN', t.active ? `Sto "${name}" već postoji` : `Sto "${name}" postoji među obrisanim stolovima`, { tableId: t.id, active: t.active });
    }
  }

  async create(u: AuthUser, dto: CreateTableDto) {
    return this.db.transaction(async (tx) => {
      const name = dto.name.trim();
      // Obrisan sto istog imena se vraća (čuva istoriju računa), umesto greške o duplikatu.
      const [old] = await tx.select().from(diningTables)
        .where(and(eq(diningTables.locationId, u.locationId), eq(diningTables.name, name), eq(diningTables.active, false)));
      if (old) {
        const [t] = await tx.update(diningTables).set({ ...dto, name, active: true }).where(eq(diningTables.id, old.id)).returning();
        await audit(tx, u, 'table.restore', 'table', t.id, { name });
        return t;
      }
      await this.assertNameFree(tx, u, name);
      const [t] = await tx.insert(diningTables).values({ locationId: u.locationId, ...dto, name, area: dto.area?.trim() || 'Sala' }).returning();
      await audit(tx, u, 'table.create', 'table', t.id, { name: t.name, area: t.area });
      return t;
    });
  }

  async update(u: AuthUser, id: string, dto: UpdateTableDto) {
    return this.db.transaction(async (tx) => {
      const patch: Record<string, unknown> = { ...dto };
      if (dto.name !== undefined) { patch.name = dto.name.trim(); await this.assertNameFree(tx, u, patch.name as string, id); }
      if (dto.area !== undefined) patch.area = dto.area.trim();
      const [t] = await tx.update(diningTables).set(patch)
        .where(and(eq(diningTables.id, id), eq(diningTables.locationId, u.locationId), eq(diningTables.active, true))).returning();
      if (!t) throw NotFound('Sto');
      await audit(tx, u, 'table.update', 'table', id, dto as any);
      return t;
    });
  }

  /** Brisanje je deaktivacija (računi zadržavaju vezu sa stolom); nije dozvoljeno dok je na stolu otvoren račun. */
  async remove(u: AuthUser, id: string) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(diningTables)
        .where(and(eq(diningTables.id, id), eq(diningTables.locationId, u.locationId), eq(diningTables.active, true))).for('update');
      if (!t) throw NotFound('Sto');
      const [open] = await tx.select({ id: orders.id }).from(orders)
        .where(and(eq(orders.tableId, id), eq(orders.status, 'OPEN'))).limit(1);
      if (open) throw Conflict('TABLE_HAS_OPEN_ORDERS', `Na stolu "${t.name}" postoji otvoren račun`);
      await tx.update(diningTables).set({ active: false }).where(eq(diningTables.id, id));
      await audit(tx, u, 'table.delete', 'table', id, { name: t.name });
      return { id, deleted: true };
    });
  }

  /** Raspored iz editora mape: pozicije i veličine više stolova u jednoj transakciji. */
  async saveLayout(u: AuthUser, dto: LayoutDto) {
    if (dto.tables.length === 0) return { updated: 0 };
    return this.db.transaction(async (tx) => {
      const ids = dto.tables.map((t) => t.id);
      if (new Set(ids).size !== ids.length) throw Invalid('DUPLICATE_TABLE', 'Sto se ponavlja u rasporedu');
      const own = await tx.select({ id: diningTables.id }).from(diningTables)
        .where(and(inArray(diningTables.id, ids), eq(diningTables.locationId, u.locationId), eq(diningTables.active, true)));
      if (own.length !== ids.length) throw NotFound('Sto');
      for (const t of dto.tables) {
        await tx.update(diningTables).set({ posX: t.posX, posY: t.posY, width: t.width, height: t.height }).where(eq(diningTables.id, t.id));
      }
      await audit(tx, u, 'table.layout', 'location', u.locationId, { count: ids.length });
      return { updated: ids.length };
    });
  }
}

@ApiTags('tables') @ApiBearerAuth()
@Controller('tables')
export class TablesController {
  constructor(private readonly svc: TablesService) {}
  @Get() @RequirePermissions(P.TABLE_READ)
  list(@CurrentUser() u: AuthUser) { return this.svc.list(u); }
  @Post() @RequirePermissions(P.TABLE_WRITE)
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateTableDto) { return this.svc.create(u, dto); }
  @Put('layout') @RequirePermissions(P.TABLE_WRITE)
  layout(@CurrentUser() u: AuthUser, @Body() dto: LayoutDto) { return this.svc.saveLayout(u, dto); }
  @Patch(':id') @RequirePermissions(P.TABLE_WRITE)
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTableDto) { return this.svc.update(u, id, dto); }
  @Delete(':id') @HttpCode(200) @RequirePermissions(P.TABLE_WRITE)
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.remove(u, id); }
}

@Module({ controllers: [TablesController], providers: [TablesService] })
export class TablesModule {}
