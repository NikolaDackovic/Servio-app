import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DB, Db, Tx } from '../../db/db.module';
import {
  cashMovements, cashShifts, devices, fiscalReceipts, orderItems, orders, payments, printJobs, refundItems, refunds, stockMovements, users,
} from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { EventBus } from '../../common/events';
import { dec, money } from '../../common/money';
import { requireOpenDay } from '../day/day.helpers';
import { findOpenShift, requireDevice } from '../shifts/shifts';
import { applyMovement, lockBalances } from '../stock/engine';
import { FiscalModule, FiscalService, summary as fiscalSummary } from '../fiscal/fiscal';

const QTY_RE = /^\d{1,6}(\.\d{1,3})?$/;
const METHODS = ['CASH', 'CARD', 'TRANSFER'] as const;

class RefundItemDto {
  @IsUUID() itemId: string;
  @Matches(QTY_RE, { message: 'Količina: broj sa najviše 3 decimale' }) quantity: string;
}
class RefundDto {
  /** Stavke i količine za povraćaj; prazno = ceo (preostali) račun. */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => RefundItemDto) items?: RefundItemDto[];
  @IsString() @Length(3, 200) reason: string;
  /** Kako se novac vraća; podrazumevano kao što je plaćeno (gotovina ako je plaćeno na više načina). */
  @IsOptional() @IsIn(METHODS) method?: (typeof METHODS)[number];
  @IsString() @Length(8, 80) idempotencyKey: string;
}
class PrintRefundDto { @IsString() @Length(8, 80) idempotencyKey: string; }

/**
 * Povraćaj novca (refundacija) naplaćenog računa:
 *  - ceo račun ili deo stavki; više delimičnih povraćaja, ali nikad više od prodate količine,
 *  - gotovina: isplata iz blagajne (očekivana gotovina smene se umanjuje),
 *  - roba se vraća na lager po istoj nabavnoj ceni po kojoj je izašla (normativ: sirovine),
 *  - fiskalni zahtev REFUND sa referencom na fiskalni račun prodaje; štampaju se dva primerka (drugi sa potpisom kupca).
 */
@Injectable()
export class RefundsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly fiscal: FiscalService, private readonly events: EventBus) {}

  private async nextNumber(tx: Tx, locationId: string) {
    const r = await tx.execute(sql`
      INSERT INTO document_counters (location_id, kind, last_value) VALUES (${locationId}, 'REFUND', 1)
      ON CONFLICT (location_id, kind) DO UPDATE SET last_value = document_counters.last_value + 1
      RETURNING last_value`);
    return Number((r.rows[0] as any).last_value);
  }

  /** Stavke računa sa prodatom, već vraćenom i preostalom količinom (za ekran povraćaja). */
  async refundable(u: AuthUser, orderId: string, db: Db | Tx = this.db) {
    const [o] = await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.locationId, u.locationId)));
    if (!o) throw NotFound('Račun');
    const items = await db.select().from(orderItems)
      .where(and(eq(orderItems.orderId, orderId), ne(orderItems.status, 'VOIDED'))).orderBy(asc(orderItems.createdAt));
    const done = await db.select({ itemId: refundItems.orderItemId, q: sql<string>`sum(${refundItems.quantity})::text`, a: sql<string>`sum(${refundItems.amount})::text` })
      .from(refundItems).innerJoin(refunds, eq(refunds.id, refundItems.refundId))
      .where(eq(refunds.orderId, orderId)).groupBy(refundItems.orderItemId);
    const by = new Map(done.map((d) => [d.itemId, d]));
    return {
      order: o,
      items: items.map((i) => {
        const r = by.get(i.id);
        const net = dec(i.lineTotal).sub(dec(i.discountAmount));
        const refundedQty = dec(r?.q ?? 0);
        return {
          id: i.id, name: i.name, unitPrice: i.unitPrice, quantity: i.quantity, net: money(net),
          refunded: refundedQty.toFixed(3), refundedAmount: money(dec(r?.a ?? 0)), remaining: dec(i.quantity).sub(refundedQty).toFixed(3),
        };
      }),
    };
  }

  async refund(u: AuthUser, orderId: string, dto: RefundDto) {
    // i iz ADMIN-a (bez kase): novac se vraća iz kase na kojoj je račun izdat ili iz otvorene smene u lokalu
    let fiscalId: string | null = null;
    const ev: { orderId: string; locationId: string }[] = [];
    const result = await this.db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.locationId, u.locationId))).for('update');
      if (!o) throw NotFound('Račun');
      const [replay] = await tx.select().from(refunds).where(and(eq(refunds.orderId, o.id), eq(refunds.idempotencyKey, dto.idempotencyKey)));
      if (replay) return { refundId: replay.id, idempotentReplay: true };
      if (o.status !== 'PAID') throw Conflict('ORDER_NOT_PAID', 'Povraćaj je moguć samo za naplaćen račun (nenaplaćen se stornira)');

      const pays = await tx.select().from(payments).where(eq(payments.orderId, o.id));
      if (pays.length && pays.every((p) => p.method === 'REPRESENTATION')) {
        throw Conflict('REFUND_REPRESENTATION', 'Reprezentacija nije naplata - nema novca za povraćaj');
      }
      const paidMethods = [...new Set(pays.filter((p) => p.method !== 'REPRESENTATION').map((p) => p.method))];
      const method = dto.method ?? (paidMethods.length === 1 ? paidMethods[0] as (typeof METHODS)[number] : 'CASH');

      const day = await requireOpenDay(tx, u);
      // iz ADMIN-a (bez kase): smena i kasa na kojoj je račun izdat (novac se vraća iz te kase)
      let at = u.deviceId ? u : { ...u, deviceId: o.deviceId };
      let shift = at.deviceId ? await findOpenShift(tx, at) : undefined;
      // ADMIN: ako na toj kasi smena nije otvorena - bilo koja otvorena smena u lokalu (novac izlazi iz te kase)
      if (!shift && !u.deviceId) {
        [shift] = await tx.select().from(cashShifts).where(and(eq(cashShifts.locationId, u.locationId), eq(cashShifts.status, 'OPEN'))).orderBy(asc(cashShifts.openedAt)).limit(1);
        if (shift) at = { ...u, deviceId: shift.deviceId };
      }
      if (!shift) throw Conflict('NO_OPEN_SHIFT', u.deviceId ? 'Povraćaj nije moguć: na ovoj kasi nije otvorena smena' : 'Storno je moguć dok je na nekoj kasi otvorena smena (novac se vraća iz te kase)');

      const { items } = await this.refundable(u, o.id, tx);
      const req = dto.items?.length
        ? dto.items.map((x) => ({ itemId: x.itemId, qty: dec(x.quantity) }))
        : items.filter((i) => dec(i.remaining).gt(0)).map((i) => ({ itemId: i.id, qty: dec(i.remaining) }));
      if (!req.length) throw Conflict('NOTHING_TO_REFUND', 'Sve stavke ovog računa su već vraćene');
      if (new Set(req.map((r) => r.itemId)).size !== req.length) throw Invalid('DUPLICATE_ITEM', 'Stavka se ponavlja');

      const lines: { item: (typeof items)[number]; qty: ReturnType<typeof dec>; amount: ReturnType<typeof dec> }[] = [];
      for (const r of req) {
        const it = items.find((i) => i.id === r.itemId);
        if (!it) throw Invalid('INVALID_ITEM', 'Stavka ne pripada ovom računu ili je stornirana');
        if (r.qty.lte(0)) throw Invalid('INVALID_QUANTITY', 'Količina mora biti veća od nule');
        if (r.qty.gt(dec(it.remaining))) {
          throw Invalid('REFUND_EXCEEDS_SOLD', `„${it.name}“: može se vratiti najviše ${Number(it.remaining)}`, { itemId: it.id, remaining: it.remaining });
        }
        // poslednji deo stavke uzima ostatak iznosa (bez greške zaokruživanja)
        const amount = r.qty.eq(dec(it.remaining))
          ? dec(it.net).sub(dec(it.refundedAmount))
          : dec(it.net).mul(r.qty).div(dec(it.quantity)).toDecimalPlaces(2);
        lines.push({ item: it, qty: r.qty, amount });
      }
      const total = lines.reduce((a, l) => a.add(l.amount), dec(0));
      if (total.lte(0)) throw Invalid('REFUND_ZERO', 'Iznos povraćaja je 0');

      const number = await this.nextNumber(tx, u.locationId);
      const [rf] = await tx.insert(refunds).values({
        locationId: u.locationId, orderId: o.id, businessDayId: day.id, shiftId: shift.id, deviceId: at.deviceId,
        number, method, total: money(total), reason: dto.reason.trim(), idempotencyKey: dto.idempotencyKey, createdById: u.userId,
      }).returning();
      await tx.insert(refundItems).values(lines.map((l) => ({ refundId: rf.id, orderItemId: l.item.id, quantity: l.qty.toFixed(3), amount: money(l.amount) })));

      // Novac: gotovina izlazi iz blagajne ove smene.
      if (method === 'CASH') {
        await tx.insert(cashMovements).values({
          shiftId: shift.id, type: 'PAY_OUT', amount: money(total), reason: `Povraćaj #${number} za račun #${o.number}: ${dto.reason.trim()}`, createdById: u.userId,
        });
      }

      // Roba nazad na lager: srazmerno svakom kretanju prodaje te stavke, po istoj nabavnoj ceni.
      const sale = await tx.select().from(stockMovements)
        .where(and(eq(stockMovements.orderId, o.id), eq(stockMovements.source, 'SALE'), inArray(stockMovements.orderItemId, lines.map((l) => l.item.id))));
      await lockBalances(tx, sale);
      for (const m of sale.sort((a, b) => (a.warehouseId + a.productId).localeCompare(b.warehouseId + b.productId))) {
        const l = lines.find((x) => x.item.id === m.orderItemId)!;
        const back = dec(m.quantity).neg().mul(l.qty).div(dec(l.item.quantity));
        if (back.lte(0)) continue;
        await applyMovement(tx, {
          locationId: m.locationId, warehouseId: m.warehouseId, productId: m.productId, quantity: back, unitCost: dec(m.unitCost),
          source: 'REFUND', allowNegative: true, orderId: o.id, orderItemId: m.orderItemId, recipeId: m.recipeId, refundId: rf.id, userId: u.userId,
        });
      }

      fiscalId = await this.fiscal.enqueueRefund(tx, o, rf, lines.map((l) => ({ orderItemId: l.item.id, quantity: l.qty.toFixed(3), amount: money(l.amount) })), { deviceId: at.deviceId ?? o.deviceId, cashier: u.fullName });
      await audit(tx, u, 'order.refund', 'order', o.id, { refundId: rf.id, number, total: rf.total, method, reason: rf.reason, items: lines.length });
      ev.push({ orderId: o.id, locationId: o.locationId });
      return { refundId: rf.id, idempotentReplay: false };
    });
    for (const e of ev) this.events.publish({ type: 'order.updated', locationId: e.locationId, data: { orderId: e.orderId } });
    if (fiscalId) await this.fiscal.processWithTimeout(fiscalId);
    return { ...(await this.get(u, result.refundId)), idempotentReplay: result.idempotentReplay };
  }

  async get(u: AuthUser, id: string) {
    const [r] = await this.db.select({ r: refunds, orderNumber: orders.number, user: users.fullName }).from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId)).innerJoin(users, eq(users.id, refunds.createdById))
      .where(and(eq(refunds.id, id), eq(refunds.locationId, u.locationId)));
    if (!r) throw NotFound('Povraćaj');
    const items = await this.db.select({ id: refundItems.id, orderItemId: refundItems.orderItemId, name: orderItems.name, quantity: refundItems.quantity,
      unitPrice: orderItems.unitPrice, amount: refundItems.amount, taxLabel: orderItems.taxLabel, taxRate: orderItems.taxRate })
      .from(refundItems).innerJoin(orderItems, eq(orderItems.id, refundItems.orderItemId)).where(eq(refundItems.refundId, id));
    const [f] = await this.db.select().from(fiscalReceipts).where(eq(fiscalReceipts.refundId, id));
    return { ...r.r, orderNumber: r.orderNumber, createdBy: r.user, items, fiscal: f ? fiscalSummary(f) : null };
  }

  async forOrder(u: AuthUser, orderId: string) {
    const rows = await this.db.select({ id: refunds.id }).from(refunds)
      .where(and(eq(refunds.orderId, orderId), eq(refunds.locationId, u.locationId))).orderBy(asc(refunds.createdAt));
    const { items } = await this.refundable(u, orderId);
    return { items, refunds: await Promise.all(rows.map((r) => this.get(u, r.id))) };
  }

  /**
   * Štampa povraćaja: dva primerka (Poreska uprava) - prvi za kupca, drugi (КОПИЈА) sa mestom za potpis kupca, ostaje u lokalu.
   * Isti ključ ne štampa ponovo.
   */
  async print(u: AuthUser, id: string, dto: PrintRefundDto) {
    const rf = await this.get(u, id);
    // iz ADMIN-a: štampač kase na kojoj je povraćaj urađen
    const devId = u.deviceId ?? (rf as any).deviceId ?? null;
    if (!devId) throw Conflict('NO_DEVICE', 'Štampa je moguća samo sa registrovane kase');
    const [dev] = await this.db.select({ printerId: devices.receiptPrinterId }).from(devices).where(eq(devices.id, devId));
    if (!dev?.printerId) throw Conflict('NO_RECEIPT_PRINTER', 'Za ovu kasu nije podešen štampač računa (ADMIN → Računari)');
    const [sale] = await this.db.select().from(fiscalReceipts).where(and(eq(fiscalReceipts.orderId, rf.orderId), eq(fiscalReceipts.transactionType, 'SALE')));
    const [info] = (await this.db.execute(sql`
      SELECT org.name AS company, org.tax_id AS pib, l.name AS store, l.address, l.settings
      FROM locations l JOIN organizations org ON org.id = l.organization_id WHERE l.id = ${u.locationId}`)).rows as any[];
    const st = info?.settings ?? {};
    const LABEL: Record<string, string> = { 'Đ': 'Ђ', 'E': 'Е', 'A': 'А', 'G': 'Г', 'Ž': 'Ж' };
    const byLabel = new Map<string, { label: string; rate: string; gross: ReturnType<typeof dec> }>();
    for (const i of rf.items) {
      const g = byLabel.get(i.taxLabel) ?? { label: LABEL[i.taxLabel] ?? i.taxLabel, rate: i.taxRate, gross: dec(0) };
      g.gross = g.gross.add(dec(i.amount)); byLabel.set(i.taxLabel, g);
    }
    const taxes = [...byLabel.values()].map((t) => ({ label: t.label, name: Number(t.rate) >= 20 ? 'О-ПДВ' : Number(t.rate) > 0 ? 'П-ПДВ' : 'Без ПДВ', rate: t.rate,
      tax: money(t.gross.mul(dec(t.rate)).div(dec(100).add(dec(t.rate))).toDecimalPlaces(2)) }));
    const isFiscal = !!rf.fiscal && rf.fiscal.status === 'SIGNED' && !rf.fiscal.isTest;
    const [street, ...rest] = String(info?.address ?? '').split(',').map((s: string) => s.trim());
    const base = {
      title: 'POVRAĆAJ', orderNumber: rf.orderNumber, waiter: rf.createdBy, createdAt: new Date().toISOString(),
      lines: rf.items.map((i) => ({ qty: i.quantity, name: i.name, unitPrice: i.unitPrice, total: i.amount, taxLabel: LABEL[i.taxLabel] ?? i.taxLabel })),
      total: rf.total, payments: [{ method: rf.method, amount: rf.total }],
      header: st.receiptHeader || null, footer: null, logo: st.receiptLogo ?? null,
    };
    const layout = {
      pib: st.pib || info?.pib || '', company: st.companyName || info?.company || '', store: st.storeName || info?.store || '',
      address: st.address || street || '', city: st.city || rest.join(', ') || '', cashier: rf.createdBy, esir: st.esirNumber || '',
      refund: true, refNumber: sale?.invoiceNumber ?? null, refTime: sale?.signedAt?.toISOString() ?? null,
      taxes, taxTotal: money(taxes.reduce((a, t) => a.add(dec(t.tax)), dec(0))),
      pfrTime: rf.fiscal?.signedAt ? new Date(rf.fiscal.signedAt).toISOString() : null, pfrNumber: rf.fiscal?.invoiceNumber ?? null,
      counter: `${rf.number}/${rf.number}${isFiscal ? 'ПР' : 'ОР'}`, qr: rf.fiscal?.verificationUrl ?? null,
    };
    const copies = [
      { key: 'kupac', fiscalLayout: { ...layout, isFiscal, transaction: isFiscal ? 'ПРОМЕТ РЕФУНДАЦИЈА' : 'ОБУКА РЕФУНДАЦИЈА' } },
      { key: 'lokal', fiscalLayout: { ...layout, isFiscal: false, transaction: 'КОПИЈА РЕФУНДАЦИЈА', signature: true } },
    ];
    const jobs = [];
    for (const c of copies) {
      const dedupeKey = `refund:${id}:${dto.idempotencyKey}:${c.key}`;
      const [j] = await this.db.insert(printJobs).values({
        locationId: u.locationId, printerId: dev.printerId, orderId: rf.orderId, kind: 'RECEIPT', dedupeKey, payload: { ...base, fiscalLayout: c.fiscalLayout },
      }).onConflictDoNothing().returning();
      const job = j ?? (await this.db.select().from(printJobs).where(eq(printJobs.dedupeKey, dedupeKey)))[0];
      if (j) this.events.publish({ type: 'print.job.created', locationId: u.locationId, data: { jobId: j.id, printerId: j.printerId } });
      jobs.push(job);
    }
    await this.db.transaction((tx) => audit(tx, u, 'print.refund', 'order', rf.orderId, { refundId: id }));
    return { jobs };
  }
}

@ApiTags('refunds') @ApiBearerAuth()
@Controller()
export class RefundsController {
  constructor(private readonly svc: RefundsService) {}
  @Get('orders/:id/refunds') @RequirePermissions(P.ORDER_READ)
  list(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.forOrder(u, id); }
  @Post('orders/:id/refunds') @RequirePermissions(P.ORDER_REFUND)
  refund(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDto) { return this.svc.refund(u, id, dto); }
  @Get('refunds/:id') @RequirePermissions(P.ORDER_READ)
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(u, id); }
  @Post('refunds/:id/print') @RequirePermissions(P.ORDER_READ)
  print(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PrintRefundDto) { return this.svc.print(u, id, dto); }
}

@Module({ imports: [FiscalModule], controllers: [RefundsController], providers: [RefundsService] })
export class RefundsModule {}
