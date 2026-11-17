import {
  Controller, Get, HttpCode, Inject, Injectable, Module, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { DB, Db, Tx } from '../../db/db.module';
import { devices, fiscalReceipts, orderItems, orders, payments, refunds } from '../../db/schema';
import { locationSettings } from '../settings/settings';
import { deviceSettings } from '../devices/devices';
import { EsirProvider } from './esir';
import { AppConfig, CONFIG } from '../../config';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, NotFound } from '../../common/errors';
import { EventBus } from '../../common/events';
import { dec, money } from '../../common/money';

type OrderRow = typeof orders.$inferSelect;

/** Zahtev prema fiskalnom provajderu - nezavisan od konkretnog sistema (PFR/ESIR ili drugi). */
export interface FiscalRequest {
  orderId: string;
  orderNumber: number;
  invoiceType: 'NORMAL' | 'TRAINING';
  transactionType: 'SALE' | 'REFUND';
  /** REFUND: broj povraćaja i fiskalni račun prodaje na koji se odnosi (referentni dokument). */
  refundNumber?: number;
  referentDocumentNumber?: string | null;
  referentDocumentDT?: string | null;
  issuedAt: string;
  buyerId: string | null;
  buyerCostCenterId: string | null;
  items: { name: string; quantity: string; unitPrice: string; discount: string; totalAmount: string; labels: string[] }[];
  payments: { paymentType: 'Cash' | 'Card' | 'WireTransfer' | 'Other'; amount: string }[];
  total: string;
  cashier?: string | null;
  /** kasa koja izdaje račun - njen LPFR/VPFR potpisuje */
  deviceId?: string | null;
}

export type FiscalResult =
  | { ok: true; invoiceNumber: string; verificationUrl: string | null; signedAt?: string; raw: Record<string, unknown> }
  | { ok: false; retryable: boolean; error: string; raw?: Record<string, unknown> };

/**
 * Apstrakcija fiskalnog sistema: TEST adapter (podrazumevano) ili ESIR veza ka LPFR/VPFR (esir.ts),
 * koja se uključuje u podešavanjima lokala (Fiskalizacija) i podešava po kasi (ADMIN > Računari).
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
    const invoiceNumber = `TEST-${d}-${req.orderId.slice(0, 8).toUpperCase()}-${req.orderNumber}${req.refundNumber ? `-R${req.refundNumber}` : ''}`;
    return {
      ok: true, invoiceNumber, verificationUrl: null,
      raw: { test: true, message: 'TESTNI ADAPTER - OVO NIJE FISKALNI RAČUN', invoiceType: req.invoiceType, total: req.total },
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
  private readonly test = new TestFiscalProvider();
  /** zamena provajdera iz testova; undefined = normalan izbor */
  private override: FiscalizationProvider | null | undefined;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly events: EventBus,
  ) {}

  private get enabled() { return this.override !== undefined ? !!this.override : this.cfg.fiscalProvider !== 'NONE'; }

  /**
   * Ko potpisuje račun: TEST dok je u podešavanjima lokala Fiskalizacija = "bez" (NONE), inače pravi PFR kase koja izdaje račun
   * (VPFR ako je na toj kasi uključen, LPFR ako ima svoju adresu, u suprotnom način iz podešavanja lokala).
   */
  private async pick(tx: Tx | Db, locationId: string, deviceId: string | null | undefined): Promise<{ code: string; isTest: boolean } | null> {
    if (this.override !== undefined) return this.override && { code: this.override.code, isTest: this.override.isTest };
    if (this.cfg.fiscalProvider === 'NONE') return null;
    const st = await locationSettings(tx, locationId);
    if (st.fiscalMode === 'NONE') return { code: 'TEST', isTest: true };
    const dev = await this.deviceFiscal(tx, deviceId);
    return { code: dev.useVpfr ? 'VPFR' : dev.lpfrUrl ? 'LPFR' : st.fiscalMode, isTest: false };
  }

  private async deviceFiscal(tx: Tx | Db, deviceId: string | null | undefined) {
    if (!deviceId) return deviceSettings(null).fiscal;
    const [d] = await tx.select({ s: devices.settings }).from(devices).where(eq(devices.id, deviceId));
    return deviceSettings(d?.s).fiscal;
  }

  /** Provajder za obradu zahteva iz reda (po kodu upisanom pri nastanku zahteva). */
  private async providerFor(code: string, locationId: string, req: FiscalRequest): Promise<FiscalizationProvider | string> {
    if (this.override !== undefined) return this.override ?? 'Fiskalizacija je isključena';
    if (code === 'TEST') return this.test;
    if (code !== 'LPFR' && code !== 'VPFR') return `Nepoznat fiskalni provajder ${code}`;
    const st = await locationSettings(this.db, locationId);
    const dev = await this.deviceFiscal(this.db, req.deviceId);
    const url = code === 'LPFR' ? dev.lpfrUrl || st.lpfrUrl : st.vpfrUrl;
    if (!url) return code === 'LPFR' ? 'Nije podešena adresa LPFR-a (ADMIN > Računari)' : 'Nije podešena adresa VPFR-a (podešavanja lokala)';
    return new EsirProvider({
      kind: code, url, pin: dev.pin, pac: dev.pac, certPath: dev.vpfrCertPath, certPassword: dev.certPassword, esirNumber: st.esirNumber,
    });
  }

  onModuleInit() {
    if (this.cfg.fiscalWorkerIntervalMs > 0) {
      this.timer = setInterval(() => void this.processDue().catch(() => undefined), this.cfg.fiscalWorkerIntervalMs);
      this.timer.unref();
    }
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** Samo za testove: zamena provajdera (npr. provajder koji pada). */
  setProviderForTests(p: FiscalizationProvider | null | undefined) { this.override = p; }

  /** Stanje servera (bez lokala); pravi režim lokala vraća statusFor. */
  status() {
    if (this.override !== undefined) {
      return this.override ? { provider: this.override.code, isTest: this.override.isTest, mode: this.override.isTest ? 'TEST' : 'LIVE' } : { provider: 'NONE', isTest: false, mode: 'DISABLED' };
    }
    return this.enabled ? { provider: 'TEST', isTest: true, mode: 'TEST' } : { provider: 'NONE', isTest: false, mode: 'DISABLED' };
  }

  async statusFor(u: AuthUser) {
    const p = await this.pick(this.db, u.locationId, u.deviceId);
    return p ? { provider: p.code, isTest: p.isTest, mode: p.isTest ? 'TEST' : 'LIVE' } : { provider: 'NONE', isTest: false, mode: 'DISABLED' };
  }

  /** Provera veze sa PFR-om ove kase (ADMIN > Računari > Proveri vezu): status LPFR-a, bez izdavanja računa. */
  async checkConnection(u: AuthUser, deviceId: string) {
    const st = await locationSettings(this.db, u.locationId);
    const dev = await this.deviceFiscal(this.db, deviceId);
    const kind = dev.useVpfr ? 'VPFR' : 'LPFR';
    const url = kind === 'LPFR' ? dev.lpfrUrl || st.lpfrUrl : st.vpfrUrl;
    if (!url) return { ok: false, kind, message: kind === 'LPFR' ? 'Nije uneta adresa LPFR-a' : 'Nije uneta adresa VPFR-a u podešavanjima lokala' };
    const p = new EsirProvider({ kind, url, pin: dev.pin, pac: dev.pac, certPath: dev.vpfrCertPath, certPassword: dev.certPassword }, 5000);
    return { kind, url, ...(await p.check()) };
  }

  /**
   * Poziva se u ISTOJ transakciji u kojoj račun prelazi u PAID: upisuje zahtev u fiskalni red.
   * Jedan zahtev po (račun, vrsta transakcije) - jedinstveni indeks u bazi.
   */
  async enqueueForPaidOrder(tx: Tx, o: OrderRow, by: { deviceId: string | null; cashier: string | null } = { deviceId: o.deviceId, cashier: null }): Promise<string | null> {
    const provider = await this.pick(tx, o.locationId, by.deviceId);
    if (!provider) return null;
    const items = await tx.select().from(orderItems)
      .where(and(eq(orderItems.orderId, o.id), ne(orderItems.status, 'VOIDED'))).orderBy(asc(orderItems.createdAt));
    const pays = await tx.select().from(payments).where(eq(payments.orderId, o.id)).orderBy(asc(payments.createdAt));
    const req: FiscalRequest = {
      orderId: o.id, orderNumber: o.number, deviceId: by.deviceId, cashier: by.cashier,
      invoiceType: provider.isTest ? 'TRAINING' : 'NORMAL', transactionType: 'SALE',
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
      locationId: o.locationId, orderId: o.id, provider: provider.code,
      transactionType: 'SALE', invoiceType: req.invoiceType, request: req,
    }).onConflictDoNothing().returning({ id: fiscalReceipts.id });
    return row?.id ?? null;
  }

  /**
   * Refundacija (u ISTOJ transakciji kao povraćaj): vraćene stavke i količine, način povraćaja,
   * referenca na fiskalni račun prodaje. Jedan zahtev po povraćaju (jedinstveni indeks).
   */
  async enqueueRefund(tx: Tx, o: OrderRow, rf: typeof refunds.$inferSelect, lines: { orderItemId: string; quantity: string; amount: string }[],
    by: { deviceId: string | null; cashier: string | null } = { deviceId: o.deviceId, cashier: null }): Promise<string | null> {
    const provider = await this.pick(tx, o.locationId, by.deviceId);
    if (!provider) return null;
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id));
    const [sale] = await tx.select().from(fiscalReceipts).where(and(eq(fiscalReceipts.orderId, o.id), eq(fiscalReceipts.transactionType, 'SALE')));
    const req: FiscalRequest = {
      orderId: o.id, orderNumber: o.number, refundNumber: rf.number, deviceId: by.deviceId, cashier: by.cashier,
      invoiceType: provider.isTest ? 'TRAINING' : 'NORMAL', transactionType: 'REFUND',
      issuedAt: new Date().toISOString(),
      buyerId: o.buyerIdType && o.buyerId ? `${o.buyerIdType}:${o.buyerId}` : null,
      buyerCostCenterId: o.buyerOptionalBasis && o.buyerOptionalValue ? `${o.buyerOptionalBasis}:${o.buyerOptionalValue}` : null,
      referentDocumentNumber: sale?.invoiceNumber ?? null, referentDocumentDT: sale?.signedAt?.toISOString() ?? null,
      items: lines.map((l) => {
        const i = items.find((x) => x.id === l.orderItemId)!;
        return { name: i.name, quantity: l.quantity, unitPrice: i.unitPrice, discount: money(dec(i.unitPrice).mul(dec(l.quantity)).sub(dec(l.amount))), totalAmount: l.amount, labels: [i.taxLabel] };
      }),
      payments: [{ paymentType: METHOD_TO_PAYMENT[rf.method] ?? 'Other', amount: rf.total }],
      total: rf.total,
    };
    const [row] = await tx.insert(fiscalReceipts).values({
      locationId: o.locationId, orderId: o.id, refundId: rf.id, provider: provider.code,
      transactionType: 'REFUND', invoiceType: req.invoiceType, request: req,
    }).onConflictDoNothing().returning({ id: fiscalReceipts.id });
    return row?.id ?? null;
  }

  /** Obrada jednog zahteva (posle commit-a naplate). Zakup reda sprečava da ga dva procesa obrađuju istovremeno. */
  async process(id: string): Promise<void> {
    if (!this.enabled) return;
    const claimed = await this.db.execute(sql`
      UPDATE fiscal_receipts SET attempts = attempts + 1, next_attempt_at = now() + interval '60 seconds'
      WHERE id = ${id} AND status = 'PENDING' AND next_attempt_at <= now()
      RETURNING id, order_id, location_id, attempts, request, provider`);
    const r = claimed.rows[0] as any;
    if (!r) return;
    let result: FiscalResult;
    try {
      const provider = await this.providerFor(r.provider, r.location_id, r.request as FiscalRequest);
      result = typeof provider === 'string'
        ? { ok: false, retryable: true, error: provider }
        : await provider.sign(r.request as FiscalRequest);
    } catch (e: any) {
      result = { ok: false, retryable: true, error: String(e?.message ?? e) };
    }
    if (result.ok) {
      const pfrTime = result.signedAt ? new Date(result.signedAt) : null;
      await this.db.update(fiscalReceipts).set({
        status: 'SIGNED', invoiceNumber: result.invoiceNumber, verificationUrl: result.verificationUrl,
        response: result.raw, signedAt: pfrTime && !isNaN(pfrTime.getTime()) ? pfrTime : new Date(), lastError: null,
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

  /** Obrada sa ograničenim čekanjem - odgovor naplate ne sme da visi zbog fiskalnog sistema. */
  async processWithTimeout(id: string | null, ms = 5000) {
    if (!id) return;
    await Promise.race([this.process(id).catch(() => undefined), new Promise((res) => setTimeout(res, ms).unref())]);
  }

  async processDue() {
    if (this.running || !this.enabled) return;
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
    return { status: await this.statusFor(u), data: rows.map((r) => ({ ...summary(r.f), orderNumber: r.orderNumber, total: r.total })) };
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
  status(@CurrentUser() u: AuthUser) { return this.svc.statusFor(u); }

  @Post('check/:deviceId') @HttpCode(200) @RequirePermissions(P.SETTINGS_MANAGE)
  check(@CurrentUser() u: AuthUser, @Param('deviceId', ParseUUIDPipe) deviceId: string) { return this.svc.checkConnection(u, deviceId); }

  @Get('receipts') @RequirePermissions(P.SETTINGS_MANAGE)
  list(@CurrentUser() u: AuthUser, @Query() q: FiscalListQuery) { return this.svc.list(u, q); }

  @Post('receipts/:id/retry') @HttpCode(200) @RequirePermissions(P.SETTINGS_MANAGE)
  retry(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.retry(u, id); }
}

@Module({ controllers: [FiscalController], providers: [FiscalService], exports: [FiscalService] })
export class FiscalModule {}
