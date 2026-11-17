import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { categories, diningTables, locations, orderItems, orders, products, roles, users } from '../../db/schema';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { EventBus } from '../../common/events';
import { OrdersModule } from '../orders/orders.module';
import { OrdersService } from '../orders/orders.service';
import { locationSettings } from '../settings/settings';
import { AppConfig, CONFIG } from '../../config';
import { networkInterfaces } from 'node:os';

/** Sistemski korisnik pod kojim se otvaraju QR porudžbine (ne može da se prijavi: nema PIN ni lozinku). */
export const QR_USERNAME = 'qr-gost';
const TOKEN_RE = /^[0-9a-z]{8,24}$/;

class QrItemDto {
  @IsUUID() productId: string;
  @IsInt() @Min(1) @Max(20) quantity: number;
  @IsOptional() @IsString() @Length(1, 120) note?: string;
}
class QrOrderDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => QrItemDto) items: QrItemDto[];
  /** ime gosta / napomena za konobara (opciono) */
  @IsOptional() @IsString() @Length(1, 60) guest?: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,80}$/) idempotencyKey: string;
}

/**
 * QR naručivanje: gost skenira kod na stolu → meni u pregledaču telefona → porudžbina ide u šank/kuhinju (štampa, KDS)
 * i na račun tog stola na kasi. Gost NE može da naplati ni da vidi tuđe račune; naplata je konobarova.
 * - Sto sa otvorenim računom konobara: stavke se dodaju na taj račun.
 * - Prazan sto: otvara se račun "Gost (QR)"; prvi konobar koji otvori sto ga preuzima (claim).
 */
@Injectable()
export class QrService {
  private readonly done = new Map<string, { at: number; result: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(@Inject(DB) private readonly db: Db, private readonly ordersSvc: OrdersService, private readonly events: EventBus) {}

  private async table(token: string) {
    if (!TOKEN_RE.test(token)) throw NotFound('Sto');
    const [t] = await this.db.select({ t: diningTables, org: locations.organizationId, locName: locations.name })
      .from(diningTables).innerJoin(locations, eq(locations.id, diningTables.locationId))
      .where(and(eq(diningTables.qrToken, token), eq(diningTables.active, true)));
    if (!t) throw NotFound('Sto');
    const st = await locationSettings(this.db, t.t.locationId);
    if (!st.qrOrdering) throw Conflict('QR_DISABLED', 'Naručivanje preko QR koda je isključeno - pozovite konobara');
    return { ...t, store: st.storeName || t.locName };
  }

  /** Sistemski korisnik "Gost (QR)" organizacije - pravi se pri prvoj QR porudžbini. */
  private async qrUser(org: string, locationId: string): Promise<AuthUser> {
    let [u] = await this.db.select({ id: users.id }).from(users).where(and(eq(users.organizationId, org), eq(users.username, QR_USERNAME)));
    if (!u) {
      const [role] = await this.db.select({ id: roles.id }).from(roles).where(and(eq(roles.organizationId, org), eq(roles.code, 'WAITER')));
      [u] = await this.db.insert(users).values({ organizationId: org, roleId: role.id, fullName: 'Gost (QR)', firstName: 'Gost', lastName: '(QR)', username: QR_USERNAME })
        .onConflictDoNothing().returning({ id: users.id });
      u ??= (await this.db.select({ id: users.id }).from(users).where(and(eq(users.organizationId, org), eq(users.username, QR_USERNAME))))[0];
    }
    return {
      userId: u.id, fullName: 'Gost (QR)', organizationId: org, locationId, deviceId: null, roleCode: 'WAITER',
      permissions: [P.ORDER_READ, P.ORDER_WRITE, P.ORDER_READ_ALL],
    };
  }

  async menu(token: string) {
    const t = await this.table(token);
    const cats = await this.db.select({ id: categories.id, name: categories.name, color: categories.color }).from(categories)
      .where(and(eq(categories.organizationId, t.org), eq(categories.active, true), eq(categories.forSale, true))).orderBy(asc(categories.sortOrder), asc(categories.name));
    const prods = await this.db.select({ id: products.id, name: products.name, price: products.price, categoryId: products.categoryId, options: products.noteOptions })
      .from(products).where(and(eq(products.organizationId, t.org), eq(products.active, true), eq(products.isSellable, true))).orderBy(asc(products.name));
    const used = new Set(prods.map((p) => p.categoryId));
    return { store: t.store, table: t.t.name, isRoom: t.t.isRoom, categories: cats.filter((c) => used.has(c.id)), products: prods.filter((p) => cats.some((c) => c.id === p.categoryId)) };
  }

  async order(token: string, dto: QrOrderDto) {
    const t = await this.table(token);
    const key = `${token}:${dto.idempotencyKey}`;
    const prev = this.done.get(key);
    if (prev) return prev.result; // dupli klik / ponovljen zahtev sa slabim signalom
    const running = this.inflight.get(key);
    if (running) return running; // isti zahtev još traje (dvostruki dodir, ponovno slanje)
    const p = this.place(t, key, dto).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async place(t: Awaited<ReturnType<QrService['table']>>, key: string, dto: QrOrderDto) {
    const ids = [...new Set(dto.items.map((i) => i.productId))];
    const ok = await this.db.select({ id: products.id }).from(products)
      .where(and(eq(products.organizationId, t.org), eq(products.active, true), eq(products.isSellable, true), inArray(products.id, ids)));
    if (ok.length !== ids.length) throw Invalid('QR_BAD_PRODUCT', 'Neki artikal više nije u ponudi - osvežite meni');
    const qu = await this.qrUser(t.org, t.t.locationId);
    // otvoreni račun na stolu: konobarov ima prednost, pa postojeći QR račun, inače novi
    const open = (await this.db.select({ id: orders.id, waiterId: orders.waiterId }).from(orders)
      .where(and(eq(orders.tableId, t.t.id), eq(orders.status, 'OPEN'))).orderBy(asc(orders.openedAt)));
    let orderId = (open.find((o) => o.waiterId !== qu.userId) ?? open[0])?.id;
    if (!orderId) {
      try { orderId = (await this.ordersSvc.create(qu, { tableId: t.t.id, idempotencyKey: `qr-${dto.idempotencyKey}` } as any)).id; }
      catch (e: any) {
        if (e?.code === 'DAY_NOT_OPEN') throw Conflict('QR_CLOSED', 'Lokal trenutno ne prima porudžbine - pozovite konobara');
        throw e;
      }
    }
    const guest = dto.guest?.trim();
    const before = new Set((await this.db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId!))).map((x) => x.id));
    for (const it of dto.items) {
      const note = [it.note?.trim(), guest ? `gost: ${guest}` : ''].filter(Boolean).join(' · ') || undefined;
      await this.ordersSvc.addItem(qu, orderId!, { productId: it.productId, quantity: String(it.quantity), note } as any);
    }
    const mine = (await this.db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId!))).map((x) => x.id).filter((x) => !before.has(x));
    await this.ordersSvc.send(qu, orderId!, {} as any, mine);
    const count = dto.items.reduce((a, i) => a + i.quantity, 0);
    // kasa: obaveštenje "nova QR porudžbina"
    this.events.publish({ type: 'qr.order', locationId: t.t.locationId, data: { orderId, tableId: t.t.id, table: t.t.name, items: count } });
    const result = { ok: true, table: t.t.name, items: count };
    this.done.set(key, { at: Date.now(), result });
    for (const [k, v] of this.done) if (Date.now() - v.at > 3_600_000) this.done.delete(k);
    return result;
  }
}

/** Konobar preuzima račun koji je otvorio gost preko QR koda (da bi ga naplatio kao svoj). */
@Injectable()
export class QrClaimService {
  constructor(@Inject(DB) private readonly db: Db) {}
  async claim(u: AuthUser, orderId: string) {
    const r = await this.db.execute(sql`
      UPDATE orders o SET waiter_id = ${u.userId}, version = o.version + 1, updated_at = now()
      FROM users q WHERE o.id = ${orderId} AND o.location_id = ${u.locationId} AND o.status = 'OPEN'
        AND q.id = o.waiter_id AND q.username = ${QR_USERNAME}
      RETURNING o.id`);
    if (!r.rows.length) throw Conflict('NOT_QR_ORDER', 'Račun nije QR porudžbina ili je već preuzet');
    return { id: orderId };
  }
}

@ApiTags('qr')
@Controller('public/qr')
@UseGuards(ThrottlerGuard)
export class QrController {
  constructor(private readonly svc: QrService) {}

  @Public() @Get(':token') @Throttle({ default: { limit: 60, ttl: 60_000 } })
  menu(@Param('token') token: string) { return this.svc.menu(token); }

  @Public() @Post(':token/order') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60_000 } })
  order(@Param('token') token: string, @Body() dto: QrOrderDto) { return this.svc.order(token, dto); }
}

@ApiTags('qr') @ApiBearerAuth()
@Controller('orders')
export class QrClaimController {
  constructor(private readonly svc: QrClaimService, private readonly events: EventBus) {}

  @Post(':id/claim-qr') @HttpCode(200) @RequirePermissions(P.ORDER_WRITE)
  async claim(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.svc.claim(u, id);
    this.events.publish({ type: 'order.updated', locationId: u.locationId, data: { orderId: id } });
    return r;
  }
}

/** ADMIN: adrese servera za QR kodove (telefoni gostiju moraju da ih otvore) i novi kod za sto. */
@ApiTags('qr') @ApiBearerAuth()
@Controller('qr-admin')
export class QrAdminController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @Get('addresses') @RequirePermissions(P.TABLE_WRITE)
  addresses() {
    const ips = Object.values(networkInterfaces()).flat()
      .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    const port = Number(process.env.PORT ?? this.cfg.port ?? 3000);
    return { urls: ips.map((ip) => `http://${ip}${port === 80 ? '' : `:${port}`}`) };
  }

  @Post('tables/:id/reset') @HttpCode(200) @RequirePermissions(P.TABLE_WRITE)
  async reset(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.execute(sql`UPDATE dining_tables SET qr_token = substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)
      WHERE id = ${id} AND location_id = ${u.locationId} RETURNING qr_token AS "qrToken"`);
    if (!r.rows.length) throw NotFound('Sto');
    return r.rows[0];
  }
}

@Module({ imports: [OrdersModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])], controllers: [QrController, QrClaimController, QrAdminController], providers: [QrService, QrClaimService] })
export class QrModule {}
