import {
  Controller, Get, HttpCode, Inject, Injectable, Module, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { DB, Db, Tx } from '../../db/db.module';
import { fiscalReceipts, orderItems, orders, payments } from '../../db/schema';
import { AppConfig, CONFIG } from '../../config';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, NotFound } from '../../common/errors';
import { EventBus } from '../../common/events';
import { dec, money } from '../../common/money';

type OrderRow = typeof orders.$inferSelect;

/** Zahtev prema fiskalnom provajderu — nezavisan od konkretnog sistema (PFR/ESIR ili drugi). */
export interface FiscalRequest {
  orderId: string;
  orderNumber: number;
  invoiceType: 'NORMAL' | 'TRAINING';
  transactionType: 'SALE' | 'REFUND';
  issuedAt: string;
  buyerId: string | null;
  buyerCostCenterId: string | null;
  items: { name: string; quantity: string; unitPrice: string; discount: string; totalAmount: string; labels: string[] }[];
  payments: { paymentType: 'Cash' | 'Card' | 'WireTransfer' | 'Other'; amount: string }[];
  total: string;
}

export type FiscalResult =
  | { ok: true; invoiceNumber: string; verificationUrl: string | null; raw: Record<string, unknown> }
  | { ok: false; retryable: boolean; error: string; raw?: Record<string, unknown> };

/**
 * Apstrakcija fiskalnog sistema. Stvarna integracija (PFR/ESIR, sertifikati, bezbednosni element)
 * NIJE implementirana — postoji samo testni adapter.
 */
export interface FiscalizationProvider {
  readonly code: string;
  /** true = računi NISU fiskalni i to mora biti jasno prikazano svuda */
  readonly isTest: boolean;
  sign(req: FiscalRequest): Promise<FiscalResult>;
}

/**
 * Testni adapter: ništa ne šalje van sistema. Broj računa je deterministički po porudžbini i
 * uvek počinje sa "TEST-", a odgovor nosi oznaku da račun nije fiskalni. Nema verifikacionog URL-a.
 */
export class TestFiscalProvider implements FiscalizationProvider {
  readonly code = 'TEST';
  readonly isTest = true;
  async sign(req: FiscalRequest): Promise<FiscalResult> {
    const d = req.issuedAt.slice(0, 10).replace(/-/g, '');
    const invoiceNumber = `TEST-${d}-${req.orderId.slice(0, 8).toUpperCase()}-${req.orderNumber}`;
    return {
      ok: true, invoiceNumber, verificationUrl: null,
      raw: { test: true, message: 'TESTNI ADAPTER — OVO NIJE FISKALNI RAČUN', invoiceType: req.invoiceType, total: req.total },
    };
  }
}

const METHOD_TO_PAYMENT: Record<string, FiscalRequest['payments'][number]['paymentType']> = {
  CASH: 'Cash', CARD: 'Card', TRANSFER: 'WireTransfer', REPRESENTATION: 'Other',
};
const MAX_ATTEMPTS = 8;

class FiscalListQuery {
  @IsOptional() @IsIn(['PENDING', 'SIGNED', 'FAILED', 'NOT_REQUIRED']) status?: 'PENDING' | 'SIGNED' | 'FAILED' | 'NOT_REQUIRED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@Injectable()
export class FiscalService implements OnModuleInit, OnModuleDestroy {
  private provider: FiscalizationProvider | null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly events: EventBus,
  ) {
    this.provider = cfg.fiscalProvider === 'TEST' ? new TestFiscalProvider() : null;
  }

  onModuleInit() {
    if (this.cfg.fiscalWorkerIntervalMs > 0) {
      this.timer = setInterval(() => void this.processDue().catch(() => undefined), this.cfg.fiscalWorkerIntervalMs);
      this.timer.unref();
    }
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** Samo za testove: zamena provajdera (npr. provajder koji pada). */
  setProviderForTests(p: FiscalizationProvider | null) { this.provider = p; }

  status() {
    return this.provider
      ? { provider: this.provider.code, isTest: this.provider.isTest, mode: this.provider.isTest ? 'TEST' : 'LIVE' }
      : { provider: 'NONE', isTest: false, mode: 'DISABLED' };
  }

  /**
   * Poziva se u ISTOJ transakciji u kojoj račun prelazi u PAID: upisuje zahtev u fiskalni red.
   * Jedan zahtev po (račun, vrsta transakcije) — jedinstveni indeks u bazi.
   */
  async enqueueForPaidOrder(tx: Tx, o: OrderRow): Promise<string | null> {
    if (!this.provider) return null;
    const items = await tx.select().from(orderItems)
      .where(and(eq(orderItems.orderId, o.id), ne(orderItems.status, 'VOIDED'))).orderBy(asc(orderItems.createdAt));
    const pays = await tx.select().from(payments).where(eq(payments.orderId, o.id)).orderBy(asc(payments.createdAt));
    const req: FiscalRequest = {
      orderId: o.id, orderNumber: o.number,
      invoiceType: this.provider.isTest ? 'TRAINING' : 'NORMAL', transactionType: 'SALE',
      issuedAt: new Date().toISOString(),
      buyerId: o.buyerIdType && o.buyerId ? `${o.buyerIdType}:${o.buyerId}` : null,
      buyerCostCenterId: o.buyerOptionalBasis && o.buyerOptionalValue ? `${o.buyerOptionalBasis}:${o.buyerOptionalValue}` : null,
      items: items.map((i) => ({
        name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discountAmount,
        totalAmount: money(dec(i.lineTotal).sub(dec(i.discountAmount))), labels: [i.taxLabel],
      })),
      payments: pays.map((p) => ({ paymentType: METHOD_TO_PAYMENT[p.method] ?? 'Other', amount: p.amount })),
      total: o.total,
    };
    const [row] = await tx.insert(fiscalReceipts).values({
      locationId: o.locationId, orderId: o.id, provider: this.provider.code,
      transactionType: 'SALE', invoiceType: req.invoiceType, request: req,
    }).onConflictDoNothing().returning({ id: fiscalReceipts.id });
    return row?.id ?? null;
  }

  /** Obrada jednog zahteva (posle commit-a naplate). Zakup reda sprečava da ga dva procesa obrađuju istovremeno. */
  async process(id: string): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    const claimed = await this.db.execute(sql`
      UPDATE fiscal_receipts SET attempts = attempts + 1, next_attempt_at = now() + interval '60 seconds'
      WHERE id = ${id} AND status = 'PENDING' AND next_attempt_at <= now()
      RETURNING id, order_id, location_id, attempts, request`);
    const r = claimed.rows[0] as any;
    if (!r) return;
    let result: FiscalResult;
    try {
      result = await provider.sign(r.request as FiscalRequest);
    } catch (e: any) {
      result = { ok: false, retryable: true, error: String(e?.message ?? e) };
    }
    if (result.ok) {
      await this.db.update(fiscalReceipts).set({
        status: 'SIGNED', invoiceNumber: result.invoiceNumber, verificationUrl: result.verificationUrl,
        response: result.raw, signedAt: new Date(), lastError: null,
      }).where(and(eq(fiscalReceipts.id, id), eq(fiscalReceipts.status, 'PENDING')));
    } else {
      const giveUp = !result.retryable || r.attempts >= MAX_ATTEMPTS;
      const delaySec = Math.min(600, 5 * 2 ** (r.attempts - 1));
      await this.db.update(fiscalReceipts).set({
        status: giveUp ? 'FAILED' : 'PENDING', lastError: result.error, response: result.raw ?? null,
        nextAttemptAt: new Date(Date.now() + delaySec * 1000),
      }).where(and(eq(fiscalReceipts.id, id), eq(fiscalReceipts.status, 'PENDING')));
    }
    this.events.publish({ type: 'fiscal.updated', locationId: r.location_id, data: { orderId: r.order_id, fiscalReceiptId: id } });
  }

  /** Obrada sa ograničenim čekanjem — odgovor naplate ne sme da visi zbog fiskalnog sistema. */
  async processWithTimeout(id: string | null, ms = 5000) {
    if (!id) return;
    await Promise.race([this.process(id).catch(() => undefined), new Promise((res) => setTimeout(res, ms).unref())]);
  }

  async processDue() {
    if (this.running || !this.provider) return;
    this.running = true;
    try {
      const due = await this.db.select({ id: fiscalReceipts.id }).from(fiscalReceipts)
        .where(and(eq(fiscalReceipts.status, 'PENDING'), sql`${fiscalReceipts.nextAttemptAt} <= now()`))
        .orderBy(asc(fiscalReceipts.createdAt)).limit(20);
      for (const d of due) await this.process(d.id);
    } finally {
      this.running = false;
    }
  }

  async forOrder(orderId: string) {
    const [f] = await this.db.select().from(fiscalReceipts)
      .where(and(eq(fiscalReceipts.orderId, orderId), eq(fiscalReceipts.transactionType, 'SALE')));
    return f ? summary(f) : null;
  }

  async list(u: AuthUser, q: FiscalListQuery) {
    const conds = [eq(fiscalReceipts.locationId, u.locationId)];
    if (q.status) conds.push(eq(fiscalReceipts.status, q.status));
    const rows = await this.db.select({ f: fiscalReceipts, orderNumber: orders.number, total: orders.total })
      .from(fiscalReceipts).innerJoin(orders, eq(orders.id, fiscalReceipts.orderId))
      .where(and(...conds)).orderBy(desc(fiscalReceipts.createdAt)).limit(q.limit ?? 100);
    return { status: this.status(), data: rows.map((r) => ({ ...summary(r.f), orderNumber: r.orderNumber, total: r.total })) };
  }

  /** Ponovni pokušaj za FAILED zahtev (ručno, uz pravo). */
  async retry(u: AuthUser, id: string) {
    const [f] = await this.db.select().from(fiscalReceipts)
      .where(and(eq(fiscalReceipts.id, id), eq(fiscalReceipts.locationId, u.locationId)));
    if (!f) throw NotFound('Fiskalni zahtev');
    if (f.status !== 'FAILED') throw Conflict('FISCAL_NOT_FAILED', `Ponovni pokušaj je moguć samo za neuspele zahteve (sada: ${f.status})`);
    await this.db.transaction(async (tx) => {
      await tx.update(fiscalReceipts).set({ status: 'PENDING', nextAttemptAt: new Date(), attempts: 0 }).where(eq(fiscalReceipts.id, id));
      await audit(tx, u, 'fiscal.retry', 'order', f.orderId, { fiscalReceiptId: id });
    });
    await this.processWithTimeout(id);
    return this.forOrder(f.orderId);
  }
}

export function summary(f: typeof fiscalReceipts.$inferSelect) {
  return {
    id: f.id, orderId: f.orderId, provider: f.provider, isTest: f.provider === 'TEST' || f.invoiceType === 'TRAINING',
    invoiceType: f.invoiceType, status: f.status, invoiceNumber: f.invoiceNumber, verificationUrl: f.verificationUrl,
    attempts: f.attempts, lastError: f.lastError, signedAt: f.signedAt, createdAt: f.createdAt,
  };
}

@ApiTags('fiscal') @ApiBearerAuth()
@Controller('fiscal')
export class FiscalController {
  constructor(private readonly svc: FiscalService) {}

  @Get('status') @RequirePermissions(P.ORDER_READ)
  status() { return this.svc.status(); }

  @Get('receipts') @RequirePermissions(P.SETTINGS_MANAGE)
  list(@CurrentUser() u: AuthUser, @Query() q: FiscalListQuery) { return this.svc.list(u, q); }

  @Post('receipts/:id/retry') @HttpCode(200) @RequirePermissions(P.SETTINGS_MANAGE)
  retry(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.retry(u, id); }
}

@Module({ controllers: [FiscalController], providers: [FiscalService], exports: [FiscalService] })
export class FiscalModule {}
