import { ToBool } from '../../common/to-bool';
import {
  Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min,
  ValidateNested,
} from 'class-validator';
import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql, SQL } from 'drizzle-orm';
import { DB, Db, Tx } from '../../db/db.module';
import {
  locations, partners, products, stockBalances, stockDocumentLines, stockDocuments, stockMovements, users, warehouses,
  orders, prepStations,
} from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { isValidPib } from '../../common/buyer';
import { dec, money } from '../../common/money';
import { applyMovement, lockBalances, MoveInput, q4 } from './engine';

export const QTY_RE = /^\d{1,11}([.,]\d{1,4})?$/;
export const COST_RE = /^\d{1,11}([.,]\d{1,4})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const normNum = (s: string) => s.replace(',', '.');

export const DOC_KINDS = ['RECEIPT', 'ISSUE', 'RETURN', 'TRANSFER', 'WRITE_OFF', 'INTERNAL', 'STOCKTAKE'] as const;
type DocKind = (typeof DOC_KINDS)[number];
export const DOC_PREFIX: Record<DocKind, string> = {
  RECEIPT: 'PRI', ISSUE: 'IZL', RETURN: 'POV', TRANSFER: 'MP', WRITE_OFF: 'OTP', INTERNAL: 'IP', STOCKTAKE: 'POP',
};
export const DOC_LABEL: Record<DocKind, string> = {
  RECEIPT: 'Prijemnica (ulaz robe)', ISSUE: 'Izlaz robe', RETURN: 'Povrat dobavljaču', TRANSFER: 'Prenos između skladišta',
  WRITE_OFF: 'Otpis', INTERNAL: 'Interna potrošnja', STOCKTAKE: 'Popis',
};
const NEEDS_PARTNER: DocKind[] = ['RECEIPT', 'RETURN'];

// ---------------------------------------------------------------- DTO

class PartnerDto {
  @IsString() @Length(1, 160) name: string;
  @IsOptional() @IsIn(['SUPPLIER', 'CUSTOMER', 'BOTH']) kind?: 'SUPPLIER' | 'CUSTOMER' | 'BOTH';
  @IsOptional() @Matches(/^\d{9}$/, { message: 'PIB ima 9 cifara' }) taxId?: string | null;
  @IsOptional() @Matches(/^\d{8}$/, { message: 'Matični broj ima 8 cifara' }) registrationNo?: string | null;
  @IsOptional() @IsString() @Length(0, 200) address?: string | null;
  @IsOptional() @IsString() @Length(0, 100) city?: string | null;
  @IsOptional() @IsEmail() email?: string | null;
  @IsOptional() @IsString() @Length(0, 40) phone?: string | null;
}
class UpdatePartnerDto {
  @IsOptional() @IsString() @Length(1, 160) name?: string;
  @IsOptional() @IsIn(['SUPPLIER', 'CUSTOMER', 'BOTH']) kind?: 'SUPPLIER' | 'CUSTOMER' | 'BOTH';
  @IsOptional() @Matches(/^\d{9}$/, { message: 'PIB ima 9 cifara' }) taxId?: string | null;
  @IsOptional() @Matches(/^\d{8}$/, { message: 'Matični broj ima 8 cifara' }) registrationNo?: string | null;
  @IsOptional() @IsString() @Length(0, 200) address?: string | null;
  @IsOptional() @IsString() @Length(0, 100) city?: string | null;
  @IsOptional() @IsEmail() email?: string | null;
  @IsOptional() @IsString() @Length(0, 40) phone?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
class PartnerQuery {
  @IsOptional() @IsString() @Length(1, 60) search?: string;
  @IsOptional() @ToBool() @IsBoolean() includeInactive?: boolean;
}
class WarehouseDto {
  @IsString() @Length(1, 60) name: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
class UpdateWarehouseDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
class StationWarehouseDto { @IsOptional() @IsUUID() warehouseId: string | null; }
class CreateDocDto {
  @IsIn(DOC_KINDS as unknown as string[]) kind: DocKind;
  @IsUUID() warehouseId: string;
  @IsOptional() @IsUUID() targetWarehouseId?: string | null;
  @IsOptional() @IsUUID() partnerId?: string | null;
  @IsOptional() @Matches(DATE_RE) docDate?: string;
  @IsOptional() @IsString() @Length(0, 60) externalNumber?: string | null;
  @IsOptional() @IsString() @Length(0, 500) note?: string | null;
}
class UpdateDocDto {
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsUUID() targetWarehouseId?: string | null;
  @IsOptional() @IsUUID() partnerId?: string | null;
  @IsOptional() @Matches(DATE_RE) docDate?: string;
  @IsOptional() @IsString() @Length(0, 60) externalNumber?: string | null;
  @IsOptional() @IsString() @Length(0, 500) note?: string | null;
  @IsOptional() @IsInt() expectedVersion?: number;
}
export class DocLineDto {
  @IsUUID() productId: string;
  @Matches(QTY_RE, { message: 'Količina: broj sa najviše 4 decimale' }) quantity: string;
  @IsOptional() @Matches(COST_RE, { message: 'Cena: broj sa najviše 4 decimale' }) unitCost?: string | null;
  @IsOptional() @IsString() @Length(0, 200) note?: string | null;
}
class SetLinesDto {
  @IsArray() @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => DocLineDto) lines: DocLineDto[];
  @IsOptional() @IsInt() expectedVersion?: number;
}
class PostDocDto { @IsOptional() @IsInt() expectedVersion?: number; }
class CancelDocDto { @IsString() @Length(3, 300) reason: string; }
class DocQuery {
  @IsOptional() @IsIn(DOC_KINDS as unknown as string[]) kind?: DocKind;
  @IsOptional() @IsIn(['DRAFT', 'POSTED', 'CANCELLED']) status?: 'DRAFT' | 'POSTED' | 'CANCELLED';
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}
class BalanceQuery {
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsString() @Length(1, 60) search?: string;
  @IsOptional() @ToBool() @IsBoolean() nonZero?: boolean;
}
class CardQuery {
  @IsUUID() productId: string;
  @IsUUID() warehouseId: string;
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
}

const todayIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

// ---------------------------------------------------------------- servis

@Injectable()
export class StockService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ----- partneri

  listPartners(u: AuthUser, q: PartnerQuery) {
    const conds: SQL[] = [eq(partners.organizationId, u.organizationId)];
    if (!q.includeInactive) conds.push(eq(partners.active, true));
    if (q.search) {
      const t = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`;
      conds.push(or(ilike(partners.name, t), ilike(partners.taxId, t), ilike(partners.city, t))!);
    }
    return this.db.select().from(partners).where(and(...conds)).orderBy(asc(partners.name)).limit(500);
  }

  private checkPartner(dto: { taxId?: string | null }) {
    if (dto.taxId && !isValidPib(dto.taxId)) throw Invalid('INVALID_PIB', 'PIB nije ispravan (kontrolna cifra)');
  }

  createPartner(u: AuthUser, dto: PartnerDto) {
    this.checkPartner(dto);
    return this.db.transaction(async (tx) => {
      const [p] = await tx.insert(partners).values({ organizationId: u.organizationId, ...dto, name: dto.name.trim() }).returning();
      await audit(tx, u, 'partner.create', 'partner', p.id, { name: p.name, taxId: p.taxId });
      return p;
    });
  }

  updatePartner(u: AuthUser, id: string, dto: UpdatePartnerDto) {
    this.checkPartner(dto);
    return this.db.transaction(async (tx) => {
      const [p] = await tx.update(partners).set({ ...dto, ...(dto.name ? { name: dto.name.trim() } : {}), updatedAt: new Date() })
        .where(and(eq(partners.id, id), eq(partners.organizationId, u.organizationId))).returning();
      if (!p) throw NotFound('Partner');
      await audit(tx, u, 'partner.update', 'partner', id, dto as any);
      return p;
    });
  }

  // ----- skladišta

  listWarehouses(u: AuthUser) {
    return this.db.select().from(warehouses).where(eq(warehouses.locationId, u.locationId)).orderBy(desc(warehouses.isDefault), asc(warehouses.name));
  }

  createWarehouse(u: AuthUser, dto: WarehouseDto) {
    return this.db.transaction(async (tx) => {
      if (dto.isDefault) await tx.update(warehouses).set({ isDefault: false }).where(eq(warehouses.locationId, u.locationId));
      const [w] = await tx.insert(warehouses).values({ locationId: u.locationId, name: dto.name.trim(), isDefault: !!dto.isDefault }).returning();
      await audit(tx, u, 'warehouse.create', 'warehouse', w.id, { name: w.name });
      return w;
    });
  }

  updateWarehouse(u: AuthUser, id: string, dto: UpdateWarehouseDto) {
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(warehouses).where(and(eq(warehouses.id, id), eq(warehouses.locationId, u.locationId))).for('update');
      if (!cur) throw NotFound('Skladište');
      if (dto.isDefault === false && cur.isDefault) throw Invalid('DEFAULT_REQUIRED', 'Lokal mora imati podrazumevano skladište — postavite drugo kao podrazumevano');
      if (dto.active === false && (cur.isDefault || dto.isDefault)) throw Invalid('DEFAULT_REQUIRED', 'Podrazumevano skladište ne može da se isključi');
      if (dto.isDefault) await tx.update(warehouses).set({ isDefault: false }).where(and(eq(warehouses.locationId, u.locationId), ne(warehouses.id, id)));
      const [w] = await tx.update(warehouses).set({ ...dto, ...(dto.name ? { name: dto.name.trim() } : {}) }).where(eq(warehouses.id, id)).returning();
      await audit(tx, u, 'warehouse.update', 'warehouse', id, dto as any);
      return w;
    });
  }

  async setStationWarehouse(u: AuthUser, stationId: string, dto: StationWarehouseDto) {
    return this.db.transaction(async (tx) => {
      if (dto.warehouseId) await this.warehouse(tx, u, dto.warehouseId);
      const [s] = await tx.update(prepStations).set({ warehouseId: dto.warehouseId })
        .where(and(eq(prepStations.id, stationId), eq(prepStations.locationId, u.locationId))).returning();
      if (!s) throw NotFound('Pripremna pozicija');
      await audit(tx, u, 'station.warehouse', 'station', stationId, { warehouseId: dto.warehouseId });
      return s;
    });
  }

  private async warehouse(tx: Tx | Db, u: AuthUser, id: string) {
    const [w] = await tx.select().from(warehouses).where(and(eq(warehouses.id, id), eq(warehouses.locationId, u.locationId)));
    if (!w) throw Invalid('INVALID_WAREHOUSE', 'Skladište ne postoji u ovom lokalu');
    if (!w.active) throw Invalid('WAREHOUSE_INACTIVE', `Skladište „${w.name}“ nije aktivno`);
    return w;
  }

  // ----- dokumenta

  private async lockDoc(tx: Tx, u: AuthUser, id: string, expectedVersion?: number) {
    const [d] = await tx.select().from(stockDocuments)
      .where(and(eq(stockDocuments.id, id), eq(stockDocuments.locationId, u.locationId))).for('update');
    if (!d) throw NotFound('Dokument');
    if (expectedVersion !== undefined && expectedVersion !== d.version) {
      throw Conflict('STALE_DOCUMENT', 'Dokument je u međuvremenu izmenio neko drugi. Osvežite prikaz.', { expectedVersion, currentVersion: d.version });
    }
    return d;
  }
  private requireDraft(d: typeof stockDocuments.$inferSelect) {
    if (d.status !== 'DRAFT') throw Conflict('DOC_NOT_DRAFT', `Dokument je ${d.status === 'POSTED' ? 'proknjižen' : 'storniran'} i ne može se menjati`);
  }

  private async validateHeader(tx: Tx, u: AuthUser, kind: DocKind, h: { warehouseId: string; targetWarehouseId?: string | null; partnerId?: string | null }) {
    await this.warehouse(tx, u, h.warehouseId);
    if (kind === 'TRANSFER') {
      if (!h.targetWarehouseId) throw Invalid('TARGET_REQUIRED', 'Prenos zahteva ciljno skladište');
      if (h.targetWarehouseId === h.warehouseId) throw Invalid('SAME_WAREHOUSE', 'Ciljno skladište mora biti različito od izvornog');
      await this.warehouse(tx, u, h.targetWarehouseId);
    }
    if (h.partnerId) {
      const [p] = await tx.select({ id: partners.id }).from(partners)
        .where(and(eq(partners.id, h.partnerId), eq(partners.organizationId, u.organizationId)));
      if (!p) throw Invalid('INVALID_PARTNER', 'Partner ne postoji');
    }
  }

  async createDoc(u: AuthUser, dto: CreateDocDto) {
    return this.db.transaction(async (tx) => {
      await this.validateHeader(tx, u, dto.kind, dto);
      const [loc] = await tx.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, u.locationId));
      const [d] = await tx.insert(stockDocuments).values({
        locationId: u.locationId, kind: dto.kind, warehouseId: dto.warehouseId,
        targetWarehouseId: dto.kind === 'TRANSFER' ? dto.targetWarehouseId ?? null : null,
        partnerId: dto.partnerId ?? null, docDate: dto.docDate ?? todayIn(loc.tz), externalNumber: dto.externalNumber ?? null,
        note: dto.note ?? null, createdById: u.userId,
      }).returning();
      await audit(tx, u, 'stock.doc.create', 'stock_document', d.id, { kind: d.kind });
      return this.getDoc(u, d.id, tx);
    });
  }

  async updateDoc(u: AuthUser, id: string, dto: UpdateDocDto) {
    return this.db.transaction(async (tx) => {
      const d = await this.lockDoc(tx, u, id, dto.expectedVersion);
      this.requireDraft(d);
      const { expectedVersion, ...patch } = dto;
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const next = { ...d, ...clean };
      await this.validateHeader(tx, u, d.kind, next as any);
      await tx.update(stockDocuments).set({ ...clean, version: d.version + 1, updatedAt: new Date() }).where(eq(stockDocuments.id, id));
      return this.getDoc(u, id, tx);
    });
  }

  /** Zamena svih stavki nacrta (jednostavno za UI i uvoz). Isti artikal ne sme dvaput. */
  async setLines(u: AuthUser, id: string, dto: SetLinesDto) {
    return this.db.transaction(async (tx) => {
      const d = await this.lockDoc(tx, u, id, dto.expectedVersion);
      this.requireDraft(d);
      await this.validateLines(tx, u, d.kind, dto.lines);
      await tx.delete(stockDocumentLines).where(eq(stockDocumentLines.documentId, id));
      if (dto.lines.length) {
        await tx.insert(stockDocumentLines).values(dto.lines.map((l, i) => ({
          documentId: id, productId: l.productId, quantity: q4(dec(normNum(l.quantity))),
          unitCost: l.unitCost ? q4(dec(normNum(l.unitCost))) : null, note: l.note ?? null, sortOrder: i,
        })));
      }
      await tx.update(stockDocuments).set({ version: d.version + 1, updatedAt: new Date() }).where(eq(stockDocuments.id, id));
      return this.getDoc(u, id, tx);
    });
  }

  async validateLines(tx: Tx | Db, u: AuthUser, kind: DocKind, lines: DocLineDto[]) {
    const ids = lines.map((l) => l.productId);
    const dup = ids.find((x, i) => ids.indexOf(x) !== i);
    if (dup) throw Invalid('DUPLICATE_LINE', 'Isti artikal je naveden više puta — saberite količine u jednu stavku', { productId: dup });
    const prods = ids.length ? await tx.select({ id: products.id, name: products.name, trackStock: products.trackStock })
      .from(products).where(and(inArray(products.id, ids), eq(products.organizationId, u.organizationId))) : [];
    const errors: { index: number; message: string }[] = [];
    lines.forEach((l, i) => {
      const p = prods.find((x) => x.id === l.productId);
      if (!p) return errors.push({ index: i, message: 'Artikal ne postoji' });
      if (!p.trackStock) errors.push({ index: i, message: `„${p.name}“ nema uključeno vođenje zalihe` });
      const q = dec(normNum(l.quantity));
      if (kind !== 'STOCKTAKE' && q.lte(0)) errors.push({ index: i, message: `„${p.name}“: količina mora biti veća od 0` });
      if (kind === 'RECEIPT' && (l.unitCost === undefined || l.unitCost === null || l.unitCost === '')) errors.push({ index: i, message: `„${p.name}“: nabavna cena je obavezna na prijemnici` });
    });
    if (errors.length) throw Invalid('INVALID_LINES', errors.map((e) => `Red ${e.index + 1}: ${e.message}`).join('; '), { errors });
  }

  /** Popis: dodaje sve artikle sa vođenjem zalihe (sa trenutnim knjižnim stanjem kao predlogom izbrojanog). */
  async fillStocktake(u: AuthUser, id: string) {
    return this.db.transaction(async (tx) => {
      const d = await this.lockDoc(tx, u, id);
      this.requireDraft(d);
      if (d.kind !== 'STOCKTAKE') throw Invalid('NOT_STOCKTAKE', 'Samo za popis');
      const existing = new Set((await tx.select({ p: stockDocumentLines.productId }).from(stockDocumentLines).where(eq(stockDocumentLines.documentId, id))).map((r) => r.p));
      const rows = await tx.select({ id: products.id, qty: stockBalances.quantity }).from(products)
        .leftJoin(stockBalances, and(eq(stockBalances.productId, products.id), eq(stockBalances.warehouseId, d.warehouseId)))
        .where(and(eq(products.organizationId, u.organizationId), eq(products.trackStock, true), eq(products.active, true)))
        .orderBy(asc(products.name));
      const add = rows.filter((r) => !existing.has(r.id));
      if (add.length) {
        const base = existing.size;
        await tx.insert(stockDocumentLines).values(add.map((r, i) => ({
          documentId: id, productId: r.id, quantity: q4(dec(r.qty ?? 0).lt(0) ? dec(0) : dec(r.qty ?? 0)), sortOrder: base + i,
        })));
      }
      await tx.update(stockDocuments).set({ version: d.version + 1, updatedAt: new Date() }).where(eq(stockDocuments.id, id));
      return this.getDoc(u, id, tx);
    });
  }

  private async nextNumber(tx: Tx, locationId: string, kind: string) {
    const r = await tx.execute(sql`
      INSERT INTO document_counters (location_id, kind, last_value) VALUES (${locationId}, ${kind}, 1)
      ON CONFLICT (location_id, kind) DO UPDATE SET last_value = document_counters.last_value + 1
      RETURNING last_value`);
    return Number((r.rows[0] as any).last_value);
  }

  /**
   * Knjiženje: sve stavke ili nijedna (jedna transakcija). Ručni dokumenti NE smeju da odvedu stanje u minus.
   * Ponovljeno knjiženje već proknjiženog dokumenta vraća dokument bez promene (idempotentno).
   */
  async postDoc(u: AuthUser, id: string, dto: PostDocDto) {
    return this.db.transaction(async (tx) => {
      const d = await this.lockDoc(tx, u, id);
      if (d.status === 'POSTED') return { ...(await this.getDoc(u, id, tx)), alreadyPosted: true };
      this.requireDraft(d);
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== d.version) {
        throw Conflict('STALE_DOCUMENT', 'Dokument je u međuvremenu izmenjen. Proverite stavke pre knjiženja.');
      }
      const kind = d.kind as DocKind;
      if (NEEDS_PARTNER.includes(kind) && !d.partnerId) throw Invalid('PARTNER_REQUIRED', `${DOC_LABEL[kind]} zahteva partnera (dobavljača)`);
      await this.validateHeader(tx, u, kind, d);
      const lines = await tx.select({ l: stockDocumentLines, name: products.name }).from(stockDocumentLines)
        .innerJoin(products, eq(products.id, stockDocumentLines.productId))
        .where(eq(stockDocumentLines.documentId, id)).orderBy(asc(stockDocumentLines.sortOrder));
      if (!lines.length) throw Invalid('NO_LINES', 'Dokument nema stavki');
      await this.validateLines(tx, u, kind, lines.map((x) => ({ productId: x.l.productId, quantity: x.l.quantity, unitCost: x.l.unitCost })));

      const pairs = lines.flatMap(({ l }) => [{ warehouseId: d.warehouseId, productId: l.productId },
        ...(d.targetWarehouseId ? [{ warehouseId: d.targetWarehouseId, productId: l.productId }] : [])]);
      await lockBalances(tx, pairs);

      const base = { locationId: d.locationId, documentId: d.id, userId: u.userId, source: 'DOCUMENT' as const };
      for (const { l, name } of lines) {
        const q = dec(l.quantity);
        const common = { ...base, productId: l.productId, documentLineId: l.id, productName: name };
        if (kind === 'RECEIPT') {
          await applyMovement(tx, { ...common, warehouseId: d.warehouseId, quantity: q, unitCost: dec(l.unitCost), allowNegative: false });
        } else if (kind === 'TRANSFER') {
          const out = await applyMovement(tx, { ...common, warehouseId: d.warehouseId, quantity: q.neg(), allowNegative: false });
          await applyMovement(tx, { ...common, warehouseId: d.targetWarehouseId!, quantity: q, unitCost: dec(out.unitCost), allowNegative: false });
        } else if (kind === 'STOCKTAKE') {
          const [b] = await tx.select().from(stockBalances)
            .where(and(eq(stockBalances.warehouseId, d.warehouseId), eq(stockBalances.productId, l.productId)));
          const book = dec(b?.quantity ?? 0);
          await tx.update(stockDocumentLines).set({ bookQuantity: q4(book) }).where(eq(stockDocumentLines.id, l.id));
          const diff = q.sub(book);
          if (!diff.isZero()) {
            await applyMovement(tx, {
              ...common, warehouseId: d.warehouseId, quantity: diff, allowNegative: true,
              unitCost: diff.gt(0) && l.unitCost ? dec(l.unitCost) : undefined,
            });
          }
        } else {
          // ISSUE, RETURN, WRITE_OFF, INTERNAL — izlaz po prosečnoj nabavnoj ceni
          await applyMovement(tx, { ...common, warehouseId: d.warehouseId, quantity: q.neg(), allowNegative: false });
        }
      }
      const number = await this.nextNumber(tx, d.locationId, `STOCK_${kind}`);
      await tx.update(stockDocuments).set({
        status: 'POSTED', number, postedById: u.userId, postedAt: new Date(), version: d.version + 1, updatedAt: new Date(),
      }).where(eq(stockDocuments.id, id));
      await audit(tx, u, 'stock.doc.post', 'stock_document', id, { kind, number, lines: lines.length });
      return { ...(await this.getDoc(u, id, tx)), alreadyPosted: false };
    });
  }

  /**
   * Storno: nacrt se samo označava kao storniran; proknjižen dokument dobija suprotna kretanja
   * (po istoj ceni) — kartica ostaje potpuna. Storno koji bi stanje odveo u minus se odbija.
   */
  async cancelDoc(u: AuthUser, id: string, dto: CancelDocDto) {
    return this.db.transaction(async (tx) => {
      const d = await this.lockDoc(tx, u, id);
      if (d.status === 'CANCELLED') throw Conflict('DOC_ALREADY_CANCELLED', 'Dokument je već storniran');
      if (d.status === 'POSTED') {
        const moves = await tx.select({ m: stockMovements, name: products.name }).from(stockMovements)
          .innerJoin(products, eq(products.id, stockMovements.productId))
          .where(and(eq(stockMovements.documentId, id), eq(stockMovements.source, 'DOCUMENT')))
          .orderBy(asc(stockMovements.seq));
        await lockBalances(tx, moves.map(({ m }) => m));
        // obrnutim redosledom: kod prenosa prvo se skida sa ciljnog skladišta
        for (const { m, name } of [...moves].reverse()) {
          const input: MoveInput = {
            locationId: m.locationId, warehouseId: m.warehouseId, productId: m.productId, quantity: dec(m.quantity).neg(),
            unitCost: dec(m.unitCost), source: 'REVERSAL', allowNegative: false, documentId: id, reversesMovementId: m.id,
            userId: u.userId, productName: name,
          };
          await applyMovement(tx, input);
        }
      }
      await tx.update(stockDocuments).set({
        status: 'CANCELLED', cancelledById: u.userId, cancelledAt: new Date(), cancelReason: dto.reason,
        version: d.version + 1, updatedAt: new Date(),
      }).where(eq(stockDocuments.id, id));
      await audit(tx, u, 'stock.doc.cancel', 'stock_document', id, { wasPosted: d.status === 'POSTED', reason: dto.reason });
      return this.getDoc(u, id, tx);
    });
  }

  async getDoc(u: AuthUser, id: string, tx: Tx | Db = this.db) {
    const [d] = await tx.select().from(stockDocuments).where(and(eq(stockDocuments.id, id), eq(stockDocuments.locationId, u.locationId)));
    if (!d) throw NotFound('Dokument');
    const lines = await tx.select({
      l: stockDocumentLines, code: products.code, name: products.name, unit: products.unit,
    }).from(stockDocumentLines).innerJoin(products, eq(products.id, stockDocumentLines.productId))
      .where(eq(stockDocumentLines.documentId, id)).orderBy(asc(stockDocumentLines.sortOrder));
    const [wh] = await tx.select({ name: warehouses.name }).from(warehouses).where(eq(warehouses.id, d.warehouseId));
    const [tw] = d.targetWarehouseId ? await tx.select({ name: warehouses.name }).from(warehouses).where(eq(warehouses.id, d.targetWarehouseId)) : [undefined];
    const [pt] = d.partnerId ? await tx.select({ name: partners.name, taxId: partners.taxId }).from(partners).where(eq(partners.id, d.partnerId)) : [undefined];
    const [cb] = await tx.select({ name: users.fullName }).from(users).where(eq(users.id, d.createdById));
    const moves = d.status === 'DRAFT' ? [] : await tx.select({ lineId: stockMovements.documentLineId, value: stockMovements.value, source: stockMovements.source, warehouseId: stockMovements.warehouseId, unitCost: stockMovements.unitCost })
      .from(stockMovements).where(eq(stockMovements.documentId, id));
    let total = dec(0);
    const outLines = lines.map(({ l, code, name, unit }) => {
      const q = dec(l.quantity);
      const mv = moves.find((m) => m.lineId === l.id && m.source === 'DOCUMENT' && m.warehouseId === d.warehouseId);
      const cost = l.unitCost ?? mv?.unitCost ?? null;
      const value = d.kind === 'STOCKTAKE' ? (mv ? dec(mv.value) : dec(0)) : cost ? q.mul(dec(cost)) : null;
      if (value) total = total.add(value);
      return {
        ...l, code, name, unit,
        value: value ? money(value) : null,
        difference: d.kind === 'STOCKTAKE' && l.bookQuantity !== null ? q4(q.sub(dec(l.bookQuantity))) : null,
      };
    });
    return {
      ...d, kindLabel: DOC_LABEL[d.kind as DocKind],
      displayNumber: d.number ? `${DOC_PREFIX[d.kind as DocKind]}-${d.number}` : null,
      warehouseName: wh?.name, targetWarehouseName: tw?.name ?? null, partnerName: pt?.name ?? null, partnerTaxId: pt?.taxId ?? null,
      createdByName: cb?.name, lines: outLines, total: money(total),
    };
  }

  async listDocs(u: AuthUser, q: DocQuery) {
    const page = q.page ?? 1; const pageSize = q.pageSize ?? 50;
    const conds: SQL[] = [eq(stockDocuments.locationId, u.locationId)];
    if (q.kind) conds.push(eq(stockDocuments.kind, q.kind));
    if (q.status) conds.push(eq(stockDocuments.status, q.status));
    if (q.warehouseId) conds.push(or(eq(stockDocuments.warehouseId, q.warehouseId), eq(stockDocuments.targetWarehouseId, q.warehouseId))!);
    if (q.partnerId) conds.push(eq(stockDocuments.partnerId, q.partnerId));
    if (q.from) conds.push(gte(stockDocuments.docDate, q.from));
    if (q.to) conds.push(lte(stockDocuments.docDate, q.to));
    const where = and(...conds);
    const [{ total }] = await this.db.select({ total: sql<number>`count(*)::int` }).from(stockDocuments).where(where);
    const rows = await this.db.select({
      d: stockDocuments, partnerName: partners.name, warehouseName: warehouses.name,
      lines: sql<number>`(SELECT count(*)::int FROM stock_document_lines l WHERE l.document_id = ${stockDocuments.id})`,
    }).from(stockDocuments).innerJoin(warehouses, eq(warehouses.id, stockDocuments.warehouseId))
      .leftJoin(partners, eq(partners.id, stockDocuments.partnerId))
      .where(where).orderBy(desc(stockDocuments.docDate), desc(stockDocuments.createdAt))
      .limit(pageSize).offset((page - 1) * pageSize);
    return {
      data: rows.map((r) => ({
        ...r.d, kindLabel: DOC_LABEL[r.d.kind as DocKind], displayNumber: r.d.number ? `${DOC_PREFIX[r.d.kind as DocKind]}-${r.d.number}` : null,
        partnerName: r.partnerName, warehouseName: r.warehouseName, lineCount: r.lines,
      })),
      page, pageSize, total,
    };
  }

  // ----- stanje i kartica

  async balances(u: AuthUser, q: BalanceQuery) {
    const whs = await this.db.select().from(warehouses).where(eq(warehouses.locationId, u.locationId));
    const whIds = q.warehouseId ? [q.warehouseId] : whs.map((w) => w.id);
    if (q.warehouseId && !whs.some((w) => w.id === q.warehouseId)) throw NotFound('Skladište');
    const conds: SQL[] = [eq(products.organizationId, u.organizationId), eq(products.trackStock, true)];
    if (q.search) {
      const t = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`;
      conds.push(or(ilike(products.name, t), ilike(products.code, t))!);
    }
    const prods = await this.db.select({ id: products.id, code: products.code, name: products.name, unit: products.unit, active: products.active })
      .from(products).where(and(...conds)).orderBy(asc(products.name));
    const bal = whIds.length && prods.length ? await this.db.select().from(stockBalances)
      .where(and(inArray(stockBalances.warehouseId, whIds), inArray(stockBalances.productId, prods.map((p) => p.id)))) : [];
    const rows = [];
    let totalValue = dec(0);
    for (const w of whs.filter((x) => whIds.includes(x.id))) {
      for (const p of prods) {
        const b = bal.find((x) => x.warehouseId === w.id && x.productId === p.id);
        const qn = dec(b?.quantity ?? 0);
        if (q.nonZero && qn.isZero()) continue;
        const value = qn.mul(dec(b?.avgCost ?? 0));
        totalValue = totalValue.add(value);
        rows.push({
          warehouseId: w.id, warehouseName: w.name, productId: p.id, code: p.code, name: p.name, unit: p.unit,
          quantity: q4(qn), avgCost: q4(dec(b?.avgCost ?? 0)), value: money(value), negative: qn.lt(0),
        });
      }
    }
    return { data: rows, totalValue: money(totalValue) };
  }

  /** Kartica artikla: početno stanje (pre "from"), kretanja sa stanjem posle svakog, završno stanje. */
  async card(u: AuthUser, q: CardQuery) {
    const [w] = await this.db.select().from(warehouses).where(and(eq(warehouses.id, q.warehouseId), eq(warehouses.locationId, u.locationId)));
    if (!w) throw NotFound('Skladište');
    const [p] = await this.db.select({ id: products.id, code: products.code, name: products.name, unit: products.unit })
      .from(products).where(and(eq(products.id, q.productId), eq(products.organizationId, u.organizationId)));
    if (!p) throw NotFound('Artikal');
    const [loc] = await this.db.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, u.locationId));
    const tz = loc.tz;
    const conds: SQL[] = [eq(stockMovements.warehouseId, q.warehouseId), eq(stockMovements.productId, q.productId)];
    if (q.from) conds.push(sql`${stockMovements.createdAt} >= (${q.from}::date)::timestamp AT TIME ZONE ${tz}`);
    if (q.to) conds.push(sql`${stockMovements.createdAt} < ((${q.to}::date + 1)::timestamp AT TIME ZONE ${tz})`);
    let opening = { quantity: '0.0000', avgCost: '0.0000' };
    if (q.from) {
      const [prev] = await this.db.select({ b: stockMovements.balanceAfter, a: stockMovements.avgCostAfter }).from(stockMovements)
        .where(and(eq(stockMovements.warehouseId, q.warehouseId), eq(stockMovements.productId, q.productId),
          sql`${stockMovements.createdAt} < (${q.from}::date)::timestamp AT TIME ZONE ${tz}`))
        .orderBy(desc(stockMovements.seq)).limit(1);
      if (prev) opening = { quantity: prev.b, avgCost: prev.a };
    }
    const rows = await this.db.select({
      m: stockMovements, docKind: stockDocuments.kind, docNumber: stockDocuments.number, docId: stockDocuments.id,
      orderNumber: orders.number, partnerName: partners.name, user: users.fullName,
    }).from(stockMovements)
      .leftJoin(stockDocuments, eq(stockDocuments.id, stockMovements.documentId))
      .leftJoin(partners, eq(partners.id, stockDocuments.partnerId))
      .leftJoin(orders, eq(orders.id, stockMovements.orderId))
      .leftJoin(users, eq(users.id, stockMovements.createdById))
      .where(and(...conds)).orderBy(asc(stockMovements.seq)).limit(5000);
    let inQ = dec(0); let outQ = dec(0);
    const movements = rows.map((r) => {
      const qn = dec(r.m.quantity);
      if (qn.gt(0)) inQ = inQ.add(qn); else outQ = outQ.add(qn.neg());
      const doc = r.docKind ? `${DOC_PREFIX[r.docKind as DocKind]}-${r.docNumber ?? '?'}` : null;
      return {
        id: r.m.id, at: r.m.createdAt, source: r.m.source,
        description: r.m.source === 'SALE' ? `Prodaja — račun #${r.orderNumber}${r.m.recipeId ? ' (normativ)' : ''}`
          : r.m.source === 'REVERSAL' ? `Storno ${doc ?? ''}`.trim()
            : `${DOC_LABEL[r.docKind as DocKind] ?? 'Dokument'} ${doc ?? ''}${r.partnerName ? ` · ${r.partnerName}` : ''}`,
        documentId: r.docId, orderId: r.m.orderId,
        in: qn.gt(0) ? q4(qn) : null, out: qn.lt(0) ? q4(qn.neg()) : null,
        unitCost: r.m.unitCost, value: r.m.value, balanceAfter: r.m.balanceAfter, avgCostAfter: r.m.avgCostAfter, user: r.user,
      };
    });
    const last = rows.length ? rows[rows.length - 1].m : null;
    return {
      product: p, warehouse: { id: w.id, name: w.name }, from: q.from ?? null, to: q.to ?? null,
      opening, movements,
      totals: { in: q4(inQ), out: q4(outQ) },
      closing: last ? { quantity: last.balanceAfter, avgCost: last.avgCostAfter } : opening,
    };
  }
}

// ---------------------------------------------------------------- kontroler

@ApiTags('stock') @ApiBearerAuth()
@Controller()
export class StockController {
  constructor(private readonly svc: StockService) {}

  @Get('partners') @RequirePermissions(P.STOCK_READ)
  partners(@CurrentUser() u: AuthUser, @Query() q: PartnerQuery) { return this.svc.listPartners(u, q); }
  @Post('partners') @RequirePermissions(P.STOCK_WRITE)
  createPartner(@CurrentUser() u: AuthUser, @Body() dto: PartnerDto) { return this.svc.createPartner(u, dto); }
  @Patch('partners/:id') @RequirePermissions(P.STOCK_WRITE)
  updatePartner(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePartnerDto) { return this.svc.updatePartner(u, id, dto); }

  @Get('warehouses') @RequirePermissions(P.STOCK_READ)
  warehouses(@CurrentUser() u: AuthUser) { return this.svc.listWarehouses(u); }
  @Post('warehouses') @RequirePermissions(P.STOCK_WRITE)
  createWarehouse(@CurrentUser() u: AuthUser, @Body() dto: WarehouseDto) { return this.svc.createWarehouse(u, dto); }
  @Patch('warehouses/:id') @RequirePermissions(P.STOCK_WRITE)
  updateWarehouse(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWarehouseDto) { return this.svc.updateWarehouse(u, id, dto); }
  @Put('prep-stations/:id/warehouse') @RequirePermissions(P.STOCK_WRITE)
  stationWarehouse(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StationWarehouseDto) { return this.svc.setStationWarehouse(u, id, dto); }

  @Get('stock/documents') @RequirePermissions(P.STOCK_READ)
  docs(@CurrentUser() u: AuthUser, @Query() q: DocQuery) { return this.svc.listDocs(u, q); }
  @Post('stock/documents') @RequirePermissions(P.STOCK_WRITE)
  createDoc(@CurrentUser() u: AuthUser, @Body() dto: CreateDocDto) { return this.svc.createDoc(u, dto); }
  @Get('stock/documents/:id') @RequirePermissions(P.STOCK_READ)
  doc(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getDoc(u, id); }
  @Patch('stock/documents/:id') @RequirePermissions(P.STOCK_WRITE)
  updateDoc(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDocDto) { return this.svc.updateDoc(u, id, dto); }
  @Put('stock/documents/:id/lines') @RequirePermissions(P.STOCK_WRITE)
  lines(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetLinesDto) { return this.svc.setLines(u, id, dto); }
  @Post('stock/documents/:id/fill-stocktake') @HttpCode(200) @RequirePermissions(P.STOCK_WRITE)
  fill(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.fillStocktake(u, id); }
  @Post('stock/documents/:id/post') @HttpCode(200) @RequirePermissions(P.STOCK_POST)
  post(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PostDocDto) { return this.svc.postDoc(u, id, dto); }
  @Post('stock/documents/:id/cancel') @HttpCode(200) @RequirePermissions(P.STOCK_POST)
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDocDto) { return this.svc.cancelDoc(u, id, dto); }

  @Get('stock/balances') @RequirePermissions(P.STOCK_READ)
  balances(@CurrentUser() u: AuthUser, @Query() q: BalanceQuery) { return this.svc.balances(u, q); }
  @Get('stock/card') @RequirePermissions(P.STOCK_READ)
  card(@CurrentUser() u: AuthUser, @Query() q: CardQuery) { return this.svc.card(u, q); }
}

@Module({ controllers: [StockController], providers: [StockService], exports: [StockService] })
export class StockModule {}
