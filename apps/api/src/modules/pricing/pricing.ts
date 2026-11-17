import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested,
} from 'class-validator';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { categories, devices, happyHours, locations, priceListItems, priceLists, products } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { dec, money } from '../../common/money';

const PRICE_RE = /^\d{1,10}(\.\d{1,2})?$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class PriceListDto {
  @IsString() @Length(1, 60) name: string;
  /** Kopija iz postojećeg cenovnika (inače se kopiraju trenutne cene svih proizvoda). */
  @IsOptional() @IsUUID() copyFromId?: string;
}
class UpdatePriceListDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class PriceItemDto {
  @IsUUID() productId: string;
  @Matches(PRICE_RE, { message: 'Cena: iznos sa najviše 2 decimale' }) price: string;
}
class SetItemsDto {
  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => PriceItemDto) items: PriceItemDto[];
}
class KasaPriceListDto { @IsOptional() @IsUUID() priceListId?: string | null; }
class HappyHourDto {
  @IsString() @Length(1, 60) name: string;
  @Matches(DATE_RE) dateFrom: string;
  @Matches(DATE_RE) dateTo: string;
  @Matches(TIME_RE, { message: 'Vreme u formatu HH:MM' }) timeFrom: string;
  @Matches(TIME_RE, { message: 'Vreme u formatu HH:MM' }) timeTo: string;
  @IsOptional() @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) weekdays?: number[];
  @IsOptional() @IsUUID() categoryId?: string | null;
  @IsOptional() @IsUUID() productId?: string | null;
  @IsIn(['PRICE', 'PERCENT']) kind: 'PRICE' | 'PERCENT';
  @Matches(PRICE_RE) value: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** Trenutni lokalni datum, vreme i dan u nedelji lokala. */
async function localNow(db: DbOrTx, locationId: string) {
  const r = await db.execute(sql`SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS d, to_char(now() AT TIME ZONE timezone, 'HH24:MI') AS t,
    extract(dow FROM now() AT TIME ZONE timezone)::int AS w FROM locations WHERE id = ${locationId}`);
  const row = r.rows[0] as { d: string; t: string; w: number };
  return { date: row.d, time: row.t, weekday: Number(row.w) };
}

function checkHappy(dto: HappyHourDto) {
  if (dto.dateFrom > dto.dateTo) throw Invalid('HAPPY_DATES', 'Datum "od" je posle datuma "do"');
  if (dto.kind === 'PERCENT' && Number(dto.value) > 100) throw Invalid('HAPPY_PERCENT', 'Popust može biti najviše 100%');
  if (dto.timeFrom === dto.timeTo) throw Invalid('HAPPY_TIME', 'Vreme "od" i "do" ne mogu biti isti');
}

const inWindow = (t: string, from: string, to: string) => (from <= to ? t >= from && t < to : t >= from || t < to);

/** Aktivna happy hour pravila u ovom trenutku. */
async function activeHappyHours(db: DbOrTx, organizationId: string, locationId: string) {
  const now = await localNow(db, locationId);
  const rules = await db.select().from(happyHours).where(and(eq(happyHours.organizationId, organizationId), eq(happyHours.active, true)));
  return rules.filter((h) => h.dateFrom <= now.date && now.date <= h.dateTo && inWindow(now.time, h.timeFrom, h.timeTo)
    && (!h.weekdays.length || h.weekdays.includes(now.weekday)));
}

/**
 * Važeća cena artikla na kasi: cenovnik kase (ako je postavljen; artikal van cenovnika nije dostupan),
 * zatim happy hour (pravilo za proizvod ima prednost nad pravilom za grupu).
 */
export async function effectivePrice(db: DbOrTx, u: AuthUser, product: { id: string; price: string; categoryId: string; name: string }) {
  let price = product.price;
  let priceListName: string | null = null;
  if (u.deviceId) {
    const [d] = await db.select({ listId: devices.priceListId, name: priceLists.name, active: priceLists.active }).from(devices)
      .leftJoin(priceLists, eq(priceLists.id, devices.priceListId)).where(eq(devices.id, u.deviceId));
    if (d?.listId && d.active) {
      const [it] = await db.select({ price: priceListItems.price }).from(priceListItems)
        .where(and(eq(priceListItems.priceListId, d.listId), eq(priceListItems.productId, product.id)));
      if (!it) throw Conflict('NOT_IN_PRICE_LIST', `„${product.name}“ nije u cenovniku ${d.name}`);
      price = it.price; priceListName = d.name;
    }
  }
  const rules = await activeHappyHours(db, u.organizationId, u.locationId);
  const rule = rules.find((r) => r.productId === product.id) ?? rules.find((r) => !r.productId && r.categoryId === product.categoryId);
  if (rule) price = rule.kind === 'PRICE' ? money(rule.value) : money(dec(price).mul(dec(100).sub(rule.value)).div(100).toDecimalPlaces(2));
  return { price, priceListName, happyHour: rule?.name ?? null };
}

@Injectable()
export class PricingService {
  constructor(@Inject(DB) private readonly db: Db) {}

  lists(u: AuthUser) {
    return this.db.select({ id: priceLists.id, name: priceLists.name, active: priceLists.active, updatedAt: priceLists.updatedAt,
      items: sql<number>`(select count(*)::int from price_list_items i where i.price_list_id = "price_lists"."id")` })
      .from(priceLists).where(eq(priceLists.organizationId, u.organizationId)).orderBy(asc(priceLists.name));
  }

  private async own(db: DbOrTx, u: AuthUser, id: string) {
    const [l] = await db.select().from(priceLists).where(and(eq(priceLists.id, id), eq(priceLists.organizationId, u.organizationId)));
    if (!l) throw NotFound('Cenovnik');
    return l;
  }

  async create(u: AuthUser, dto: PriceListDto) {
    return this.db.transaction(async (tx) => {
      const name = dto.name.trim();
      const [same] = await tx.select({ id: priceLists.id }).from(priceLists).where(and(eq(priceLists.organizationId, u.organizationId), eq(priceLists.name, name)));
      if (same) throw Conflict('PRICE_LIST_NAME_TAKEN', `Cenovnik "${name}" već postoji`);
      const [l] = await tx.insert(priceLists).values({ organizationId: u.organizationId, name }).returning();
      if (dto.copyFromId) {
        await this.own(tx, u, dto.copyFromId);
        await tx.execute(sql`INSERT INTO price_list_items (price_list_id, product_id, price) SELECT ${l.id}, product_id, price FROM price_list_items WHERE price_list_id = ${dto.copyFromId}`);
      } else {
        await tx.execute(sql`INSERT INTO price_list_items (price_list_id, product_id, price)
          SELECT ${l.id}, id, price FROM products WHERE organization_id = ${u.organizationId} AND active AND is_sellable`);
      }
      await audit(tx, u, 'price_list.create', 'price_list', l.id, { name });
      return l;
    });
  }

  /** Svi prodajni proizvodi sa trenutnom (osnovnom) cenom i cenom u cenovniku; `included` = u cenovniku. */
  async get(u: AuthUser, id: string) {
    const l = await this.own(this.db, u, id);
    const rows = await this.db.select({ productId: products.id, code: products.code, name: products.name, categoryId: products.categoryId,
      groupName: categories.name, basePrice: products.price, price: priceListItems.price })
      .from(products).innerJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(priceListItems, and(eq(priceListItems.productId, products.id), eq(priceListItems.priceListId, id)))
      .where(and(eq(products.organizationId, u.organizationId), eq(products.active, true), eq(products.isSellable, true)))
      .orderBy(asc(categories.sortOrder), asc(categories.name), asc(products.sortOrder), asc(products.name));
    return { ...l, items: rows.map((r) => ({ ...r, included: r.price !== null })) };
  }

  async update(u: AuthUser, id: string, dto: UpdatePriceListDto) {
    return this.db.transaction(async (tx) => {
      await this.own(tx, u, id);
      const [l] = await tx.update(priceLists).set({ ...dto, ...(dto.name ? { name: dto.name.trim() } : {}), updatedAt: new Date() }).where(eq(priceLists.id, id)).returning();
      await audit(tx, u, 'price_list.update', 'price_list', id, dto as any);
      return l;
    });
  }

  /** Zamena stavki cenovnika (štiklirani proizvodi sa novim cenama), u jednoj transakciji. */
  async setItems(u: AuthUser, id: string, dto: SetItemsDto) {
    await this.db.transaction(async (tx) => {
      await this.own(tx, u, id);
      const ids = dto.items.map((i) => i.productId);
      if (new Set(ids).size !== ids.length) throw Invalid('DUPLICATE_PRODUCT', 'Proizvod se ponavlja');
      if (ids.length) {
        const own = await tx.select({ id: products.id }).from(products).where(and(inArray(products.id, ids), eq(products.organizationId, u.organizationId)));
        if (own.length !== ids.length) throw Invalid('INVALID_PRODUCT', 'Neki proizvodi ne postoje');
      }
      await tx.delete(priceListItems).where(eq(priceListItems.priceListId, id));
      if (dto.items.length) await tx.insert(priceListItems).values(dto.items.map((i) => ({ priceListId: id, productId: i.productId, price: money(i.price) })));
      await tx.update(priceLists).set({ updatedAt: new Date() }).where(eq(priceLists.id, id));
      await audit(tx, u, 'price_list.items', 'price_list', id, { count: dto.items.length });
    });
    // čita se posle potvrde transakcije (this.db ne vidi nepotvrđene izmene)
    return this.get(u, id);
  }

  async remove(u: AuthUser, id: string) {
    return this.db.transaction(async (tx) => {
      await this.own(tx, u, id);
      await tx.update(devices).set({ priceListId: null }).where(eq(devices.priceListId, id));
      await tx.delete(priceLists).where(eq(priceLists.id, id));
      await audit(tx, u, 'price_list.delete', 'price_list', id, {});
      return { id, deleted: true };
    });
  }

  /** Kasa: postavljeni cenovnik ovog uređaja i spisak dostupnih (za dugme "Postavi cenovnik"). */
  async kasa(u: AuthUser) {
    const lists = (await this.lists(u)).filter((l) => l.active);
    let current: { id: string; name: string } | null = null;
    if (u.deviceId) {
      const [d] = await this.db.select({ id: priceLists.id, name: priceLists.name, active: priceLists.active }).from(devices)
        .innerJoin(priceLists, eq(priceLists.id, devices.priceListId)).where(eq(devices.id, u.deviceId));
      if (d?.active) current = { id: d.id, name: d.name };
    }
    return { current, lists: lists.map((l) => ({ id: l.id, name: l.name })) };
  }

  async setKasa(u: AuthUser, dto: KasaPriceListDto) {
    if (!u.deviceId) throw Conflict('NO_DEVICE', 'Cenovnik se postavlja na registrovanoj kasi');
    return this.db.transaction(async (tx) => {
      if (dto.priceListId) {
        const l = await this.own(tx, u, dto.priceListId);
        if (!l.active) throw Invalid('PRICE_LIST_INACTIVE', 'Cenovnik nije aktivan');
      }
      await tx.update(devices).set({ priceListId: dto.priceListId ?? null }).where(eq(devices.id, u.deviceId!));
      await audit(tx, u, 'price_list.kasa', 'device', u.deviceId!, { priceListId: dto.priceListId ?? null });
      return this.kasa(u);
    });
  }

  /** Cene za prikaz na kasi u ovom trenutku: cenovnik kase + happy hour; skriveni = van cenovnika. */
  async kasaPrices(u: AuthUser) {
    const all = await this.db.select({ id: products.id, price: products.price, categoryId: products.categoryId })
      .from(products).where(and(eq(products.organizationId, u.organizationId), eq(products.active, true), eq(products.isSellable, true)));
    const k = await this.kasa(u);
    const listPrices = new Map<string, string>();
    if (k.current) {
      const items = await this.db.select().from(priceListItems).where(eq(priceListItems.priceListId, k.current.id));
      for (const i of items) listPrices.set(i.productId, i.price);
    }
    const rules = await activeHappyHours(this.db, u.organizationId, u.locationId);
    const prices: Record<string, string> = {}; const hidden: string[] = []; const happy: string[] = [];
    for (const p of all) {
      let price = p.price;
      if (k.current) { const lp = listPrices.get(p.id); if (lp === undefined) { hidden.push(p.id); continue; } price = lp; }
      const rule = rules.find((r) => r.productId === p.id) ?? rules.find((r) => !r.productId && r.categoryId === p.categoryId);
      if (rule) { price = rule.kind === 'PRICE' ? money(rule.value) : money(dec(price).mul(dec(100).sub(rule.value)).div(100).toDecimalPlaces(2)); happy.push(p.id); }
      prices[p.id] = price;
    }
    return { priceList: k.current, prices, hidden, happy };
  }

  happyHours(u: AuthUser) {
    return this.db.select().from(happyHours).where(eq(happyHours.organizationId, u.organizationId)).orderBy(asc(happyHours.dateFrom));
  }

  private async checkTarget(tx: DbOrTx, u: AuthUser, dto: { categoryId?: string | null; productId?: string | null }) {
    if (!dto.categoryId && !dto.productId) throw Invalid('HAPPY_TARGET', 'Izaberite grupu ili proizvod');
    if (dto.categoryId) {
      const [c] = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.id, dto.categoryId), eq(categories.organizationId, u.organizationId)));
      if (!c) throw Invalid('INVALID_CATEGORY', 'Grupa ne postoji');
    }
    if (dto.productId) {
      const [p] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, dto.productId), eq(products.organizationId, u.organizationId)));
      if (!p) throw Invalid('INVALID_PRODUCT', 'Proizvod ne postoji');
    }
  }

  async createHappy(u: AuthUser, dto: HappyHourDto) {
    checkHappy(dto);
    return this.db.transaction(async (tx) => {
      await this.checkTarget(tx, u, dto);
      const [h] = await tx.insert(happyHours).values({ organizationId: u.organizationId, ...dto, name: dto.name.trim(), weekdays: dto.weekdays ?? [] }).returning();
      await audit(tx, u, 'happy_hour.create', 'happy_hour', h.id, dto as any);
      return h;
    });
  }

  async updateHappy(u: AuthUser, id: string, dto: HappyHourDto) {
    checkHappy(dto);
    return this.db.transaction(async (tx) => {
      await this.checkTarget(tx, u, dto);
      const [h] = await tx.update(happyHours).set({ ...dto, name: dto.name.trim(), weekdays: dto.weekdays ?? [], categoryId: dto.categoryId ?? null, productId: dto.productId ?? null })
        .where(and(eq(happyHours.id, id), eq(happyHours.organizationId, u.organizationId))).returning();
      if (!h) throw NotFound('Happy hour');
      await audit(tx, u, 'happy_hour.update', 'happy_hour', id, dto as any);
      return h;
    });
  }

  async removeHappy(u: AuthUser, id: string) {
    return this.db.transaction(async (tx) => {
      const r = await tx.delete(happyHours).where(and(eq(happyHours.id, id), eq(happyHours.organizationId, u.organizationId))).returning();
      if (!r.length) throw NotFound('Happy hour');
      await audit(tx, u, 'happy_hour.delete', 'happy_hour', id, {});
      return { id, deleted: true };
    });
  }
}

@ApiTags('pricing') @ApiBearerAuth()
@Controller()
export class PricingController {
  constructor(private readonly svc: PricingService) {}

  @Get('price-lists') @RequirePermissions(P.CATALOG_READ)
  lists(@CurrentUser() u: AuthUser) { return this.svc.lists(u); }
  @Post('price-lists') @RequirePermissions(P.DISCOUNT_MANAGE)
  create(@CurrentUser() u: AuthUser, @Body() dto: PriceListDto) { return this.svc.create(u, dto); }
  @Get('price-lists/kasa') @RequirePermissions(P.ORDER_READ)
  kasa(@CurrentUser() u: AuthUser) { return this.svc.kasa(u); }
  @Put('price-lists/kasa') @RequirePermissions(P.SHIFT_MANAGE)
  setKasa(@CurrentUser() u: AuthUser, @Body() dto: KasaPriceListDto) { return this.svc.setKasa(u, dto); }
  @Get('price-lists/kasa/prices') @RequirePermissions(P.ORDER_READ)
  kasaPrices(@CurrentUser() u: AuthUser) { return this.svc.kasaPrices(u); }
  @Get('price-lists/:id') @RequirePermissions(P.CATALOG_READ)
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(u, id); }
  @Patch('price-lists/:id') @RequirePermissions(P.DISCOUNT_MANAGE)
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePriceListDto) { return this.svc.update(u, id, dto); }
  @Put('price-lists/:id/items') @RequirePermissions(P.DISCOUNT_MANAGE)
  setItems(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetItemsDto) { return this.svc.setItems(u, id, dto); }
  @Delete('price-lists/:id') @HttpCode(200) @RequirePermissions(P.DISCOUNT_MANAGE)
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.remove(u, id); }

  @Get('happy-hours') @RequirePermissions(P.CATALOG_READ)
  happy(@CurrentUser() u: AuthUser) { return this.svc.happyHours(u); }
  @Post('happy-hours') @RequirePermissions(P.DISCOUNT_MANAGE)
  createHappy(@CurrentUser() u: AuthUser, @Body() dto: HappyHourDto) { return this.svc.createHappy(u, dto); }
  @Put('happy-hours/:id') @RequirePermissions(P.DISCOUNT_MANAGE)
  updateHappy(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: HappyHourDto) { return this.svc.updateHappy(u, id, dto); }
  @Delete('happy-hours/:id') @HttpCode(200) @RequirePermissions(P.DISCOUNT_MANAGE)
  removeHappy(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeHappy(u, id); }
}

@Module({ controllers: [PricingController], providers: [PricingService] })
export class PricingModule {}
