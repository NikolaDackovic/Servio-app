import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, Injectable, Module, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { Response } from 'express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DB, Db, Tx } from '../../db/db.module';
import { categories, partners, productPriceChanges, products, stockDocumentLines, stockDocuments, taxRates } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { isValidPib } from '../../common/buyer';
import { dec, money } from '../../common/money';
import { ColumnDef, mapColumns, normHeader, parseBool, parseNumber, readTable, toCsv, toXlsx } from './tabular';
import { q4 } from './engine';
import { StockService } from './stock';

const ENTITIES = ['products', 'partners', 'document-lines'] as const;
type Entity = (typeof ENTITIES)[number];

class ImportDto {
  @IsString() @Length(1, 200) fileName: string;
  /** sadržaj fajla, base64 */
  @IsString() @Length(1, 7_500_000) content: string;
  /** samo za document-lines */
  @IsOptional() @IsUUID() documentId?: string;
  /** commit: preskoči neispravne redove (inače se uvoz sa greškama odbija u celosti) */
  @IsOptional() @IsBoolean() skipInvalid?: boolean;
}
class ExportQuery {
  @IsOptional() @IsIn(['csv', 'xlsx']) format?: 'csv' | 'xlsx';
  @IsOptional() @IsUUID() warehouseId?: string;
}

const COLS: Record<Entity, ColumnDef[]> = {
  products: [
    { key: 'code', label: 'Šifra', aliases: ['sifra', 'code', 'sif'], required: true },
    { key: 'name', label: 'Naziv', aliases: ['name', 'artikal'], required: true },
    { key: 'category', label: 'Kategorija', aliases: ['category', 'grupa'], required: true },
    { key: 'tax', label: 'PDV oznaka', aliases: ['pdv', 'tax', 'poreskaoznaka', 'oznaka'], required: true },
    { key: 'price', label: 'Cena', aliases: ['price', 'prodajnacena', 'mpcena'], required: true },
    { key: 'unit', label: 'Jedinica mere', aliases: ['jm', 'unit', 'jedinica'], required: false },
    { key: 'barcode', label: 'Barkod', aliases: ['barcode', 'ean'], required: false },
    { key: 'trackStock', label: 'Lager', aliases: ['vodizalihu', 'zaliha', 'trackstock'], required: false },
    { key: 'isSellable', label: 'Prodaja', aliases: ['prodaje', 'nakasi', 'sellable'], required: false },
  ],
  partners: [
    { key: 'name', label: 'Naziv', aliases: ['name', 'partner'], required: true },
    { key: 'taxId', label: 'PIB', aliases: ['pib', 'taxid'], required: false },
    { key: 'registrationNo', label: 'Matični broj', aliases: ['mb', 'maticnibroj'], required: false },
    { key: 'address', label: 'Adresa', aliases: ['address'], required: false },
    { key: 'city', label: 'Mesto', aliases: ['grad', 'city'], required: false },
    { key: 'email', label: 'Email', aliases: ['email', 'mail'], required: false },
    { key: 'phone', label: 'Telefon', aliases: ['tel', 'phone'], required: false },
    { key: 'kind', label: 'Vrsta', aliases: ['tip', 'kind'], required: false },
  ],
  'document-lines': [
    { key: 'code', label: 'Šifra', aliases: ['sifra', 'code'], required: true },
    { key: 'quantity', label: 'Količina', aliases: ['kolicina', 'kol', 'quantity'], required: true },
    { key: 'unitCost', label: 'Nabavna cena', aliases: ['cena', 'nabavnacena', 'unitcost'], required: false },
    { key: 'note', label: 'Napomena', aliases: ['note'], required: false },
  ],
};

export interface RowResult { row: number; values: Record<string, string>; action: 'create' | 'update' | null; errors: string[]; data?: any }

/**
 * Uvoz: (1) pregled — svaki red se proverava i prikazuje šta će se desiti (novi / izmena) i greške;
 * (2) potvrda — isti fajl se ponovo proverava u transakciji; ako ima grešaka uvoz se odbija u celosti,
 * osim ako korisnik izričito izabere "preskoči neispravne" — tada izveštaj navodi tačno koji redovi su preskočeni.
 * Ništa se ne preskače "tiho".
 */
@Injectable()
export class ImportExportService {
  constructor(@Inject(DB) private readonly db: Db, private readonly stock: StockService) {}

  private async analyze(tx: Tx | Db, u: AuthUser, entity: Entity, dto: ImportDto) {
    if (!ENTITIES.includes(entity)) throw NotFound('Vrsta uvoza');
    const { table, format } = await readTable(dto.fileName, dto.content);
    if (!table.rows.length) throw Invalid('NO_ROWS', 'Fajl nema redova sa podacima (prvi red mora biti zaglavlje)');
    if (table.rows.length > 5000) throw Invalid('TOO_MANY_ROWS', 'Najviše 5000 redova po uvozu');
    const defs = COLS[entity];
    const { idx, missing, unknown } = mapColumns(table.headers, defs);
    if (missing.length) throw Invalid('MISSING_COLUMNS', `Nedostaju kolone: ${missing.join(', ')}`, { missing, expected: defs.map((d) => d.label) });
    const results: RowResult[] = table.rows.map((r) => ({
      row: r.rowNumber, action: null, errors: [],
      values: Object.fromEntries(defs.filter((d) => idx[d.key] !== undefined).map((d) => [d.key, r.cells[idx[d.key]] ?? ''])),
    }));
    if (entity === 'products') await this.checkProducts(tx, u, results);
    else if (entity === 'partners') await this.checkPartners(tx, u, results);
    else await this.checkLines(tx, u, results, dto.documentId);
    const invalid = results.filter((r) => r.errors.length).length;
    return {
      entity, format, columns: defs.map((d) => ({ key: d.key, label: d.label, present: idx[d.key] !== undefined, required: d.required })),
      ignoredColumns: unknown, total: results.length, valid: results.length - invalid, invalid,
      creates: results.filter((r) => !r.errors.length && r.action === 'create').length,
      updates: results.filter((r) => !r.errors.length && r.action === 'update').length,
      rows: results,
    };
  }

  private dupCheck(results: RowResult[], key: string, label: string, norm = (s: string) => s.trim().toLowerCase()) {
    const seen = new Map<string, number>();
    for (const r of results) {
      const v = r.values[key];
      if (!v) continue;
      const k = norm(v);
      if (seen.has(k)) r.errors.push(`${label} „${v}“ se ponavlja u fajlu (prvi put u redu ${seen.get(k)})`);
      else seen.set(k, r.row);
    }
  }

  private async checkProducts(tx: Tx | Db, u: AuthUser, results: RowResult[]) {
    const cats = await tx.select().from(categories).where(eq(categories.organizationId, u.organizationId));
    const taxes = await tx.select().from(taxRates).where(and(eq(taxRates.organizationId, u.organizationId), eq(taxRates.active, true)));
    const codes = results.map((r) => r.values.code?.trim()).filter(Boolean);
    const existing = codes.length ? await tx.select({ id: products.id, code: products.code, price: products.price }).from(products)
      .where(and(eq(products.organizationId, u.organizationId), inArray(products.code, codes))) : [];
    this.dupCheck(results, 'code', 'Šifra', (s) => s.trim());
    for (const r of results) {
      const v = r.values;
      const code = v.code?.trim();
      if (!code) r.errors.push('Šifra je obavezna');
      else if (code.length > 32) r.errors.push('Šifra je duža od 32 znaka');
      if (!v.name?.trim()) r.errors.push('Naziv je obavezan');
      const cat = cats.find((c) => normHeader(c.name) === normHeader(v.category ?? ''));
      if (!cat) r.errors.push(`Kategorija „${v.category ?? ''}“ ne postoji (napravite je u ADMIN-u pre uvoza)`);
      const tax = taxes.find((t) => t.label.toLowerCase() === (v.tax ?? '').trim().toLowerCase());
      if (!tax) r.errors.push(`PDV oznaka „${v.tax ?? ''}“ ne postoji (dozvoljeno: ${taxes.map((t) => t.label).join(', ')})`);
      const price = parseNumber(v.price ?? '');
      if (price === null || dec(price).lt(0) || !/^\d+(\.\d{1,2})?$/.test(price)) r.errors.push(`Cena „${v.price ?? ''}“ nije ispravna (najviše 2 decimale, ≥ 0)`);
      const track = v.trackStock !== undefined ? parseBool(v.trackStock) : false;
      const sell = v.isSellable !== undefined && v.isSellable !== '' ? parseBool(v.isSellable) : true;
      if (track === null) r.errors.push('Lager: očekuje se da/ne');
      if (sell === null) r.errors.push('Prodaja: očekuje se da/ne');
      if (v.unit && v.unit.length > 12) r.errors.push('Jedinica mere je duža od 12 znakova');
      const ex = existing.find((e) => e.code === code);
      r.action = ex ? 'update' : 'create';
      r.data = {
        id: ex?.id, oldPrice: ex?.price, code, name: v.name?.trim(), categoryId: cat?.id, taxRateId: tax?.id, price: price ? money(price) : null,
        unit: v.unit?.trim() || 'kom', barcode: v.barcode?.trim() || null, trackStock: !!track, isSellable: sell !== false,
      };
    }
  }

  private async checkPartners(tx: Tx | Db, u: AuthUser, results: RowResult[]) {
    const pibs = results.map((r) => r.values.taxId?.trim()).filter(Boolean);
    const existing = pibs.length ? await tx.select({ id: partners.id, taxId: partners.taxId }).from(partners)
      .where(and(eq(partners.organizationId, u.organizationId), inArray(partners.taxId, pibs))) : [];
    this.dupCheck(results, 'taxId', 'PIB', (s) => s.trim());
    const kinds: Record<string, 'SUPPLIER' | 'CUSTOMER' | 'BOTH'> = { dobavljac: 'SUPPLIER', supplier: 'SUPPLIER', kupac: 'CUSTOMER', customer: 'CUSTOMER', oba: 'BOTH', both: 'BOTH', '': 'SUPPLIER' };
    for (const r of results) {
      const v = r.values;
      if (!v.name?.trim()) r.errors.push('Naziv je obavezan');
      const pib = v.taxId?.trim() || null;
      if (pib && (!/^\d{9}$/.test(pib) || !isValidPib(pib))) r.errors.push(`PIB „${pib}“ nije ispravan`);
      const mb = v.registrationNo?.trim() || null;
      if (mb && !/^\d{8}$/.test(mb)) r.errors.push(`Matični broj „${mb}“ mora imati 8 cifara`);
      const email = v.email?.trim() || null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) r.errors.push(`Email „${email}“ nije ispravan`);
      const kind = kinds[normHeader(v.kind ?? '')];
      if (!kind) r.errors.push(`Vrsta „${v.kind}“: dozvoljeno dobavljač, kupac, oba`);
      const ex = pib ? existing.find((e) => e.taxId === pib) : undefined;
      r.action = ex ? 'update' : 'create';
      r.data = { id: ex?.id, name: v.name?.trim(), taxId: pib, registrationNo: mb, address: v.address?.trim() || null, city: v.city?.trim() || null, email, phone: v.phone?.trim() || null, kind: kind ?? 'SUPPLIER' };
    }
  }

  private async checkLines(tx: Tx | Db, u: AuthUser, results: RowResult[], documentId?: string) {
    if (!documentId) throw Invalid('DOCUMENT_REQUIRED', 'Za uvoz stavki izaberite dokument (nacrt)');
    const [d] = await tx.select().from(stockDocuments).where(and(eq(stockDocuments.id, documentId), eq(stockDocuments.locationId, u.locationId)));
    if (!d) throw NotFound('Dokument');
    if (d.status !== 'DRAFT') throw Conflict('DOC_NOT_DRAFT', 'Stavke se uvoze samo u nacrt dokumenta');
    const codes = results.map((r) => r.values.code?.trim()).filter(Boolean);
    const prods = codes.length ? await tx.select({ id: products.id, code: products.code, name: products.name, trackStock: products.trackStock })
      .from(products).where(and(eq(products.organizationId, u.organizationId), inArray(products.code, codes))) : [];
    this.dupCheck(results, 'code', 'Šifra', (s) => s.trim());
    for (const r of results) {
      const v = r.values;
      const p = prods.find((x) => x.code === v.code?.trim());
      if (!p) r.errors.push(`Artikal sa šifrom „${v.code ?? ''}“ ne postoji`);
      else if (!p.trackStock) r.errors.push(`„${p.name}“ nema uključeno vođenje zalihe`);
      const q = parseNumber(v.quantity ?? '');
      if (q === null || !/^\d+(\.\d{1,4})?$/.test(q)) r.errors.push(`Količina „${v.quantity ?? ''}“ nije ispravna (najviše 4 decimale)`);
      else if (d.kind !== 'STOCKTAKE' && dec(q).lte(0)) r.errors.push('Količina mora biti veća od 0');
      const c = v.unitCost ? parseNumber(v.unitCost) : null;
      if (v.unitCost && (c === null || !/^\d+(\.\d{1,4})?$/.test(c))) r.errors.push(`Nabavna cena „${v.unitCost}“ nije ispravna`);
      if (d.kind === 'RECEIPT' && !v.unitCost) r.errors.push('Nabavna cena je obavezna na prijemnici');
      r.action = 'create';
      r.data = { productId: p?.id, quantity: q, unitCost: c, note: v.note?.trim() || null };
    }
  }

  async preview(u: AuthUser, entity: Entity, dto: ImportDto) {
    return this.analyze(this.db, u, entity, dto);
  }

  async commit(u: AuthUser, entity: Entity, dto: ImportDto) {
    const r = await this.db.transaction(async (tx) => {
      const a = await this.analyze(tx, u, entity, dto);
      if (a.invalid && !dto.skipInvalid) {
        throw Invalid('IMPORT_HAS_ERRORS', `Uvoz nije izvršen: ${a.invalid} od ${a.total} redova ima greške. Ispravite fajl ili izaberite „preskoči neispravne redove“.`,
          { invalid: a.rows.filter((x) => x.errors.length).map((x) => ({ row: x.row, errors: x.errors })) });
      }
      const ok = a.rows.filter((x) => !x.errors.length);
      if (!ok.length) throw Invalid('NOTHING_TO_IMPORT', 'Nema ispravnih redova za uvoz');
      let created = 0; let updated = 0;
      if (entity === 'products') {
        for (const x of ok) {
          const d = x.data;
          if (d.id) {
            await tx.update(products).set({ name: d.name, categoryId: d.categoryId, taxRateId: d.taxRateId, price: d.price, unit: d.unit, barcode: d.barcode, trackStock: d.trackStock, isSellable: d.isSellable, updatedAt: new Date() }).where(eq(products.id, d.id));
            if (d.oldPrice !== d.price) await tx.insert(productPriceChanges).values({ productId: d.id, oldPrice: d.oldPrice, newPrice: d.price, userId: u.userId });
            updated++;
          } else {
            const [p] = await tx.insert(products).values({ organizationId: u.organizationId, code: d.code, name: d.name, categoryId: d.categoryId, taxRateId: d.taxRateId, price: d.price, unit: d.unit, barcode: d.barcode, trackStock: d.trackStock, isSellable: d.isSellable }).returning();
            await tx.insert(productPriceChanges).values({ productId: p.id, oldPrice: null, newPrice: p.price, userId: u.userId });
            created++;
          }
        }
      } else if (entity === 'partners') {
        for (const x of ok) {
          const { id, ...d } = x.data;
          if (id) { await tx.update(partners).set({ ...d, updatedAt: new Date() }).where(eq(partners.id, id)); updated++; }
          else { await tx.insert(partners).values({ organizationId: u.organizationId, ...d }); created++; }
        }
      } else {
        const doc = await tx.select().from(stockDocuments).where(eq(stockDocuments.id, dto.documentId!)).for('update');
        await tx.delete(stockDocumentLines).where(eq(stockDocumentLines.documentId, dto.documentId!));
        await tx.insert(stockDocumentLines).values(ok.map((x, i) => ({
          documentId: dto.documentId!, productId: x.data.productId, quantity: q4(dec(x.data.quantity)),
          unitCost: x.data.unitCost ? q4(dec(x.data.unitCost)) : null, note: x.data.note, sortOrder: i,
        })));
        await tx.update(stockDocuments).set({ version: doc[0].version + 1, updatedAt: new Date() }).where(eq(stockDocuments.id, dto.documentId!));
        created = ok.length;
      }
      const skipped = a.rows.filter((x) => x.errors.length).map((x) => ({ row: x.row, errors: x.errors }));
      await audit(tx, u, `import.${entity}`, entity === 'document-lines' ? 'stock_document' : entity, dto.documentId ?? u.organizationId,
        { fileName: dto.fileName, total: a.total, created, updated, skipped: skipped.length });
      return { entity, total: a.total, created, updated, skipped };
    });
    return r;
  }

  // ----- izvoz

  async exportData(u: AuthUser, entity: string, q: ExportQuery) {
    let headers: string[]; let rows: (string | number | null)[][]; let name: string;
    if (entity === 'products') {
      const list = await this.db.select({ p: products, cat: categories.name, tax: taxRates.label }).from(products)
        .innerJoin(categories, eq(categories.id, products.categoryId)).innerJoin(taxRates, eq(taxRates.id, products.taxRateId))
        .where(eq(products.organizationId, u.organizationId)).orderBy(asc(products.code));
      headers = COLS.products.map((c) => c.label);
      rows = list.map(({ p, cat, tax }) => [p.code, p.name, cat, tax, Number(p.price), p.unit, p.barcode, p.trackStock ? 'da' : 'ne', p.isSellable ? 'da' : 'ne']);
      name = 'artikli';
    } else if (entity === 'partners') {
      const list = await this.db.select().from(partners).where(eq(partners.organizationId, u.organizationId)).orderBy(asc(partners.name));
      const K = { SUPPLIER: 'dobavljač', CUSTOMER: 'kupac', BOTH: 'oba' } as const;
      headers = COLS.partners.map((c) => c.label);
      rows = list.map((p) => [p.name, p.taxId, p.registrationNo, p.address, p.city, p.email, p.phone, K[p.kind]]);
      name = 'partneri';
    } else if (entity === 'stock-balances') {
      const b = await this.stock.balances(u, { warehouseId: q.warehouseId });
      headers = ['Skladište', 'Šifra', 'Naziv', 'Jedinica mere', 'Količina', 'Prosečna nabavna cena', 'Vrednost'];
      rows = b.data.map((r) => [r.warehouseName, r.code, r.name, r.unit, Number(r.quantity), Number(r.avgCost), Number(r.value)]);
      name = 'stanje-lagera';
    } else throw NotFound('Vrsta izvoza');
    const fmt = q.format ?? 'xlsx';
    const body = fmt === 'csv' ? toCsv(headers, rows) : await toXlsx(name, headers, rows);
    return {
      body, fileName: `${name}-${new Date().toISOString().slice(0, 10)}.${fmt}`,
      contentType: fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  /** Šablon za uvoz (samo zaglavlje + jedan primer reda). */
  async template(entity: Entity, format: 'csv' | 'xlsx') {
    const defs = COLS[entity];
    if (!defs) throw NotFound('Vrsta uvoza');
    const example: Record<Entity, (string | number | null)[]> = {
      products: ['S010', 'Limunada 0,3', 'Bezalkoholna pića', 'Đ', 280, 'kom', '', 'ne', 'da'],
      partners: ['Primer d.o.o.', '100000024', '12345678', 'Ulica 1', 'Beograd', 'nabavka@primer.rs', '011 123 456', 'dobavljač'],
      'document-lines': ['S001', 24, 95.5, ''],
    };
    const headers = defs.map((d) => d.label);
    const body = format === 'csv' ? toCsv(headers, [example[entity]]) : await toXlsx('uvoz', headers, [example[entity]]);
    return { body, fileName: `sablon-${entity}.${format}`, contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
}

const send = (res: Response, f: { body: Buffer; fileName: string; contentType: string }) => {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
  res.send(f.body);
};

@ApiTags('import-export') @ApiBearerAuth()
@Controller()
export class ImportExportController {
  constructor(private readonly svc: ImportExportService) {}

  @Post('import/:entity/preview') @HttpCode(200) @RequirePermissions(P.STOCK_WRITE)
  preview(@CurrentUser() u: AuthUser, @Param('entity') e: string, @Body() dto: ImportDto) { return this.svc.preview(u, e as Entity, dto); }

  @Post('import/:entity/commit') @HttpCode(200) @RequirePermissions(P.STOCK_WRITE)
  commit(@CurrentUser() u: AuthUser, @Param('entity') e: string, @Body() dto: ImportDto) {
    if (e === 'products' && !u.permissions.includes(P.CATALOG_WRITE)) throw new ForbiddenException('Uvoz artikala zahteva pravo catalog.write');
    return this.svc.commit(u, e as Entity, dto);
  }

  @Get('import/:entity/template') @RequirePermissions(P.STOCK_WRITE)
  async template(@Param('entity') e: string, @Query() q: ExportQuery, @Res() res: Response) { send(res, await this.svc.template(e as Entity, q.format ?? 'xlsx')); }

  @Get('export/:entity') @RequirePermissions(P.STOCK_READ)
  async export(@CurrentUser() u: AuthUser, @Param('entity') e: string, @Query() q: ExportQuery, @Res() res: Response) {
    send(res, await this.svc.exportData(u, e, q));
  }
}

@Module({ controllers: [ImportExportController], providers: [ImportExportService, StockService] })
export class ImportExportModule {}
