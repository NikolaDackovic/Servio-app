import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql, SQL } from 'drizzle-orm';
import { DB, Db, Tx } from '../../db/db.module';
import {
  auditLogs, diningTables, documentCounters, orderItems, orders, payments, products, roles, taxRates, users,
} from '../../db/schema';
import { AuthUser } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { dec, lineTotal, money, qty, sum } from '../../common/money';
import { findOpenShift, requireDevice } from '../shifts/shifts';
import { ensureStaffShift, requireOpenDay } from '../day/day.helpers';
import {
  AddItemDto, CancelOrderDto, CreateOrderDto, CreatePaymentDto, ListOrdersQuery, TransferOrdersDto, UpdateItemDto,
  VoidItemDto, VersionDto,
} from './orders.dto';

type OrderRow = typeof orders.$inferSelect;

@Injectable()
export class OrdersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---------- pomoćne funkcije ----------

  private canAccessAll(u: AuthUser) {
    return u.permissions.includes(P.ORDER_READ_ALL);
  }

  /** Zaključava porudžbinu (SELECT ... FOR UPDATE) i proverava pristup i stanje. */
  private async lockOrder(tx: Tx, u: AuthUser, id: string, opts: { expectedVersion?: number; requireOpen?: boolean } = {}) {
    const [o] = await tx.select().from(orders)
      .where(and(eq(orders.id, id), eq(orders.locationId, u.locationId))).for('update');
    if (!o) throw NotFound('Porudžbina');
    if (o.waiterId !== u.userId && !this.canAccessAll(u)) {
      throw Conflict('ORDER_NOT_YOURS', 'Porudžbina pripada drugom konobaru');
    }
    if (opts.requireOpen !== false && o.status !== 'OPEN') {
      throw Conflict('ORDER_NOT_OPEN', `Porudžbina je u statusu ${o.status} i ne može se menjati`);
    }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== o.version) {
      throw Conflict('STALE_ORDER', 'Porudžbinu je u međuvremenu izmenio neko drugi. Osvežite prikaz.', {
        expectedVersion: opts.expectedVersion, currentVersion: o.version,
      });
    }
    return o;
  }

  /** Preračunava ukupan iznos iz stavki u bazi (izvor istine) i povećava verziju. */
  private async recompute(tx: Tx, o: OrderRow) {
    const rows = await tx.select({ lineTotal: orderItems.lineTotal }).from(orderItems)
      .where(and(eq(orderItems.orderId, o.id), ne(orderItems.status, 'VOIDED')));
    const total = sum(rows.map((r) => r.lineTotal));
    if (total.lt(dec(o.paidTotal))) {
      throw Conflict('TOTAL_BELOW_PAID',
        'Izmena bi smanjila račun ispod već naplaćenog iznosa. Povraćaj novca još nije podržan.',
        { newTotal: money(total), paidTotal: o.paidTotal });
    }
    const [updated] = await tx.update(orders)
      .set({ total: money(total), version: o.version + 1, updatedAt: new Date() })
      .where(eq(orders.id, o.id)).returning();
    return updated;
  }

  private async nextNumber(tx: Tx, locationId: string, kind: string): Promise<number> {
    const r = await tx.execute(sql`
      INSERT INTO document_counters (location_id, kind, last_value) VALUES (${locationId}, ${kind}, 1)
      ON CONFLICT (location_id, kind) DO UPDATE SET last_value = document_counters.last_value + 1
      RETURNING last_value`);
    return Number((r.rows[0] as any).last_value);
  }

  // ---------- čitanje ----------

  async get(u: AuthUser, id: string, tx: Db | Tx = this.db) {
    const [o] = await tx
      .select({
        order: orders, waiterName: users.fullName, tableName: diningTables.name,
      })
      .from(orders).innerJoin(users, eq(users.id, orders.waiterId))
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(and(eq(orders.id, id), eq(orders.locationId, u.locationId)));
    if (!o) throw NotFound('Porudžbina');
    if (o.order.waiterId !== u.userId && !this.canAccessAll(u)) throw NotFound('Porudžbina');

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id)).orderBy(asc(orderItems.createdAt));
    const pays = await tx.select().from(payments).where(eq(payments.orderId, id)).orderBy(asc(payments.createdAt));

    const active = items.filter((i) => i.status !== 'VOIDED');
    const taxes = new Map<string, { label: string; rate: string; base: ReturnType<typeof dec>; gross: ReturnType<typeof dec> }>();
    for (const i of active) {
      const k = i.taxLabel;
      const t = taxes.get(k) ?? { label: k, rate: i.taxRate, base: dec(0), gross: dec(0) };
      t.gross = t.gross.add(dec(i.lineTotal));
      taxes.set(k, t);
    }
    const taxSummary = [...taxes.values()].map((t) => {
      const r = dec(t.rate);
      const tax = r.isZero() ? dec(0) : t.gross.mul(r).div(r.add(100)).toDecimalPlaces(2);
      return { label: t.label, rate: t.rate, gross: money(t.gross), tax: money(tax), net: money(t.gross.sub(tax)) };
    });

    return {
      ...o.order,
      waiterName: o.waiterName,
      tableName: o.tableName,
      remaining: money(dec(o.order.total).sub(dec(o.order.paidTotal))),
      items,
      payments: pays,
      taxSummary,
    };
  }

  async list(u: AuthUser, q: ListOrdersQuery) {
    const conds: SQL[] = [eq(orders.locationId, u.locationId)];
    if (q.status) conds.push(eq(orders.status, q.status));
    if (q.tableId) conds.push(eq(orders.tableId, q.tableId));
    if (q.businessDayId) conds.push(eq(orders.businessDayId, q.businessDayId));
    if (q.waiterId) conds.push(eq(orders.waiterId, q.waiterId));
    if (q.mine || !this.canAccessAll(u)) conds.push(eq(orders.waiterId, u.userId));
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    return this.db
      .select({
        id: orders.id, number: orders.number, status: orders.status, total: orders.total, paidTotal: orders.paidTotal,
        tableId: orders.tableId, tableName: diningTables.name, waiterId: orders.waiterId, waiterName: users.fullName,
        openedAt: orders.openedAt, closedAt: orders.closedAt, version: orders.version, businessDayId: orders.businessDayId,
        guests: orders.guests,
      })
      .from(orders).innerJoin(users, eq(users.id, orders.waiterId))
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(and(...conds)).orderBy(desc(orders.openedAt)).limit(pageSize).offset((page - 1) * pageSize);
  }

  // ---------- izmene ----------

  async create(u: AuthUser, dto: CreateOrderDto) {
    return this.db.transaction(async (tx) => {
      if (dto.idempotencyKey) {
        const [dup] = await tx.select({ id: orders.id }).from(orders)
          .where(and(eq(orders.locationId, u.locationId), eq(orders.idempotencyKey, dto.idempotencyKey)));
        if (dup) return { ...(await this.get(u, dup.id, tx)), idempotentReplay: true };
      }
      if (dto.tableId) {
        const [t] = await tx.select({ id: diningTables.id }).from(diningTables)
          .where(and(eq(diningTables.id, dto.tableId), eq(diningTables.locationId, u.locationId), eq(diningTables.active, true)));
        if (!t) throw Invalid('INVALID_TABLE', 'Sto ne postoji u ovom lokalu');
      }
      const day = await requireOpenDay(tx, u);
      await ensureStaffShift(tx, u, day.id);
      const number = await this.nextNumber(tx, u.locationId, 'ORDER');
      const [o] = await tx.insert(orders).values({
        locationId: u.locationId, deviceId: u.deviceId, tableId: dto.tableId ?? null, number, businessDayId: day.id,
        guests: dto.guests ?? null, note: dto.note ?? null, openedById: u.userId, waiterId: u.userId,
        idempotencyKey: dto.idempotencyKey ?? null,
      }).returning();
      await audit(tx, u, 'order.open', 'order', o.id, { number, tableId: o.tableId });
      return this.get(u, o.id, tx);
    });
  }

  async addItem(u: AuthUser, orderId: string, dto: AddItemDto) {
    return this.db.transaction(async (tx) => {
      const o = await this.lockOrder(tx, u, orderId, { expectedVersion: dto.expectedVersion });
      const [p] = await tx
        .select({ product: products, taxLabel: taxRates.label, taxRate: taxRates.rate })
        .from(products).innerJoin(taxRates, eq(taxRates.id, products.taxRateId))
        .where(and(eq(products.id, dto.productId), eq(products.organizationId, u.organizationId)));
      if (!p) throw Invalid('INVALID_PRODUCT', 'Proizvod ne postoji');
      if (!p.product.active) throw Invalid('PRODUCT_INACTIVE', 'Proizvod nije aktivan');
      const q = qty(dto.quantity ?? '1');
      const [item] = await tx.insert(orderItems).values({
        orderId: o.id, productId: p.product.id, name: p.product.name, unitPrice: p.product.price,
        quantity: q, taxLabel: p.taxLabel, taxRate: p.taxRate, lineTotal: money(lineTotal(p.product.price, q)),
        note: dto.note ?? null, addedById: u.userId,
      }).returning();
      await this.recompute(tx, o);
      await audit(tx, u, 'order.item.add', 'order', o.id, { itemId: item.id, product: item.name, quantity: q });
      return this.get(u, o.id, tx);
    });
  }

  async updateItem(u: AuthUser, orderId: string, itemId: string, dto: UpdateItemDto) {
    return this.db.transaction(async (tx) => {
      const o = await this.lockOrder(tx, u, orderId, { expectedVersion: dto.expectedVersion });
      const [item] = await tx.select().from(orderItems).where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, o.id)));
      if (!item) throw NotFound('Stavka');
      if (item.status !== 'NEW') {
        throw Conflict('ITEM_ALREADY_SENT', 'Stavka je već poslata u pripremu — koristite storniranje');
      }
      const patch: Partial<typeof orderItems.$inferInsert> = {};
      if (dto.quantity !== undefined) {
        patch.quantity = qty(dto.quantity);
        patch.lineTotal = money(lineTotal(item.unitPrice, patch.quantity));
      }
      if (dto.note !== undefined) patch.note = dto.note || null;
      await tx.update(orderItems).set(patch).where(eq(orderItems.id, itemId));
      await this.recompute(tx, o);
      await audit(tx, u, 'order.item.update', 'order', o.id, { itemId, ...dto });
      return this.get(u, o.id, tx);
    });
  }

  /** Uklanjanje je dozvoljeno samo za NEPOSLATE stavke; poslate se isključivo storniraju. */
  async removeItem(u: AuthUser, orderId: string, itemId: string, dto: VersionDto) {
    return this.db.transaction(async (tx) => {
      const o = await this.lockOrder(tx, u, orderId, { expectedVersion: dto.expectedVersion });
      const [item] = await tx.select().from(orderItems).where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, o.id)));
      if (!item) throw NotFound('Stavka');
      if (item.status !== 'NEW') {
        throw Conflict('ITEM_ALREADY_SENT', 'Stavka je već poslata u pripremu — koristite storniranje');
      }
      await tx.delete(orderItems).where(eq(orderItems.id, itemId));
      await this.recompute(tx, o);
      await audit(tx, u, 'order.item.remove', 'order', o.id, { itemId, product: item.name, quantity: item.quantity });
      return this.get(u, o.id, tx);
    });
  }

  /**
   * Šalje sve NOVE stavke u pripremu kao jednu "turu" (sendBatch).
   * Ponovljeno slanje bez novih stavki ne pravi ništa (idempotentno) — ranije stavke se nikad ne šalju ponovo.
   * Iteracija 2: iz ture se prave zadaci štampe i KDS događaji (rutirani po pripremnim pozicijama).
   */
  async send(u: AuthUser, orderId: string, dto: VersionDto) {
    return this.db.transaction(async (tx) => {
      const o = await this.lockOrder(tx, u, orderId, { expectedVersion: dto.expectedVersion });
      const pending = await tx.select({ id: orderItems.id }).from(orderItems)
        .where(and(eq(orderItems.orderId, o.id), eq(orderItems.status, 'NEW')));
      if (pending.length === 0) {
        return { batch: null, sentItems: [], order: await this.get(u, o.id, tx) };
      }
      const batch = o.sendCount + 1;
      const sent = await tx.update(orderItems)
        .set({ status: 'SENT', sendBatch: batch, sentAt: new Date() })
        .where(inArray(orderItems.id, pending.map((p) => p.id))).returning();
      await tx.update(orders).set({ sendCount: batch, version: o.version + 1, updatedAt: new Date() }).where(eq(orders.id, o.id));
      await audit(tx, u, 'order.send', 'order', o.id, { batch, itemIds: sent.map((s) => s.id) });
      return { batch, sentItems: sent, order: await this.get(u, o.id, tx) };
    });
  }

  async voidItem(u: AuthUser, orderId: string, itemId: string, dto: VoidItemDto) {
    if (!u.permissions.includes(P.ORDER_VOID)) {
      throw Conflict('FORBIDDEN_VOID', 'Storniranje poslate stavke zahteva pravo order.void');
    }
    return this.db.transaction(async (tx) => {
      const o = await this.lockOrder(tx, u, orderId, { expectedVersion: dto.expectedVersion });
      const [item] = await tx.select().from(orderItems).where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, o.id)));
      if (!item) throw NotFound('Stavka');
      if (item.status === 'VOIDED') throw Conflict('ITEM_ALREADY_VOIDED', 'Stavka je već stornirana');
      if (item.status === 'NEW') throw Conflict('ITEM_NOT_SENT', 'Neposlata stavka se uklanja, ne stornira');
      await tx.update(orderItems).set({
        status: 'VOIDED', voidReason: dto.reason, voidedById: u.userId, voidedAt: new Date(),
      }).where(eq(orderItems.id, itemId));
      await this.recompute(tx, o);
      await audit(tx, u, 'order.item.void', 'order', o.id, {
        itemId, product: item.name, quantity: item.quantity, lineTotal: item.lineTotal, reason: dto.reason,
      });
      return this.get(u, o.id, tx);
    });
  }

  /** Otkazivanje je moguće samo ako nema naplate i nema aktivnih poslatih stavki (njih prvo stornirati). */
  async cancel(u: AuthUser, orderId: string, dto: CancelOrderDto) {
    return this.db.transaction(async (tx) => {
      const o = await this.lockOrder(tx, u, orderId, { expectedVersion: dto.expectedVersion });
      if (!dec(o.paidTotal).isZero()) throw Conflict('ORDER_HAS_PAYMENTS', 'Porudžbina ima naplatu i ne može se otkazati');
      const [{ c }] = await tx.select({ c: sql<number>`count(*)::int` }).from(orderItems)
        .where(and(eq(orderItems.orderId, o.id), eq(orderItems.status, 'SENT')));
      if (c > 0) throw Conflict('ORDER_HAS_SENT_ITEMS', 'Porudžbina ima poslate stavke — prvo ih stornirajte');
      await tx.delete(orderItems).where(and(eq(orderItems.orderId, o.id), eq(orderItems.status, 'NEW')));
      await tx.update(orders).set({
        status: 'CANCELLED', total: '0.00', closedAt: new Date(), closedById: u.userId, version: o.version + 1, updatedAt: new Date(),
      }).where(eq(orders.id, o.id));
      await audit(tx, u, 'order.cancel', 'order', o.id, { reason: dto.reason });
      return this.get(u, o.id, tx);
    });
  }

  /**
   * Naplata (iteracija 1: isključivo TEST režim — bez platnog terminala i bez fiskalizacije).
   *
   * Garancije:
   *  - Red porudžbine je zaključan FOR UPDATE: paralelne naplate se serijalizuju.
   *  - Isti idempotencyKey vraća već evidentiranu naplatu umesto nove (i nakon zatvaranja računa).
   *  - Primenjeni iznos nikad ne prelazi preostali dug (+ CHECK u bazi: paid_total <= total).
   *  - Račun prelazi u PAID tek kada zbir naplata tačno pokrije iznos.
   */
  async pay(u: AuthUser, orderId: string, dto: CreatePaymentDto) {
    requireDevice(u);
    return this.db.transaction(async (tx) => {
      const o = await this.lockOrder(tx, u, orderId, { requireOpen: false });

      const [existing] = await tx.select().from(payments)
        .where(and(eq(payments.orderId, o.id), eq(payments.idempotencyKey, dto.idempotencyKey)));
      if (existing) {
        return { payment: existing, idempotentReplay: true, order: await this.get(u, o.id, tx) };
      }
      if (o.status !== 'OPEN') throw Conflict('ORDER_NOT_OPEN', `Porudžbina je u statusu ${o.status}`);
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== o.version) {
        throw Conflict('STALE_ORDER', 'Porudžbinu je u međuvremenu izmenio neko drugi. Osvežite prikaz.');
      }

      const day = await requireOpenDay(tx, u);
      const shift = await findOpenShift(tx, u);
      if (!shift) throw Conflict('NO_OPEN_SHIFT', 'Naplata nije moguća: na ovoj kasi nije otvorena smena');
      const staffShift = await ensureStaffShift(tx, u, day.id);

      const total = dec(o.total);
      const paid = dec(o.paidTotal);
      const remaining = total.sub(paid);
      if (total.lte(0)) throw Conflict('ORDER_EMPTY', 'Račun nema stavki za naplatu');

      const amount = dto.amount !== undefined ? dec(dto.amount) : remaining;
      if (amount.lte(0)) throw Invalid('INVALID_AMOUNT', 'Iznos naplate mora biti veći od nule');
      if (amount.gt(remaining)) {
        throw Invalid('AMOUNT_EXCEEDS_REMAINING', 'Iznos naplate je veći od preostalog duga', {
          remaining: money(remaining), amount: money(amount),
        });
      }

      let tendered: string | null = null;
      let change = dec(0);
      if (dto.tendered !== undefined) {
        if (dto.method !== 'CASH') throw Invalid('TENDERED_ONLY_CASH', 'Primljeni iznos i kusur važe samo za gotovinu');
        const t = dec(dto.tendered);
        if (t.lt(amount)) throw Invalid('TENDERED_TOO_LOW', 'Primljeni iznos je manji od iznosa naplate');
        tendered = money(t);
        change = t.sub(amount);
      }

      const [payment] = await tx.insert(payments).values({
        orderId: o.id, shiftId: shift.id, businessDayId: day.id, staffShiftId: staffShift.id,
        deviceId: u.deviceId, method: dto.method, mode: 'TEST',
        amount: money(amount), tendered, change: money(change), idempotencyKey: dto.idempotencyKey, createdById: u.userId,
      }).returning();

      const newPaid = paid.add(amount);
      const settled = newPaid.eq(total);
      await tx.update(orders).set({
        paidTotal: money(newPaid),
        status: settled ? 'PAID' : 'OPEN',
        closedAt: settled ? new Date() : null,
        closedById: settled ? u.userId : null,
        businessDayId: o.businessDayId ?? day.id,
        version: o.version + 1,
        updatedAt: new Date(),
      }).where(eq(orders.id, o.id));

      await audit(tx, u, 'payment.create', 'order', o.id, {
        paymentId: payment.id, method: payment.method, amount: payment.amount, mode: 'TEST', settled,
      });
      if (settled) await audit(tx, u, 'order.close', 'order', o.id, { total: o.total });

      return { payment, idempotentReplay: false, order: await this.get(u, o.id, tx) };
    });
  }

  /**
   * Prebacivanje otvorenih računa na drugog zaposlenog (npr. kraj smene konobara).
   * Svoje račune može da prebaci svako sa order.write; tuđe samo sa order.transfer.
   * Sve-ili-ništa: ako i jedan račun ne može da se prebaci, ništa se ne menja.
   */
  async transfer(u: AuthUser, dto: TransferOrdersDto) {
    return this.db.transaction(async (tx) => {
      const [target] = await tx.select({ id: users.id, fullName: users.fullName, active: users.active, permissions: roles.permissions })
        .from(users).innerJoin(roles, eq(roles.id, users.roleId))
        .where(and(eq(users.id, dto.toUserId), eq(users.organizationId, u.organizationId)));
      if (!target || !target.active) throw Invalid('INVALID_TARGET_USER', 'Izabrani zaposleni ne postoji ili nije aktivan');
      if (!target.permissions.includes(P.ORDER_WRITE)) throw Invalid('TARGET_CANNOT_TAKE_ORDERS', 'Izabrani zaposleni ne može da preuzme račune');

      const ids = [...new Set(dto.orderIds)].sort(); // stalni redosled zaključavanja → bez deadlock-a
      const moved: { id: string; number: number; fromUserId: string }[] = [];
      for (const id of ids) {
        const [o] = await tx.select().from(orders)
          .where(and(eq(orders.id, id), eq(orders.locationId, u.locationId))).for('update');
        if (!o) throw NotFound('Porudžbina');
        if (o.status !== 'OPEN') throw Conflict('ORDER_NOT_OPEN', `Račun #${o.number} nije otvoren`);
        if (o.waiterId !== u.userId && !u.permissions.includes(P.ORDER_TRANSFER)) {
          throw Conflict('ORDER_NOT_YOURS', `Račun #${o.number} pripada drugom konobaru — prebacivanje tuđih računa zahteva pravo order.transfer`);
        }
        if (o.waiterId === target.id) continue;
        await tx.update(orders).set({ waiterId: target.id, version: o.version + 1, updatedAt: new Date() }).where(eq(orders.id, o.id));
        await audit(tx, u, 'order.transfer', 'order', o.id, { number: o.number, fromUserId: o.waiterId, toUserId: target.id, toName: target.fullName });
        moved.push({ id: o.id, number: o.number, fromUserId: o.waiterId });
      }
      return { toUserId: target.id, toName: target.fullName, moved };
    });
  }

  /** Istorija računa iz revizijskog traga: ko je, kada i šta uradio. */
  async history(u: AuthUser, id: string) {
    await this.get(u, id); // ista pravila pristupa kao za detalje
    return this.db
      .select({ id: auditLogs.id, action: auditLogs.action, data: auditLogs.data, createdAt: auditLogs.createdAt,
        userId: auditLogs.userId, userName: users.fullName })
      .from(auditLogs).leftJoin(users, eq(users.id, auditLogs.userId))
      .where(and(eq(auditLogs.organizationId, u.organizationId), eq(auditLogs.entity, 'order'), eq(auditLogs.entityId, id)))
      .orderBy(asc(auditLogs.createdAt));
  }
}
