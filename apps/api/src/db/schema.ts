/**
 * POS platforma — šema baze (iteracija 1).
 *
 * Pravila integriteta:
 *  - Novčani iznosi: numeric(14,2). Količine: numeric(12,3). Poreske stope: numeric(5,2).
 *    Drajver ih vraća kao string; sva aritmetika ide kroz src/common/money.ts (decimal.js).
 *  - Cene su BRUTO (sa PDV-om). PDV se izdvaja iz bruto iznosa po stavci.
 *  - Sva vremena su timestamptz (UTC u bazi), prikaz u zoni lokala.
 *  - Identifikatori su UUID (stabilni, pogodni za buduću hibridnu sinhronizaciju).
 *  - Ključna poslovna pravila su i CHECK ograničenja, ne samo validacija u kodu.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, boolean, integer, numeric, timestamp, jsonb, pgEnum, date, bigserial,
  uniqueIndex, index, primaryKey, check,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const qty = (name: string) => numeric(name, { precision: 12, scale: 3 });

export const deviceKind = pgEnum('device_kind', ['POS', 'MOBILE', 'KDS', 'BRIDGE']);
export const stationKind = pgEnum('station_kind', ['BAR', 'KITCHEN', 'OTHER']);
export const printerConnection = pgEnum('printer_connection', ['SIMULATED', 'NETWORK_ESCPOS', 'WINDOWS_RAW']);
export const kdsTicketStatus = pgEnum('kds_ticket_status', ['NEW', 'IN_PROGRESS', 'READY', 'DONE']);
export const printJobKind = pgEnum('print_job_kind', ['ORDER_TICKET', 'VOID_TICKET', 'RECEIPT', 'TEST_PAGE']);
export const printJobStatus = pgEnum('print_job_status', ['PENDING', 'PRINTING', 'PRINTED', 'SIMULATED', 'FAILED']);
export const fiscalStatus = pgEnum('fiscal_status', ['PENDING', 'SIGNED', 'FAILED', 'NOT_REQUIRED']);
export const orderStatus = pgEnum('order_status', ['OPEN', 'PAID', 'CANCELLED', 'MERGED']);
export const orderItemStatus = pgEnum('order_item_status', ['NEW', 'SENT', 'VOIDED']);
export const paymentMethod = pgEnum('payment_method', ['CASH', 'CARD', 'TRANSFER', 'REPRESENTATION']);
export const paymentMode = pgEnum('payment_mode', ['TEST', 'LIVE']);
export const shiftStatus = pgEnum('shift_status', ['OPEN', 'CLOSED']);
export const cashMovementType = pgEnum('cash_movement_type', ['PAY_IN', 'PAY_OUT']);
export const businessDayStatus = pgEnum('business_day_status', ['OPEN', 'CLOSED']);
export const staffShiftStatus = pgEnum('staff_shift_status', ['OPEN', 'CLOSED']);

// ---------- Organizacija i lokali ----------

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  taxId: varchar('tax_id', { length: 20 }),
  currency: varchar('currency', { length: 3 }).notNull().default('RSD'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const locations = pgTable('locations', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  address: text('address'),
  timezone: text('timezone').notNull().default('Europe/Belgrade'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [index('locations_org_idx').on(t.organizationId)]);

export const devices = pgTable('devices', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  name: text('name').notNull(),
  kind: deviceKind('kind').notNull().default('POS'),
  active: boolean('active').notNull().default(true),
  /** Za Print Bridge: heš API ključa (ključ se prikazuje samo jednom pri izdavanju). */
  apiKeyHash: text('api_key_hash'),
  apiKeyPrefix: varchar('api_key_prefix', { length: 12 }),
  lastSeenAt: ts('last_seen_at'),
  /** Štampač za račune ove kase. */
  receiptPrinterId: uuid('receipt_printer_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('devices_location_name_uq').on(t.locationId, t.name)]);

// ---------- Korisnici i prava ----------

export const roles = pgTable('roles', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 32 }).notNull(),
  name: text('name').notNull(),
  permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('roles_org_code_uq').on(t.organizationId, t.code)]);

export const users = pgTable('users', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  roleId: uuid('role_id').notNull().references(() => roles.id),
  fullName: text('full_name').notNull(),
  email: text('email'),
  passwordHash: text('password_hash'),
  pinHash: text('pin_hash'),
  /** HMAC(pin, PIN_PEPPER) — omogućava pronalaženje korisnika po PIN-u i jedinstvenost bez čuvanja PIN-a. */
  pinLookup: text('pin_lookup'),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('users_org_email_uq').on(t.organizationId, t.email),
  uniqueIndex('users_org_pin_uq').on(t.organizationId, t.pinLookup),
]);

// ---------- Katalog ----------

export const taxRates = pgTable('tax_rates', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  label: varchar('label', { length: 4 }).notNull(),
  name: text('name').notNull(),
  rate: numeric('rate', { precision: 5, scale: 2 }).notNull(),
  active: boolean('active').notNull().default(true),
}, (t) => [
  uniqueIndex('tax_rates_org_label_uq').on(t.organizationId, t.label),
  check('tax_rates_rate_range', sql`${t.rate} >= 0 AND ${t.rate} < 100`),
]);

export const categories = pgTable('categories', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  color: varchar('color', { length: 16 }),
  sortOrder: integer('sort_order').notNull().default(0),
  /** Podrazumevana pripremna pozicija za artikle kategorije (šank, kuhinja…). */
  prepStationId: uuid('prep_station_id'),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('categories_org_name_uq').on(t.organizationId, t.name)]);

export const products = pgTable('products', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  categoryId: uuid('category_id').notNull().references(() => categories.id),
  taxRateId: uuid('tax_rate_id').notNull().references(() => taxRates.id),
  code: varchar('code', { length: 32 }).notNull(),
  barcode: varchar('barcode', { length: 32 }),
  name: text('name').notNull(),
  unit: varchar('unit', { length: 12 }).notNull().default('kom'),
  price: money('price').notNull(),
  color: varchar('color', { length: 16 }),
  /** Pripremna pozicija artikla — ima prednost nad pozicijom kategorije. */
  prepStationId: uuid('prep_station_id'),
  /** Vodi se zaliha (lager) za ovaj artikal: prodaja ga troši (ako nema normativ), dokumenti ga menjaju. */
  trackStock: boolean('track_stock').notNull().default(false),
  /** Prodaje se na kasi. Sirovine (npr. kafa u zrnu) imaju false i ne prikazuju se na kasi. */
  isSellable: boolean('is_sellable').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('products_org_code_uq').on(t.organizationId, t.code),
  index('products_org_category_idx').on(t.organizationId, t.categoryId),
  check('products_price_nonneg', sql`${t.price} >= 0`),
]);

export const productPriceChanges = pgTable('product_price_changes', {
  id: id(),
  productId: uuid('product_id').notNull().references(() => products.id),
  oldPrice: money('old_price'),
  newPrice: money('new_price').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id),
  changedAt: ts('changed_at').notNull().defaultNow(),
}, (t) => [index('ppc_product_idx').on(t.productId, t.changedAt)]);

/** Popusti koje definiše ADMIN; na kasi se primenjuju na ceo račun (procenat). */
export const discounts = pgTable('discounts', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  percent: numeric('percent', { precision: 5, scale: 2 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('discounts_org_name_uq').on(t.organizationId, t.name),
  check('discounts_percent_range', sql`${t.percent} > 0 AND ${t.percent} <= 100`),
]);

// ---------- Sala ----------

export const diningTables = pgTable('dining_tables', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  area: text('area').notNull().default('Sala'),
  name: text('name').notNull(),
  seats: integer('seats').notNull().default(4),
  posX: integer('pos_x').notNull().default(0),
  posY: integer('pos_y').notNull().default(0),
  active: boolean('active').notNull().default(true),
}, (t) => [uniqueIndex('tables_location_name_uq').on(t.locationId, t.name)]);

// ---------- Poslovni dan ----------

/**
 * Poslovni (radni) dan lokala. Sav promet pripada danu koji je bio otvoren, i posle ponoći.
 * Najviše jedan otvoren dan po lokalu; zaključak dana čuva snimak obračuna (summary).
 */
export const businessDays = pgTable('business_days', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  date: date('date', { mode: 'string' }).notNull(),
  status: businessDayStatus('status').notNull().default('OPEN'),
  openedById: uuid('opened_by_id').notNull().references(() => users.id),
  closedById: uuid('closed_by_id').references(() => users.id),
  openedAt: ts('opened_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
  summary: jsonb('summary'),
}, (t) => [
  uniqueIndex('business_days_location_date_uq').on(t.locationId, t.date),
  uniqueIndex('business_days_one_open_uq').on(t.locationId).where(sql`${t.status} = 'OPEN'`),
  check('business_days_closed_consistent', sql`${t.status} <> 'CLOSED' OR (${t.closedAt} IS NOT NULL AND ${t.closedById} IS NOT NULL)`),
]);

/**
 * Smena zaposlenog (konobara) u okviru poslovnog dana. Na kraju: specifikacija pazara (summary),
 * a otvoreni računi moraju prethodno biti prebačeni drugom konobaru.
 */
export const staffShifts = pgTable('staff_shifts', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  businessDayId: uuid('business_day_id').notNull().references(() => businessDays.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  status: staffShiftStatus('status').notNull().default('OPEN'),
  startedAt: ts('started_at').notNull().defaultNow(),
  endedAt: ts('ended_at'),
  endedById: uuid('ended_by_id').references(() => users.id),
  summary: jsonb('summary'),
}, (t) => [
  index('staff_shifts_day_idx').on(t.businessDayId),
  uniqueIndex('staff_shifts_one_open_uq').on(t.locationId, t.userId).where(sql`${t.status} = 'OPEN'`),
]);

// ---------- Smena kase (pre porudžbina zbog FK iz plaćanja) ----------

export const cashShifts = pgTable('cash_shifts', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  businessDayId: uuid('business_day_id').references(() => businessDays.id),
  status: shiftStatus('status').notNull().default('OPEN'),
  openedById: uuid('opened_by_id').notNull().references(() => users.id),
  closedById: uuid('closed_by_id').references(() => users.id),
  openingCash: money('opening_cash').notNull(),
  expectedCash: money('expected_cash'),
  countedCash: money('counted_cash'),
  difference: money('difference'),
  openedAt: ts('opened_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
}, (t) => [
  index('shifts_device_status_idx').on(t.deviceId, t.status),
  // Najviše jedna otvorena smena po kasi — garantuje baza, ne samo kod.
  uniqueIndex('shifts_one_open_per_device_uq').on(t.deviceId).where(sql`${t.status} = 'OPEN'`),
  check('shifts_opening_cash_nonneg', sql`${t.openingCash} >= 0`),
]);

export const cashMovements = pgTable('cash_movements', {
  id: id(),
  shiftId: uuid('shift_id').notNull().references(() => cashShifts.id),
  type: cashMovementType('type').notNull(),
  amount: money('amount').notNull(),
  reason: text('reason').notNull(),
  createdById: uuid('created_by_id').notNull().references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [check('cash_movements_amount_pos', sql`${t.amount} > 0`)]);

// ---------- Porudžbine ----------

export const orders = pgTable('orders', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  deviceId: uuid('device_id').references(() => devices.id),
  tableId: uuid('table_id').references(() => diningTables.id),
  businessDayId: uuid('business_day_id').references(() => businessDays.id),
  number: integer('number').notNull(),
  status: orderStatus('status').notNull().default('OPEN'),
  guests: integer('guests'),
  note: text('note'),
  /** Naziv ture/podračuna na istom stolu (npr. "Pera"). */
  tabName: varchar('tab_name', { length: 40 }),
  discountId: uuid('discount_id').references(() => discounts.id),
  discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
  /** Zbir stavki pre popusta. total = subtotal − discountTotal. */
  subtotal: money('subtotal').notNull().default('0'),
  discountTotal: money('discount_total').notNull().default('0'),
  /** Identifikacija kupca (šifra vrste ID-a iz šifarnika eFiskalizacije + broj). */
  buyerIdType: varchar('buyer_id_type', { length: 4 }),
  buyerId: varchar('buyer_id', { length: 40 }),
  /** Opciono polje kupca: osnov (npr. oslobođenje od PDV-a) i broj — mapiranje na šifre pre fiskalizacije. */
  buyerOptionalBasis: varchar('buyer_optional_basis', { length: 60 }),
  buyerOptionalValue: varchar('buyer_optional_value', { length: 60 }),
  mergedIntoId: uuid('merged_into_id'),
  openedById: uuid('opened_by_id').notNull().references(() => users.id),
  waiterId: uuid('waiter_id').notNull().references(() => users.id),
  closedById: uuid('closed_by_id').references(() => users.id),
  /** Zbir aktivnih (ne-storniranih) stavki; preračunava se u istoj transakciji kao i izmena stavki. */
  total: money('total').notNull().default('0'),
  paidTotal: money('paid_total').notNull().default('0'),
  sendCount: integer('send_count').notNull().default(0),
  version: integer('version').notNull().default(0),
  idempotencyKey: varchar('idempotency_key', { length: 80 }),
  openedAt: ts('opened_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('orders_location_number_uq').on(t.locationId, t.number),
  uniqueIndex('orders_location_idem_uq').on(t.locationId, t.idempotencyKey),
  index('orders_location_status_idx').on(t.locationId, t.status),
  index('orders_table_status_idx').on(t.tableId, t.status),
  index('orders_closed_at_idx').on(t.closedAt),
  index('orders_business_day_idx').on(t.businessDayId),
  check('orders_total_nonneg', sql`${t.total} >= 0`),
  check('orders_discount_range', sql`${t.discountPercent} >= 0 AND ${t.discountPercent} <= 100`),
  check('orders_total_is_subtotal_minus_discount', sql`${t.total} = ${t.subtotal} - ${t.discountTotal}`),
  check('orders_buyer_complete', sql`(${t.buyerIdType} IS NULL) = (${t.buyerId} IS NULL)`),
  check('orders_paid_not_over_total', sql`${t.paidTotal} >= 0 AND ${t.paidTotal} <= ${t.total}`),
  check('orders_paid_means_settled', sql`${t.status} <> 'PAID' OR (${t.paidTotal} = ${t.total} AND ${t.closedAt} IS NOT NULL)`),
]);

export const orderItems = pgTable('order_items', {
  id: id(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  productId: uuid('product_id').notNull().references(() => products.id),
  name: text('name').notNull(),
  unitPrice: money('unit_price').notNull(),
  quantity: qty('quantity').notNull(),
  taxLabel: varchar('tax_label', { length: 4 }).notNull(),
  taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull(),
  lineTotal: money('line_total').notNull(),
  /** Deo popusta računa koji otpada na ovu stavku (zbog tačne PDV rekapitulacije po stopama). */
  discountAmount: money('discount_amount').notNull().default('0'),
  note: text('note'),
  status: orderItemStatus('status').notNull().default('NEW'),
  sendBatch: integer('send_batch'),
  /** Snimak rutiranja u trenutku slanja (pozicija i KDS tiket). */
  prepStationId: uuid('prep_station_id'),
  kdsTicketId: uuid('kds_ticket_id'),
  readyAt: ts('ready_at'),
  sentAt: ts('sent_at'),
  voidReason: text('void_reason'),
  voidedById: uuid('voided_by_id').references(() => users.id),
  voidedAt: ts('voided_at'),
  addedById: uuid('added_by_id').notNull().references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  index('order_items_order_idx').on(t.orderId),
  check('order_items_qty_pos', sql`${t.quantity} > 0`),
  check('order_items_price_nonneg', sql`${t.unitPrice} >= 0`),
  check('order_items_discount_range', sql`${t.discountAmount} >= 0 AND ${t.discountAmount} <= ${t.lineTotal}`),
  check('order_items_void_has_reason', sql`${t.status} <> 'VOIDED' OR (${t.voidReason} IS NOT NULL AND ${t.voidedById} IS NOT NULL)`),
]);

export const payments = pgTable('payments', {
  id: id(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  shiftId: uuid('shift_id').notNull().references(() => cashShifts.id),
  businessDayId: uuid('business_day_id').references(() => businessDays.id),
  staffShiftId: uuid('staff_shift_id').references(() => staffShifts.id),
  deviceId: uuid('device_id').references(() => devices.id),
  method: paymentMethod('method').notNull(),
  mode: paymentMode('mode').notNull().default('TEST'),
  amount: money('amount').notNull(),
  tendered: money('tendered'),
  change: money('change').notNull().default('0'),
  idempotencyKey: varchar('idempotency_key', { length: 80 }).notNull(),
  createdById: uuid('created_by_id').notNull().references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('payments_order_idem_uq').on(t.orderId, t.idempotencyKey),
  index('payments_shift_idx').on(t.shiftId),
  index('payments_created_idx').on(t.createdAt),
  index('payments_business_day_idx').on(t.businessDayId),
  check('payments_amount_pos', sql`${t.amount} > 0`),
  check('payments_change_nonneg', sql`${t.change} >= 0`),
]);

// ---------- Numeracija i revizijski trag ----------

export const documentCounters = pgTable('document_counters', {
  locationId: uuid('location_id').notNull().references(() => locations.id),
  kind: varchar('kind', { length: 32 }).notNull(),
  lastValue: integer('last_value').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.locationId, t.kind] })]);

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').references(() => users.id),
  action: varchar('action', { length: 64 }).notNull(),
  entity: varchar('entity', { length: 64 }).notNull(),
  entityId: text('entity_id').notNull(),
  data: jsonb('data'),
  requestId: varchar('request_id', { length: 64 }),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  index('audit_entity_idx').on(t.organizationId, t.entity, t.entityId),
  index('audit_created_idx').on(t.createdAt),
]);

// ---------- Faza 3: pripremne pozicije, štampa, KDS, fiskalizacija ----------

export const printers = pgTable('printers', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  name: text('name').notNull(),
  connection: printerConnection('connection').notNull().default('SIMULATED'),
  /** NETWORK_ESCPOS: IP adresa i port (obično 9100) */
  host: varchar('host', { length: 120 }),
  port: integer('port'),
  /** WINDOWS_RAW: tačan naziv štampača u Windowsu */
  windowsName: text('windows_name'),
  paperWidth: integer('paper_width').notNull().default(80),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('printers_location_name_uq').on(t.locationId, t.name),
  check('printers_paper', sql`${t.paperWidth} IN (58, 80)`),
  check('printers_network_cfg', sql`${t.connection} <> 'NETWORK_ESCPOS' OR (${t.host} IS NOT NULL AND ${t.port} BETWEEN 1 AND 65535)`),
  check('printers_windows_cfg', sql`${t.connection} <> 'WINDOWS_RAW' OR ${t.windowsName} IS NOT NULL`),
]);

export const prepStations = pgTable('prep_stations', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  name: text('name').notNull(),
  kind: stationKind('kind').notNull().default('OTHER'),
  printerId: uuid('printer_id').references(() => printers.id),
  /** Da li se pozicija prikazuje na KDS ekranu */
  kdsEnabled: boolean('kds_enabled').notNull().default(true),
  /** Skladište iz kog se troši roba za artikle ove pozicije (faza 4) */
  warehouseId: uuid('warehouse_id'),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('stations_location_name_uq').on(t.locationId, t.name)]);

/** Jedan tiket = jedna tura slanja jednog računa za jednu pripremnu poziciju. */
export const kdsTickets = pgTable('kds_tickets', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  stationId: uuid('station_id').notNull().references(() => prepStations.id),
  batch: integer('batch').notNull(),
  status: kdsTicketStatus('status').notNull().default('NEW'),
  createdAt: ts('created_at').notNull().defaultNow(),
  startedAt: ts('started_at'),
  readyAt: ts('ready_at'),
  doneAt: ts('done_at'),
}, (t) => [
  uniqueIndex('kds_ticket_order_batch_station_uq').on(t.orderId, t.batch, t.stationId),
  index('kds_station_status_idx').on(t.stationId, t.status),
]);

/** Red za štampu. dedupeKey garantuje da ista tura za istu poziciju nikad ne nastane dvaput. */
export const printJobs = pgTable('print_jobs', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  printerId: uuid('printer_id').notNull().references(() => printers.id),
  stationId: uuid('station_id').references(() => prepStations.id),
  orderId: uuid('order_id').references(() => orders.id),
  kind: printJobKind('kind').notNull(),
  dedupeKey: varchar('dedupe_key', { length: 160 }).notNull(),
  /** Sadržaj za štampu (nezavisan od štampača): naslov, linije, napomene. */
  payload: jsonb('payload').notNull(),
  status: printJobStatus('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  lastError: text('last_error'),
  claimedByDeviceId: uuid('claimed_by_device_id'),
  claimedAt: ts('claimed_at'),
  finishedAt: ts('finished_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('print_jobs_dedupe_uq').on(t.dedupeKey),
  index('print_jobs_queue_idx').on(t.locationId, t.status, t.nextAttemptAt),
]);

/**
 * Fiskalni račun (zahtev prema fiskalnom provajderu i njegov odgovor).
 * Račun se smatra fiskalizovanim ISKLJUČIVO kada je status SIGNED i provajder je vratio broj.
 */
export const fiscalReceipts = pgTable('fiscal_receipts', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  provider: varchar('provider', { length: 32 }).notNull(),
  /** Vrsta transakcije: SALE / REFUND; vrsta računa: NORMAL / TRAINING (testni) */
  transactionType: varchar('transaction_type', { length: 12 }).notNull().default('SALE'),
  invoiceType: varchar('invoice_type', { length: 12 }).notNull(),
  status: fiscalStatus('status').notNull().default('PENDING'),
  request: jsonb('request').notNull(),
  response: jsonb('response'),
  invoiceNumber: varchar('invoice_number', { length: 80 }),
  verificationUrl: text('verification_url'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  lastError: text('last_error'),
  signedAt: ts('signed_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('fiscal_order_tx_uq').on(t.orderId, t.transactionType),
  index('fiscal_queue_idx').on(t.status, t.nextAttemptAt),
  check('fiscal_signed_has_number', sql`${t.status} <> 'SIGNED' OR (${t.invoiceNumber} IS NOT NULL AND ${t.signedAt} IS NOT NULL)`),
]);

// ---------- Faza 4: partneri, skladišta, robna dokumenta, kartica, normativi ----------

/** Količine na lageru: 4 decimale (normativi, npr. 0,0075 kg kafe). Nabavne cene: 4 decimale. */
const sqty = (name: string) => numeric(name, { precision: 16, scale: 4 });
const cost = (name: string) => numeric(name, { precision: 16, scale: 4 });

export const partnerKind = pgEnum('partner_kind', ['SUPPLIER', 'CUSTOMER', 'BOTH']);
export const stockDocKind = pgEnum('stock_doc_kind', ['RECEIPT', 'ISSUE', 'RETURN', 'TRANSFER', 'WRITE_OFF', 'INTERNAL', 'STOCKTAKE']);
export const stockDocStatus = pgEnum('stock_doc_status', ['DRAFT', 'POSTED', 'CANCELLED']);
export const movementSource = pgEnum('movement_source', ['DOCUMENT', 'SALE', 'REVERSAL']);
export const recipeStatus = pgEnum('recipe_status', ['DRAFT', 'ACTIVE', 'RETIRED']);

export const partners = pgTable('partners', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  kind: partnerKind('kind').notNull().default('SUPPLIER'),
  taxId: varchar('tax_id', { length: 9 }),
  registrationNo: varchar('registration_no', { length: 8 }),
  address: text('address'),
  city: text('city'),
  email: varchar('email', { length: 120 }),
  phone: varchar('phone', { length: 40 }),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('partners_org_taxid_uq').on(t.organizationId, t.taxId).where(sql`${t.taxId} IS NOT NULL`),
  index('partners_org_name_idx').on(t.organizationId, t.name),
]);

export const warehouses = pgTable('warehouses', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('warehouses_location_name_uq').on(t.locationId, t.name),
  uniqueIndex('warehouses_one_default_uq').on(t.locationId).where(sql`${t.isDefault}`),
]);

/** Trenutno stanje po (skladište, artikal). Menja se ISKLJUČIVO zajedno sa upisom kretanja (stock_movements). */
export const stockBalances = pgTable('stock_balances', {
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity: sqty('quantity').notNull().default('0'),
  /** Prosečna ponderisana nabavna cena po jedinici */
  avgCost: cost('avg_cost').notNull().default('0'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.warehouseId, t.productId] }),
  check('stock_balances_avg_nonneg', sql`${t.avgCost} >= 0`),
]);

export const stockDocuments = pgTable('stock_documents', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  kind: stockDocKind('kind').notNull(),
  status: stockDocStatus('status').notNull().default('DRAFT'),
  /** Broj se dodeljuje pri knjiženju (bez rupa zbog obrisanih nacrta), po vrsti i lokalu. */
  number: integer('number'),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  targetWarehouseId: uuid('target_warehouse_id').references(() => warehouses.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  docDate: date('doc_date').notNull(),
  externalNumber: varchar('external_number', { length: 60 }),
  note: text('note'),
  version: integer('version').notNull().default(0),
  createdById: uuid('created_by_id').notNull().references(() => users.id),
  postedById: uuid('posted_by_id').references(() => users.id),
  postedAt: ts('posted_at'),
  cancelledById: uuid('cancelled_by_id').references(() => users.id),
  cancelledAt: ts('cancelled_at'),
  cancelReason: text('cancel_reason'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('stock_documents_number_uq').on(t.locationId, t.kind, t.number).where(sql`${t.number} IS NOT NULL`),
  index('stock_documents_list_idx').on(t.locationId, t.kind, t.status),
  check('stock_documents_posted_has_number', sql`${t.status} = 'DRAFT' OR ${t.number} IS NOT NULL OR ${t.postedAt} IS NULL`),
  check('stock_documents_transfer_target', sql`${t.kind} <> 'TRANSFER' OR (${t.targetWarehouseId} IS NOT NULL AND ${t.targetWarehouseId} <> ${t.warehouseId})`),
  check('stock_documents_cancel_reason', sql`${t.status} <> 'CANCELLED' OR ${t.cancelReason} IS NOT NULL`),
]);

export const stockDocumentLines = pgTable('stock_document_lines', {
  id: id(),
  documentId: uuid('document_id').notNull().references(() => stockDocuments.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id),
  /** Popis: izbrojana količina (može biti 0). Ostala dokumenta: količina > 0. */
  quantity: sqty('quantity').notNull(),
  unitCost: cost('unit_cost'),
  /** Popis: knjižno stanje u trenutku knjiženja (snimak). */
  bookQuantity: sqty('book_quantity'),
  note: text('note'),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [
  index('stock_document_lines_doc_idx').on(t.documentId),
  uniqueIndex('stock_document_lines_doc_product_uq').on(t.documentId, t.productId),
  check('stock_document_lines_qty_nonneg', sql`${t.quantity} >= 0`),
  check('stock_document_lines_cost_nonneg', sql`${t.unitCost} IS NULL OR ${t.unitCost} >= 0`),
]);

export const recipes = pgTable('recipes', {
  id: id(),
  productId: uuid('product_id').notNull().references(() => products.id),
  version: integer('version').notNull(),
  status: recipeStatus('status').notNull().default('DRAFT'),
  note: text('note'),
  createdById: uuid('created_by_id').notNull().references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
  activatedAt: ts('activated_at'),
  retiredAt: ts('retired_at'),
}, (t) => [
  uniqueIndex('recipes_product_version_uq').on(t.productId, t.version),
  uniqueIndex('recipes_one_active_uq').on(t.productId).where(sql`${t.status} = 'ACTIVE'`),
]);

export const recipeLines = pgTable('recipe_lines', {
  id: id(),
  recipeId: uuid('recipe_id').notNull().references(() => recipes.id, { onDelete: 'cascade' }),
  componentId: uuid('component_id').notNull().references(() => products.id),
  /** Količina komponente za 1 jedinicu prodatog artikla, u jedinici mere komponente */
  quantity: sqty('quantity').notNull(),
}, (t) => [
  uniqueIndex('recipe_lines_recipe_component_uq').on(t.recipeId, t.componentId),
  check('recipe_lines_qty_pos', sql`${t.quantity} > 0`),
]);

/**
 * Kartica artikla: svako kretanje zalihe. Nikad se ne briše ni menja — storno je novo, suprotno kretanje.
 * balanceAfter/avgCostAfter = stanje posle ovog kretanja (redosled je serijalizovan zaključavanjem stanja).
 */
export const stockMovements = pgTable('stock_movements', {
  id: id(),
  /** Redosled upisa (unutar iste transakcije svi redovi imaju isto vreme) — kartica se sortira po njemu. */
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity: sqty('quantity').notNull(),
  unitCost: cost('unit_cost').notNull(),
  value: money('value').notNull(),
  balanceAfter: sqty('balance_after').notNull(),
  avgCostAfter: cost('avg_cost_after').notNull(),
  source: movementSource('source').notNull(),
  documentId: uuid('document_id').references(() => stockDocuments.id),
  documentLineId: uuid('document_line_id').references(() => stockDocumentLines.id),
  orderId: uuid('order_id').references(() => orders.id),
  orderItemId: uuid('order_item_id').references(() => orderItems.id),
  recipeId: uuid('recipe_id').references(() => recipes.id),
  reversesMovementId: uuid('reverses_movement_id'),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  index('stock_movements_card_idx').on(t.warehouseId, t.productId, t.seq),
  index('stock_movements_doc_idx').on(t.documentId),
  /** Utrošak pri prodaji: najviše jednom po (stavka računa, artikal/komponenta). */
  uniqueIndex('stock_movements_sale_uq').on(t.orderItemId, t.productId).where(sql`${t.source} = 'SALE'`),
  /** Knjiženje dokumenta: najviše jedno kretanje po (stavka dokumenta, skladište). */
  uniqueIndex('stock_movements_doc_line_uq').on(t.documentLineId, t.warehouseId).where(sql`${t.source} = 'DOCUMENT'`),
  /** Svako kretanje se stornira najviše jednom. */
  uniqueIndex('stock_movements_reversal_uq').on(t.reversesMovementId).where(sql`${t.reversesMovementId} IS NOT NULL`),
  check('stock_movements_qty_nonzero', sql`${t.quantity} <> 0`),
]);
