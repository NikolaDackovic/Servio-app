import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { Tx } from '../../db/db.module';
import {
  categories, orderItems, orders, prepStations, products, recipeLines, recipes, stockBalances, stockMovements, warehouses,
} from '../../db/schema';
import { Invalid } from '../../common/errors';
import { D, Dec, dec } from '../../common/money';

/**
 * Jezgro lagera. JEDINO mesto koje menja stock_balances — uvek zajedno sa upisom kretanja u karticu.
 *
 * Prosečna ponderisana nabavna cena (PPNC):
 *  - ulaz (q > 0) po ceni c:      novaCena = (stanje × prosek + q × c) / (stanje + q);  ako je stanje ≤ 0 → novaCena = c
 *  - izlaz (q < 0) po proseku:    prosek se ne menja
 *  - storno ulaza (q < 0 po ceni ulaza c): novaCena = (stanje × prosek − |q| × c) / (stanje − |q|), ako ostaje > 0
 * Cene se čuvaju na 4 decimale (HALF_UP), vrednosti kretanja na 2.
 */

export const q4 = (v: Dec) => v.toDecimalPlaces(4, D.ROUND_HALF_UP).toFixed(4);
const m2 = (v: Dec) => v.toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);

export interface MoveInput {
  locationId: string;
  warehouseId: string;
  productId: string;
  /** pozitivno = ulaz, negativno = izlaz */
  quantity: Dec;
  /** ulaz: nabavna cena; izlaz: izostaviti (koristi se prosek) ili cena originalnog ulaza kod storna */
  unitCost?: Dec;
  source: 'DOCUMENT' | 'SALE' | 'REVERSAL';
  allowNegative: boolean;
  documentId?: string | null;
  documentLineId?: string | null;
  orderId?: string | null;
  orderItemId?: string | null;
  recipeId?: string | null;
  reversesMovementId?: string | null;
  userId: string | null;
  /** za poruku o grešci */
  productName?: string;
}

/** Zaključava redove stanja u stalnom redosledu (skladište, artikal) — sprečava međusobno blokiranje transakcija. */
export async function lockBalances(tx: Tx, pairs: { warehouseId: string; productId: string }[]) {
  const uniq = [...new Map(pairs.map((p) => [`${p.warehouseId}|${p.productId}`, p])).values()]
    .sort((a, b) => (a.warehouseId + a.productId).localeCompare(b.warehouseId + b.productId));
  for (const p of uniq) {
    await tx.insert(stockBalances).values({ warehouseId: p.warehouseId, productId: p.productId }).onConflictDoNothing();
    await tx.select().from(stockBalances)
      .where(and(eq(stockBalances.warehouseId, p.warehouseId), eq(stockBalances.productId, p.productId))).for('update');
  }
}

export async function applyMovement(tx: Tx, m: MoveInput) {
  if (m.quantity.isZero()) throw new Error('Kretanje sa količinom 0');
  await lockBalances(tx, [m]);
  const [b] = await tx.select().from(stockBalances)
    .where(and(eq(stockBalances.warehouseId, m.warehouseId), eq(stockBalances.productId, m.productId)));
  const qty = dec(b.quantity);
  const avg = dec(b.avgCost);
  const newQty = qty.add(m.quantity);
  let unitCost: Dec;
  let newAvg: Dec;
  if (m.quantity.gt(0)) {
    unitCost = m.unitCost ?? avg;
    newAvg = qty.lte(0) ? unitCost : qty.mul(avg).add(m.quantity.mul(unitCost)).div(newQty);
  } else {
    if (!m.allowNegative && newQty.lt(0)) {
      throw Invalid('INSUFFICIENT_STOCK', `Nema dovoljno na stanju: ${m.productName ?? 'artikal'} (stanje ${q4(qty)}, potrebno ${q4(m.quantity.neg())})`, {
        productId: m.productId, warehouseId: m.warehouseId, available: q4(qty), required: q4(m.quantity.neg()),
      });
    }
    unitCost = m.unitCost ?? avg;
    newAvg = newQty.gt(0) ? qty.mul(avg).add(m.quantity.mul(unitCost)).div(newQty) : avg;
    if (newAvg.lt(0)) newAvg = dec(0);
  }
  await tx.update(stockBalances).set({ quantity: q4(newQty), avgCost: q4(newAvg), updatedAt: new Date() })
    .where(and(eq(stockBalances.warehouseId, m.warehouseId), eq(stockBalances.productId, m.productId)));
  const [row] = await tx.insert(stockMovements).values({
    locationId: m.locationId, warehouseId: m.warehouseId, productId: m.productId,
    quantity: q4(m.quantity), unitCost: q4(unitCost), value: m2(m.quantity.mul(unitCost)),
    balanceAfter: q4(newQty), avgCostAfter: q4(newAvg), source: m.source,
    documentId: m.documentId ?? null, documentLineId: m.documentLineId ?? null, orderId: m.orderId ?? null,
    orderItemId: m.orderItemId ?? null, recipeId: m.recipeId ?? null, reversesMovementId: m.reversesMovementId ?? null,
    createdById: m.userId,
  }).returning();
  return row;
}

export async function defaultWarehouse(tx: Tx, locationId: string) {
  const [w] = await tx.select().from(warehouses)
    .where(and(eq(warehouses.locationId, locationId), eq(warehouses.isDefault, true)));
  return w ?? null;
}

/**
 * Automatski utrošak pri naplati računa (poziva se u ISTOJ transakciji u kojoj račun prelazi u PAID).
 *  - artikal sa aktivnim normativom → troše se komponente (količina stavke × količina iz normativa)
 *  - artikal bez normativa sa vođenjem zalihe → troši se sam artikal
 *  - ostalo → nema utroška
 * Skladište: skladište pripremne pozicije stavke (ili artikla/kategorije), inače podrazumevano skladište lokala.
 * Idempotentno: jedinstveni indeks (stavka, artikal) za izvor SALE — ponovljen poziv ne troši dvaput.
 * Prodaja SME da ode u minus (roba je fizički izdata); minus se vidi u stanju i kartici.
 */
export async function consumeForOrder(tx: Tx, orderId: string, userId: string) {
  const [o] = await tx.select({ id: orders.id, locationId: orders.locationId }).from(orders).where(eq(orders.id, orderId));
  const items = await tx.select({
    id: orderItems.id, productId: orderItems.productId, quantity: orderItems.quantity, itemStation: orderItems.prepStationId,
    trackStock: products.trackStock, productName: products.name,
    productStation: sql<string | null>`coalesce(${products.prepStationId}, ${categories.prepStationId})`,
  }).from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(and(eq(orderItems.orderId, orderId), ne(orderItems.status, 'VOIDED')));
  if (!items.length) return [];

  const def = await defaultWarehouse(tx, o.locationId);
  const stationIds = [...new Set(items.flatMap((i) => [i.itemStation, i.productStation]).filter((x): x is string => !!x))];
  const stationWh = new Map<string, string | null>(stationIds.length
    ? (await tx.select({ id: prepStations.id, wh: prepStations.warehouseId }).from(prepStations).where(inArray(prepStations.id, stationIds))).map((s) => [s.id, s.wh])
    : []);
  const productIds = [...new Set(items.map((i) => i.productId))];
  const active = await tx.select({ recipeId: recipes.id, productId: recipes.productId, componentId: recipeLines.componentId, quantity: recipeLines.quantity, componentName: products.name })
    .from(recipes).innerJoin(recipeLines, eq(recipeLines.recipeId, recipes.id))
    .innerJoin(products, eq(products.id, recipeLines.componentId))
    .where(and(inArray(recipes.productId, productIds), eq(recipes.status, 'ACTIVE')));

  const plan: MoveInput[] = [];
  for (const i of items) {
    const wh = (i.itemStation && stationWh.get(i.itemStation)) || (i.productStation && stationWh.get(i.productStation)) || def?.id;
    const comps = active.filter((r) => r.productId === i.productId);
    const lines = comps.length
      ? comps.map((c) => ({ productId: c.componentId, qty: dec(i.quantity).mul(dec(c.quantity)), recipeId: c.recipeId, name: c.componentName }))
      : i.trackStock ? [{ productId: i.productId, qty: dec(i.quantity), recipeId: null as string | null, name: i.productName }] : [];
    if (lines.length && !wh) {
      throw Invalid('NO_WAREHOUSE', 'Lokal nema podrazumevano skladište — utrošak ne može da se evidentira (ADMIN → Skladišta)');
    }
    for (const l of lines) {
      const qty = dec(q4(l.qty));
      if (qty.isZero()) continue;
      plan.push({
        locationId: o.locationId, warehouseId: wh!, productId: l.productId, quantity: qty.neg(), source: 'SALE', allowNegative: true,
        orderId, orderItemId: i.id, recipeId: l.recipeId, userId, productName: l.name,
      });
    }
  }
  if (!plan.length) return [];
  const done = await tx.select({ itemId: stockMovements.orderItemId, productId: stockMovements.productId }).from(stockMovements)
    .where(and(eq(stockMovements.orderId, orderId), eq(stockMovements.source, 'SALE')));
  const doneKeys = new Set(done.map((d) => `${d.itemId}|${d.productId}`));
  const todo = plan.filter((p) => !doneKeys.has(`${p.orderItemId}|${p.productId}`));
  await lockBalances(tx, todo);
  const out = [];
  for (const p of todo.sort((a, b) => (a.warehouseId + a.productId).localeCompare(b.warehouseId + b.productId))) {
    out.push(await applyMovement(tx, p));
  }
  return out;
}

export async function balanceOf(tx: Tx, warehouseId: string, productId: string) {
  const [b] = await tx.select().from(stockBalances)
    .where(and(eq(stockBalances.warehouseId, warehouseId), eq(stockBalances.productId, productId)));
  return { quantity: dec(b?.quantity ?? 0), avgCost: dec(b?.avgCost ?? 0) };
}

