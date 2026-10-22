import {
  Body, CanActivate, Controller, createParamDecorator, ExecutionContext, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post,
  Query, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min,
} from 'class-validator';
import { createHash, randomBytes } from 'crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import {
  devices, diningTables, kdsTickets, orderItems, orders, prepStations, printers, printJobs, users, fiscalReceipts, payments,
  locations,
} from '../../db/schema';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { EventBus } from '../../common/events';
import { summary as fiscalSummary } from '../fiscal/fiscal';

// ---------------------------------------------------------------- DTO

class PrinterDto {
  @IsString() @Length(1, 60) name: string;
  @IsIn(['SIMULATED', 'NETWORK_ESCPOS', 'WINDOWS_RAW']) connection: 'SIMULATED' | 'NETWORK_ESCPOS' | 'WINDOWS_RAW';
  @IsOptional() @Matches(/^[A-Za-z0-9.\-]{1,120}$/, { message: 'Host: IP adresa ili naziv računara' }) host?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number | null;
  @IsOptional() @IsString() @Length(1, 200) windowsName?: string | null;
  @IsOptional() @IsIn([58, 80]) paperWidth?: 58 | 80;
}
class UpdatePrinterDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsIn(['SIMULATED', 'NETWORK_ESCPOS', 'WINDOWS_RAW']) connection?: 'SIMULATED' | 'NETWORK_ESCPOS' | 'WINDOWS_RAW';
  @IsOptional() @Matches(/^[A-Za-z0-9.\-]{1,120}$/) host?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number | null;
  @IsOptional() @IsString() @Length(1, 200) windowsName?: string | null;
  @IsOptional() @IsIn([58, 80]) paperWidth?: 58 | 80;
  @IsOptional() @IsBoolean() active?: boolean;
}
class StationDto {
  @IsString() @Length(1, 60) name: string;
  @IsOptional() @IsIn(['BAR', 'KITCHEN', 'OTHER']) kind?: 'BAR' | 'KITCHEN' | 'OTHER';
  @IsOptional() @IsUUID() printerId?: string | null;
  @IsOptional() @IsBoolean() kdsEnabled?: boolean;
}
class UpdateStationDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsIn(['BAR', 'KITCHEN', 'OTHER']) kind?: 'BAR' | 'KITCHEN' | 'OTHER';
  @IsOptional() @IsUUID() printerId?: string | null;
  @IsOptional() @IsBoolean() kdsEnabled?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
class BridgeDto { @IsString() @Length(1, 60) name: string; }
class DeviceReceiptPrinterDto { @IsOptional() @IsUUID() receiptPrinterId: string | null; }
class JobsQuery {
  @IsOptional() @IsIn(['PENDING', 'PRINTING', 'PRINTED', 'SIMULATED', 'FAILED']) status?: 'PENDING' | 'PRINTING' | 'PRINTED' | 'SIMULATED' | 'FAILED';
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}
class PrintReceiptDto { @IsString() @Length(8, 80) idempotencyKey: string; }
class KdsTicketsQuery {
  @IsOptional() @IsUUID() stationId?: string;
  @IsOptional() @IsIn(['active', 'done']) view?: 'active' | 'done';
}
class TicketStatusDto {
  @IsIn(['NEW', 'IN_PROGRESS', 'READY', 'DONE']) status: 'NEW' | 'IN_PROGRESS' | 'READY' | 'DONE';
}
class ItemReadyDto { @IsBoolean() ready: boolean; }
class ClaimDto { @IsOptional() @IsInt() @Min(1) @Max(20) limit?: number; }
class JobResultDto {
  @IsIn(['PRINTED', 'SIMULATED', 'FAILED']) status: 'PRINTED' | 'SIMULATED' | 'FAILED';
  @IsOptional() @IsString() @Length(1, 500) error?: string;
  /** false = trajna greška (npr. neispravna konfiguracija) — nema ponovnog pokušaja */
  @IsOptional() @IsBoolean() retryable?: boolean;
}

const MAX_PRINT_ATTEMPTS = 6;
/** Zadatak koji je bridge preuzeo a nije javio rezultat vraća se u red posle ovog vremena. */
const CLAIM_TIMEOUT_SEC = 60;

export const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');

// ---------------------------------------------------------------- ADMIN: pozicije, štampači, bridge

@Injectable()
export class PrepAdminService {
  constructor(@Inject(DB) private readonly db: Db, private readonly events: EventBus) {}

  private validatePrinter(p: { connection?: string; host?: string | null; port?: number | null; windowsName?: string | null }) {
    if (p.connection === 'NETWORK_ESCPOS' && (!p.host || !p.port)) {
      throw Invalid('PRINTER_CONFIG', 'Mrežni ESC/POS štampač zahteva IP adresu i port (obično 9100)');
    }
    if (p.connection === 'WINDOWS_RAW' && !p.windowsName) {
      throw Invalid('PRINTER_CONFIG', 'Windows štampač zahteva tačan naziv štampača iz Windows-a');
    }
  }

  listPrinters(u: AuthUser) {
    return this.db.select().from(printers).where(eq(printers.locationId, u.locationId)).orderBy(asc(printers.name));
  }

  createPrinter(u: AuthUser, dto: PrinterDto) {
    this.validatePrinter(dto);
    return this.db.transaction(async (tx) => {
      const [p] = await tx.insert(printers).values({
        locationId: u.locationId, name: dto.name.trim(), connection: dto.connection, host: dto.host ?? null,
        port: dto.port ?? null, windowsName: dto.windowsName ?? null, paperWidth: dto.paperWidth ?? 80,
      }).returning();
      await audit(tx, u, 'printer.create', 'printer', p.id, { name: p.name, connection: p.connection });
      return p;
    });
  }

  updatePrinter(u: AuthUser, id: string, dto: UpdatePrinterDto) {
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(printers).where(and(eq(printers.id, id), eq(printers.locationId, u.locationId))).for('update');
      if (!cur) throw NotFound('Štampač');
      // samo zaista poslata polja (polja klase DTO mogu postojati kao undefined)
      this.validatePrinter({ ...cur, ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) });
      const [p] = await tx.update(printers).set({ ...dto, name: dto.name?.trim() ?? cur.name }).where(eq(printers.id, id)).returning();
      await audit(tx, u, 'printer.update', 'printer', id, dto as any);
      return p;
    });
  }

  async listStations(u: AuthUser) {
    return this.db.select({ s: prepStations, printerName: printers.name }).from(prepStations)
      .leftJoin(printers, eq(printers.id, prepStations.printerId))
      .where(eq(prepStations.locationId, u.locationId)).orderBy(asc(prepStations.name))
      .then((rows) => rows.map((r) => ({ ...r.s, printerName: r.printerName })));
  }

  private async assertPrinter(tx: any, u: AuthUser, printerId?: string | null) {
    if (!printerId) return;
    const [p] = await tx.select({ id: printers.id }).from(printers)
      .where(and(eq(printers.id, printerId), eq(printers.locationId, u.locationId)));
    if (!p) throw Invalid('INVALID_PRINTER', 'Štampač ne postoji u ovom lokalu');
  }

  createStation(u: AuthUser, dto: StationDto) {
    return this.db.transaction(async (tx) => {
      await this.assertPrinter(tx, u, dto.printerId);
      const [s] = await tx.insert(prepStations).values({
        locationId: u.locationId, name: dto.name.trim(), kind: dto.kind ?? 'OTHER', printerId: dto.printerId ?? null,
        kdsEnabled: dto.kdsEnabled ?? true,
      }).returning();
      await audit(tx, u, 'station.create', 'station', s.id, { name: s.name });
      return s;
    });
  }

  updateStation(u: AuthUser, id: string, dto: UpdateStationDto) {
    return this.db.transaction(async (tx) => {
      await this.assertPrinter(tx, u, dto.printerId);
      const [s] = await tx.update(prepStations).set({ ...dto, ...(dto.name ? { name: dto.name.trim() } : {}) })
        .where(and(eq(prepStations.id, id), eq(prepStations.locationId, u.locationId))).returning();
      if (!s) throw NotFound('Pripremna pozicija');
      await audit(tx, u, 'station.update', 'station', id, dto as any);
      return s;
    });
  }

  async setDeviceReceiptPrinter(u: AuthUser, deviceId: string, dto: DeviceReceiptPrinterDto) {
    return this.db.transaction(async (tx) => {
      await this.assertPrinter(tx, u, dto.receiptPrinterId);
      const [d] = await tx.update(devices).set({ receiptPrinterId: dto.receiptPrinterId })
        .where(and(eq(devices.id, deviceId), eq(devices.locationId, u.locationId), ne(devices.kind, 'BRIDGE')))
        .returning({ id: devices.id, name: devices.name, receiptPrinterId: devices.receiptPrinterId });
      if (!d) throw NotFound('Uređaj');
      await audit(tx, u, 'device.receipt_printer', 'device', deviceId, { printerId: dto.receiptPrinterId });
      return d;
    });
  }

  listDevices(u: AuthUser) {
    return this.db.select({
      id: devices.id, name: devices.name, kind: devices.kind, active: devices.active, receiptPrinterId: devices.receiptPrinterId,
      apiKeyPrefix: devices.apiKeyPrefix, lastSeenAt: devices.lastSeenAt,
    }).from(devices).where(eq(devices.locationId, u.locationId)).orderBy(asc(devices.kind), asc(devices.name));
  }

  /** Novi Print Bridge: ključ se vraća SAMO u ovom odgovoru; u bazi je samo njegov SHA-256 heš. */
  createBridge(u: AuthUser, dto: BridgeDto) {
    return this.db.transaction(async (tx) => {
      const key = `pb_${randomBytes(32).toString('base64url')}`;
      const [d] = await tx.insert(devices).values({
        locationId: u.locationId, name: dto.name.trim(), kind: 'BRIDGE', apiKeyHash: hashKey(key), apiKeyPrefix: key.slice(0, 10),
      }).returning({ id: devices.id, name: devices.name, apiKeyPrefix: devices.apiKeyPrefix });
      await audit(tx, u, 'bridge.create', 'device', d.id, { name: d.name, keyPrefix: d.apiKeyPrefix });
      return { ...d, apiKey: key, warning: 'Ključ se prikazuje samo jednom. Upišite ga u konfiguraciju Print Bridge-a.' };
    });
  }

  rotateBridgeKey(u: AuthUser, id: string) {
    return this.db.transaction(async (tx) => {
      const key = `pb_${randomBytes(32).toString('base64url')}`;
      const [d] = await tx.update(devices).set({ apiKeyHash: hashKey(key), apiKeyPrefix: key.slice(0, 10) })
        .where(and(eq(devices.id, id), eq(devices.locationId, u.locationId), eq(devices.kind, 'BRIDGE')))
        .returning({ id: devices.id, name: devices.name, apiKeyPrefix: devices.apiKeyPrefix });
      if (!d) throw NotFound('Print Bridge');
      await audit(tx, u, 'bridge.rotate_key', 'device', id, { keyPrefix: d.apiKeyPrefix });
      return { ...d, apiKey: key, warning: 'Stari ključ više ne važi. Novi ključ se prikazuje samo jednom.' };
    });
  }

  async listJobs(u: AuthUser, q: JobsQuery) {
    const conds = [eq(printJobs.locationId, u.locationId)];
    if (q.status) conds.push(eq(printJobs.status, q.status));
    if (q.orderId) conds.push(eq(printJobs.orderId, q.orderId));
    const rows = await this.db.select({ j: printJobs, printerName: printers.name, stationName: prepStations.name })
      .from(printJobs).innerJoin(printers, eq(printers.id, printJobs.printerId))
      .leftJoin(prepStations, eq(prepStations.id, printJobs.stationId))
      .where(and(...conds)).orderBy(desc(printJobs.createdAt)).limit(q.limit ?? 100);
    return rows.map((r) => ({ ...r.j, printerName: r.printerName, stationName: r.stationName }));
  }

  async retryJob(u: AuthUser, id: string) {
    const r = await this.db.transaction(async (tx) => {
      const [j] = await tx.update(printJobs).set({ status: 'PENDING', nextAttemptAt: new Date(), attempts: 0, lastError: null })
        .where(and(eq(printJobs.id, id), eq(printJobs.locationId, u.locationId), eq(printJobs.status, 'FAILED'))).returning();
      if (!j) throw Conflict('JOB_NOT_FAILED', 'Ponovna štampa iz reda je moguća samo za neuspele zadatke');
      await audit(tx, u, 'print.retry', 'print_job', id, {});
      return j;
    });
    this.events.publish({ type: 'print.job.updated', locationId: u.locationId, data: { jobId: id } });
    return r;
  }

  async testPage(u: AuthUser, printerId: string) {
    const [p] = await this.db.select().from(printers).where(and(eq(printers.id, printerId), eq(printers.locationId, u.locationId)));
    if (!p) throw NotFound('Štampač');
    const [j] = await this.db.insert(printJobs).values({
      locationId: u.locationId, printerId, kind: 'TEST_PAGE', dedupeKey: `test:${randomBytes(12).toString('hex')}`,
      payload: { title: 'PROBNA STRANA', printer: p.name, connection: p.connection, paperWidth: p.paperWidth, createdAt: new Date().toISOString(), by: u.fullName },
    }).returning();
    this.events.publish({ type: 'print.job.created', locationId: u.locationId, data: { jobId: j.id, printerId } });
    return j;
  }

  /**
   * Štampa računa na štampaču ove kase. Sadržaj nosi stanje fiskalizacije:
   * bez potvrđenog (SIGNED) fiskalnog odgovora, ili sa TEST provajderom, na papiru piše da račun NIJE fiskalni.
   */
  async printReceipt(u: AuthUser, orderId: string, dto: PrintReceiptDto) {
    if (!u.deviceId) throw Conflict('NO_DEVICE', 'Štampa računa je moguća samo sa registrovane kase');
    const [dev] = await this.db.select({ printerId: devices.receiptPrinterId }).from(devices).where(eq(devices.id, u.deviceId));
    if (!dev?.printerId) throw Conflict('NO_RECEIPT_PRINTER', 'Za ovu kasu nije podešen štampač računa (ADMIN → Štampa)');
    const [o] = await this.db.select({ o: orders, waiter: users.fullName, table: diningTables.name, location: locations.name })
      .from(orders).innerJoin(users, eq(users.id, orders.waiterId)).innerJoin(locations, eq(locations.id, orders.locationId))
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(and(eq(orders.id, orderId), eq(orders.locationId, u.locationId)));
    if (!o) throw NotFound('Porudžbina');
    if (o.o.waiterId !== u.userId && !u.permissions.includes(P.ORDER_READ_ALL)) throw NotFound('Porudžbina');
    const dedupeKey = `receipt:${orderId}:${dto.idempotencyKey}`;
    const [existing] = await this.db.select().from(printJobs).where(eq(printJobs.dedupeKey, dedupeKey));
    if (existing) return { job: existing, idempotentReplay: true };

    const items = await this.db.select().from(orderItems)
      .where(and(eq(orderItems.orderId, orderId), ne(orderItems.status, 'VOIDED'))).orderBy(asc(orderItems.createdAt));
    const pays = await this.db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(asc(payments.createdAt));
    const [f] = await this.db.select().from(fiscalReceipts).where(eq(fiscalReceipts.orderId, orderId));
    const fiscal = f ? fiscalSummary(f) : null;
    const isFiscal = !!fiscal && fiscal.status === 'SIGNED' && !fiscal.isTest;
    const [{ copies }] = await this.db.select({ copies: sql<number>`count(*)::int` }).from(printJobs)
      .where(and(eq(printJobs.orderId, orderId), eq(printJobs.kind, 'RECEIPT')));
    const payload = {
      title: o.o.status === 'PAID' ? 'RAČUN' : 'PREDRAČUN',
      location: o.location, orderNumber: o.o.number, table: o.table, tab: o.o.tabName, waiter: o.waiter,
      createdAt: new Date().toISOString(),
      lines: items.map((i) => ({ qty: i.quantity, name: i.name, unitPrice: i.unitPrice, total: i.lineTotal, taxLabel: i.taxLabel })),
      subtotal: o.o.subtotal, discount: o.o.discountTotal, total: o.o.total,
      payments: pays.map((p) => ({ method: p.method, amount: p.amount, change: p.change })),
      fiscal: fiscal ? { status: fiscal.status, invoiceNumber: fiscal.invoiceNumber, isTest: fiscal.isTest } : null,
      notFiscalNotice: isFiscal ? null
        : fiscal?.isTest ? 'TEST — OVO NIJE FISKALNI RAČUN'
          : 'OVO NIJE FISKALNI RAČUN',
      copy: copies > 0,
    };
    const [j] = await this.db.insert(printJobs).values({
      locationId: u.locationId, printerId: dev.printerId, orderId, kind: 'RECEIPT', dedupeKey, payload,
    }).onConflictDoNothing().returning();
    if (!j) {
      const [again] = await this.db.select().from(printJobs).where(eq(printJobs.dedupeKey, dedupeKey));
      return { job: again, idempotentReplay: true };
    }
    await this.db.transaction((tx) => audit(tx, u, 'print.receipt', 'order', orderId, { jobId: j.id, copy: payload.copy }));
    this.events.publish({ type: 'print.job.created', locationId: u.locationId, data: { jobId: j.id, printerId: j.printerId } });
    return { job: j, idempotentReplay: false };
  }
}

// ---------------------------------------------------------------- KDS

const TRANSITIONS: Record<string, string[]> = {
  NEW: ['IN_PROGRESS', 'READY', 'DONE'],
  IN_PROGRESS: ['NEW', 'READY', 'DONE'],
  READY: ['IN_PROGRESS', 'DONE'],
  DONE: ['READY'], // vraćanje greškom zatvorene kartice
};

@Injectable()
export class KdsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly events: EventBus) {}

  stations(u: AuthUser) {
    return this.db.select({ id: prepStations.id, name: prepStations.name, kind: prepStations.kind })
      .from(prepStations)
      .where(and(eq(prepStations.locationId, u.locationId), eq(prepStations.active, true), eq(prepStations.kdsEnabled, true)))
      .orderBy(asc(prepStations.name));
  }

  async tickets(u: AuthUser, q: KdsTicketsQuery, ids?: string[]) {
    const conds = [eq(kdsTickets.locationId, u.locationId)];
    if (q.stationId) conds.push(eq(kdsTickets.stationId, q.stationId));
    if (ids) conds.push(inArray(kdsTickets.id, ids));
    else if (q.view === 'done') conds.push(eq(kdsTickets.status, 'DONE'));
    else conds.push(ne(kdsTickets.status, 'DONE'));
    const rows = await this.db.select({
      t: kdsTickets, orderNumber: orders.number, tabName: orders.tabName, orderStatus: orders.status,
      table: diningTables.name, waiter: users.fullName, station: prepStations.name,
    }).from(kdsTickets)
      .innerJoin(orders, eq(orders.id, kdsTickets.orderId))
      .innerJoin(users, eq(users.id, orders.waiterId))
      .innerJoin(prepStations, eq(prepStations.id, kdsTickets.stationId))
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(and(...conds))
      .orderBy(q.view === 'done' ? desc(kdsTickets.doneAt) : asc(kdsTickets.createdAt))
      .limit(q.view === 'done' ? 50 : 300);
    const tIds = rows.map((r) => r.t.id);
    const items = tIds.length
      ? await this.db.select({
        id: orderItems.id, ticketId: orderItems.kdsTicketId, name: orderItems.name, quantity: orderItems.quantity,
        note: orderItems.note, status: orderItems.status, readyAt: orderItems.readyAt, voidReason: orderItems.voidReason,
      }).from(orderItems).where(inArray(orderItems.kdsTicketId, tIds)).orderBy(asc(orderItems.createdAt))
      : [];
    return rows.map((r) => ({
      ...r.t, orderNumber: r.orderNumber, tabName: r.tabName, orderStatus: r.orderStatus, table: r.table,
      waiter: r.waiter, station: r.station, items: items.filter((i) => i.ticketId === r.t.id),
    }));
  }

  private publishTicket(u: AuthUser, t: { id: string; stationId: string; orderId: string }) {
    this.events.publish({ type: 'kds.ticket.updated', locationId: u.locationId, stationId: t.stationId, data: { ticketId: t.id, orderId: t.orderId } });
    this.events.publish({ type: 'order.prep.updated', locationId: u.locationId, data: { orderId: t.orderId } });
  }

  async setStatus(u: AuthUser, id: string, dto: TicketStatusDto) {
    const t = await this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(kdsTickets)
        .where(and(eq(kdsTickets.id, id), eq(kdsTickets.locationId, u.locationId))).for('update');
      if (!cur) throw NotFound('KDS kartica');
      if (cur.status === dto.status) return cur; // ponovljen zahtev (npr. dvostruki dodir) — bez promene
      if (!TRANSITIONS[cur.status].includes(dto.status)) {
        throw Conflict('INVALID_TRANSITION', `Prelaz ${cur.status} → ${dto.status} nije dozvoljen`);
      }
      const now = new Date();
      const patch: Partial<typeof kdsTickets.$inferInsert> = { status: dto.status };
      if (dto.status === 'IN_PROGRESS' && !cur.startedAt) patch.startedAt = now;
      if (dto.status === 'READY') patch.readyAt = now;
      if (dto.status === 'DONE') patch.doneAt = now;
      if (dto.status === 'NEW' || dto.status === 'IN_PROGRESS') patch.readyAt = null;
      if (dto.status !== 'DONE') patch.doneAt = null;
      const [t] = await tx.update(kdsTickets).set(patch).where(eq(kdsTickets.id, id)).returning();
      if (dto.status === 'READY' || dto.status === 'DONE') {
        await tx.update(orderItems).set({ readyAt: now })
          .where(and(eq(orderItems.kdsTicketId, id), sql`${orderItems.readyAt} IS NULL`, ne(orderItems.status, 'VOIDED')));
      }
      await audit(tx, u, 'kds.ticket.status', 'order', cur.orderId, { ticketId: id, from: cur.status, to: dto.status });
      return t;
    });
    this.publishTicket(u, t);
    return (await this.tickets(u, {}, [id]))[0];
  }

  /** Stavka spremna / nije spremna. Kada su sve aktivne stavke spremne, kartica prelazi u READY. */
  async setItemReady(u: AuthUser, itemId: string, dto: ItemReadyDto) {
    const t = await this.db.transaction(async (tx) => {
      const [it] = await tx.select({ id: orderItems.id, ticketId: orderItems.kdsTicketId, status: orderItems.status })
        .from(orderItems).where(eq(orderItems.id, itemId));
      if (!it?.ticketId) throw NotFound('Stavka na KDS-u');
      const [cur] = await tx.select().from(kdsTickets)
        .where(and(eq(kdsTickets.id, it.ticketId), eq(kdsTickets.locationId, u.locationId))).for('update');
      if (!cur) throw NotFound('KDS kartica');
      if (it.status === 'VOIDED') throw Conflict('ITEM_VOIDED', 'Stavka je stornirana');
      await tx.update(orderItems).set({ readyAt: dto.ready ? new Date() : null }).where(eq(orderItems.id, itemId));
      const [{ open }] = await tx.select({ open: sql<number>`count(*)::int` }).from(orderItems)
        .where(and(eq(orderItems.kdsTicketId, cur.id), ne(orderItems.status, 'VOIDED'), sql`${orderItems.readyAt} IS NULL`));
      let status = cur.status;
      if (open === 0 && (cur.status === 'NEW' || cur.status === 'IN_PROGRESS')) status = 'READY';
      if (open > 0 && cur.status === 'READY') status = 'IN_PROGRESS';
      if (cur.status === 'NEW' && dto.ready && open > 0) status = 'IN_PROGRESS';
      const [t] = await tx.update(kdsTickets).set({
        status,
        startedAt: cur.startedAt ?? (status !== 'NEW' ? new Date() : null),
        readyAt: status === 'READY' ? new Date() : null,
      }).where(eq(kdsTickets.id, cur.id)).returning();
      await audit(tx, u, 'kds.item.ready', 'order', cur.orderId, { itemId, ready: dto.ready });
      return t;
    });
    this.publishTicket(u, t);
    return (await this.tickets(u, {}, [t.id]))[0];
  }
}

// ---------------------------------------------------------------- Print Bridge API (ključ uređaja)

export interface BridgeDevice { id: string; locationId: string; name: string }

@Injectable()
export class BridgeKeyGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers['x-bridge-key'];
    if (typeof key !== 'string' || !key.startsWith('pb_') || key.length > 200) throw new UnauthorizedException('Nedostaje ili je neispravan X-Bridge-Key');
    const [d] = await this.db.select({ id: devices.id, locationId: devices.locationId, name: devices.name, active: devices.active })
      .from(devices).where(and(eq(devices.apiKeyHash, hashKey(key)), eq(devices.kind, 'BRIDGE')));
    if (!d || !d.active) throw new UnauthorizedException('Print Bridge ključ nije važeći ili je uređaj deaktiviran');
    req.bridge = { id: d.id, locationId: d.locationId, name: d.name } as BridgeDevice;
    return true;
  }
}

@Injectable()
export class BridgeService {
  constructor(@Inject(DB) private readonly db: Db, private readonly events: EventBus) {}

  async hello(b: BridgeDevice) {
    await this.db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, b.id));
    const list = await this.db.select().from(printers).where(and(eq(printers.locationId, b.locationId), eq(printers.active, true)));
    return { bridge: b, printers: list, claimTimeoutSec: CLAIM_TIMEOUT_SEC, serverTime: new Date().toISOString() };
  }

  /**
   * Atomsko preuzimanje zadataka (FOR UPDATE SKIP LOCKED): dva bridge-a nikad ne dobiju isti zadatak.
   * Zadatak koji je ostao PRINTING duže od CLAIM_TIMEOUT_SEC (bridge pao) vraća se u obradu.
   */
  async claim(b: BridgeDevice, dto: ClaimDto) {
    await this.db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, b.id));
    const r = await this.db.execute(sql`
      UPDATE print_jobs j SET status = 'PRINTING', claimed_by_device_id = ${b.id}, claimed_at = now(), attempts = j.attempts + 1
      WHERE j.id IN (
        SELECT id FROM print_jobs
        WHERE location_id = ${b.locationId}
          AND ((status = 'PENDING' AND next_attempt_at <= now())
            OR (status = 'PRINTING' AND claimed_at < now() - make_interval(secs => ${CLAIM_TIMEOUT_SEC})))
        ORDER BY created_at
        LIMIT ${dto.limit ?? 5}
        FOR UPDATE SKIP LOCKED)
      RETURNING j.id`);
    const ids = (r.rows as any[]).map((x) => x.id as string);
    if (!ids.length) return { jobs: [] };
    const rows = await this.db.select({ j: printJobs, p: printers }).from(printJobs)
      .innerJoin(printers, eq(printers.id, printJobs.printerId)).where(inArray(printJobs.id, ids)).orderBy(asc(printJobs.createdAt));
    for (const id of ids) this.events.publish({ type: 'print.job.updated', locationId: b.locationId, data: { jobId: id } });
    return {
      jobs: rows.map(({ j, p }) => ({
        id: j.id, kind: j.kind, attempts: j.attempts, payload: j.payload, createdAt: j.createdAt,
        printer: { id: p.id, name: p.name, connection: p.connection, host: p.host, port: p.port, windowsName: p.windowsName, paperWidth: p.paperWidth, active: p.active },
      })),
    };
  }

  /** Rezultat štampe. Prihvata se samo od bridge-a koji je zadatak preuzeo, i samo dok je zadatak u štampi. */
  async result(b: BridgeDevice, id: string, dto: JobResultDto) {
    const j = await this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(printJobs).where(and(eq(printJobs.id, id), eq(printJobs.locationId, b.locationId))).for('update');
      if (!cur) throw NotFound('Zadatak štampe');
      if (cur.status !== 'PRINTING' || cur.claimedByDeviceId !== b.id) {
        // Ponovljen rezultat istog bridge-a za već završen zadatak — idempotentno vraćamo stanje.
        if (cur.claimedByDeviceId === b.id && ['PRINTED', 'SIMULATED', 'FAILED'].includes(cur.status)) return cur;
        throw Conflict('JOB_NOT_CLAIMED', 'Zadatak nije u štampi kod ovog bridge-a (možda je istekao zakup)');
      }
      if (dto.status === 'FAILED') {
        const giveUp = dto.retryable === false || cur.attempts >= MAX_PRINT_ATTEMPTS;
        const delaySec = Math.min(300, 5 * 2 ** (cur.attempts - 1));
        const [u] = await tx.update(printJobs).set({
          status: giveUp ? 'FAILED' : 'PENDING', lastError: dto.error ?? 'Nepoznata greška štampača',
          nextAttemptAt: new Date(Date.now() + delaySec * 1000), finishedAt: giveUp ? new Date() : null,
        }).where(eq(printJobs.id, id)).returning();
        return u;
      }
      const [u] = await tx.update(printJobs).set({ status: dto.status, lastError: null, finishedAt: new Date() })
        .where(eq(printJobs.id, id)).returning();
      return u;
    });
    this.events.publish({ type: 'print.job.updated', locationId: b.locationId, data: { jobId: id, status: j.status } });
    return { id: j.id, status: j.status, attempts: j.attempts, nextAttemptAt: j.nextAttemptAt, lastError: j.lastError };
  }
}

// ---------------------------------------------------------------- kontroleri

@ApiTags('print') @ApiBearerAuth()
@Controller()
export class PrepAdminController {
  constructor(private readonly svc: PrepAdminService) {}

  @Get('printers') @RequirePermissions(P.SETTINGS_MANAGE)
  printers(@CurrentUser() u: AuthUser) { return this.svc.listPrinters(u); }
  @Post('printers') @RequirePermissions(P.SETTINGS_MANAGE)
  createPrinter(@CurrentUser() u: AuthUser, @Body() dto: PrinterDto) { return this.svc.createPrinter(u, dto); }
  @Patch('printers/:id') @RequirePermissions(P.SETTINGS_MANAGE)
  updatePrinter(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePrinterDto) { return this.svc.updatePrinter(u, id, dto); }
  @Post('printers/:id/test') @RequirePermissions(P.SETTINGS_MANAGE)
  test(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.testPage(u, id); }

  @Get('prep-stations') @RequirePermissions(P.CATALOG_READ)
  stations(@CurrentUser() u: AuthUser) { return this.svc.listStations(u); }
  @Post('prep-stations') @RequirePermissions(P.SETTINGS_MANAGE)
  createStation(@CurrentUser() u: AuthUser, @Body() dto: StationDto) { return this.svc.createStation(u, dto); }
  @Patch('prep-stations/:id') @RequirePermissions(P.SETTINGS_MANAGE)
  updateStation(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStationDto) { return this.svc.updateStation(u, id, dto); }

  @Get('devices') @RequirePermissions(P.SETTINGS_MANAGE)
  devices(@CurrentUser() u: AuthUser) { return this.svc.listDevices(u); }
  @Patch('devices/:id/receipt-printer') @RequirePermissions(P.SETTINGS_MANAGE)
  setReceiptPrinter(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeviceReceiptPrinterDto) {
    return this.svc.setDeviceReceiptPrinter(u, id, dto);
  }
  @Post('print-bridges') @RequirePermissions(P.SETTINGS_MANAGE)
  createBridge(@CurrentUser() u: AuthUser, @Body() dto: BridgeDto) { return this.svc.createBridge(u, dto); }
  @Post('print-bridges/:id/rotate-key') @HttpCode(200) @RequirePermissions(P.SETTINGS_MANAGE)
  rotate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.rotateBridgeKey(u, id); }

  @Get('print-jobs') @RequirePermissions(P.SETTINGS_MANAGE)
  jobs(@CurrentUser() u: AuthUser, @Query() q: JobsQuery) { return this.svc.listJobs(u, q); }
  @Post('print-jobs/:id/retry') @HttpCode(200) @RequirePermissions(P.SETTINGS_MANAGE)
  retry(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.retryJob(u, id); }

  @Post('orders/:id/print-receipt') @RequirePermissions(P.ORDER_READ)
  printReceipt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PrintReceiptDto) {
    return this.svc.printReceipt(u, id, dto);
  }
}

@ApiTags('kds') @ApiBearerAuth()
@Controller('kds')
export class KdsController {
  constructor(private readonly svc: KdsService) {}
  @Get('stations') @RequirePermissions(P.KDS_USE)
  stations(@CurrentUser() u: AuthUser) { return this.svc.stations(u); }
  @Get('tickets') @RequirePermissions(P.KDS_USE)
  tickets(@CurrentUser() u: AuthUser, @Query() q: KdsTicketsQuery) { return this.svc.tickets(u, q); }
  @Post('tickets/:id/status') @HttpCode(200) @RequirePermissions(P.KDS_USE)
  status(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TicketStatusDto) { return this.svc.setStatus(u, id, dto); }
  @Post('items/:id/ready') @HttpCode(200) @RequirePermissions(P.KDS_USE)
  ready(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ItemReadyDto) { return this.svc.setItemReady(u, id, dto); }
}

export const CurrentBridge = createParamDecorator((_: unknown, ctx: ExecutionContext): BridgeDevice => ctx.switchToHttp().getRequest().bridge);

@ApiTags('print-bridge') @ApiHeader({ name: 'X-Bridge-Key', required: true })
@Controller('bridge')
@Public() @UseGuards(BridgeKeyGuard)
export class BridgeController {
  constructor(private readonly svc: BridgeService) {}
  @Post('hello') @HttpCode(200)
  hello(@CurrentBridge() b: BridgeDevice) { return this.svc.hello(b); }
  @Post('jobs/claim') @HttpCode(200)
  claim(@CurrentBridge() b: BridgeDevice, @Body() dto: ClaimDto) { return this.svc.claim(b, dto); }
  @Post('jobs/:id/result') @HttpCode(200)
  result(@CurrentBridge() b: BridgeDevice, @Param('id', ParseUUIDPipe) id: string, @Body() dto: JobResultDto) { return this.svc.result(b, id, dto); }
}

@Module({
  controllers: [PrepAdminController, KdsController, BridgeController],
  providers: [PrepAdminService, KdsService, BridgeService, BridgeKeyGuard],
  exports: [KdsService],
})
export class PrepModule {}
