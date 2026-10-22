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
  pgTable, uuid, text, varchar, boolean, integer, numeric, timestamp, jsonb, pgEnum,
  uniqueIndex, index, primaryKey, check,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const qty = (name: string) => numeric(name, { precision: 12, scale: 3 });

export const deviceKind = pgEnum('device_kind', ['POS', 'MOBILE', 'KDS']);
export const orderStatus = pgEnum('order_status', ['OPEN', 'PAID', 'CANCELLED']);
export const orderItemStatus = pgEnum('order_item_status', ['NEW', 'SENT', 'VOIDED']);
export const paymentMethod = pgEnum('payment_method', ['CASH', 'CARD', 'TRANSFER']);
export const paymentMode = pgEnum('payment_mode', ['TEST', 'LIVE']);
export const shiftStatus = pgEnum('shift_status', ['OPEN', 'CLOSED']);
export const cashMovementType = pgEnum('cash_movement_type', ['PAY_IN', 'PAY_OUT']);

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

// ---------- Smena (pre porudžbina zbog FK iz plaćanja) ----------

export const cashShifts = pgTable('cash_shifts', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
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
  number: integer('number').notNull(),
  status: orderStatus('status').notNull().default('OPEN'),
  guests: integer('guests'),
  note: text('note'),
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
  check('orders_total_nonneg', sql`${t.total} >= 0`),
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
  note: text('note'),
  status: orderItemStatus('status').notNull().default('NEW'),
  sendBatch: integer('send_batch'),
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
  check('order_items_void_has_reason', sql`${t.status} <> 'VOIDED' OR (${t.voidReason} IS NOT NULL AND ${t.voidedById} IS NOT NULL)`),
]);

export const payments = pgTable('payments', {
  id: id(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  shiftId: uuid('shift_id').notNull().references(() => cashShifts.id),
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
