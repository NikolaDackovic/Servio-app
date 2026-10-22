import { Body, Controller, Get, Inject, Injectable, Module, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { diningTables, orders, users } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';

class CreateTableDto {
  @IsString() @Length(1, 40) name: string;
  @IsOptional() @IsString() @Length(1, 40) area?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) seats?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) posX?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) posY?: number;
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

  async create(u: AuthUser, dto: CreateTableDto) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.insert(diningTables).values({ locationId: u.locationId, ...dto }).returning();
      await audit(tx, u, 'table.create', 'table', t.id, { name: t.name });
      return t;
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
}

@Module({ controllers: [TablesController], providers: [TablesService] })
export class TablesModule {}
