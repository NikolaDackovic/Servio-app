/**
 * DEMO podaci — samo za razvoj i demonstraciju. Ne pokretati na produkcionoj bazi klijenta.
 * Idempotentno: ako demo organizacija već postoji, ništa se ne menja.
 *
 * Demo nalozi (promeniti odmah u svakom ne-razvojnom okruženju):
 *   admin@demo.local / Demo123!      (Administrator)
 *   PIN 1111 — Marko (Konobar)
 *   PIN 2222 — Ana (Kasir)
 *   PIN 9999 — Jelena (Menadžer)
 */
import '../load-env';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as s from './schema';
import { DEFAULT_ROLES } from '../common/permissions';
import { hashSecret, pinLookup } from '../common/security';
import { createHash, randomBytes } from 'crypto';

export const DEMO_ORG_NAME = 'DEMO Kafe Restoran';

export async function seed(databaseUrl: string, pinPepper: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const db = drizzle(pool, { schema: s });
  try {
    const [exists] = await db.select().from(s.organizations).where(eq(s.organizations.name, DEMO_ORG_NAME));
    if (exists) return { created: false, organizationId: exists.id };

    return await db.transaction(async (tx) => {
      const [org] = await tx.insert(s.organizations).values({ name: DEMO_ORG_NAME, taxId: '000000000' }).returning();
      const [loc] = await tx.insert(s.locations).values({ organizationId: org.id, name: 'Demo lokal – Centar', address: 'Demo adresa 1, Beograd' }).returning();
      const [pos1] = await tx.insert(s.devices).values({ locationId: loc.id, name: 'Kasa 1 – Šank', kind: 'POS' }).returning();
      await tx.insert(s.devices).values({ locationId: loc.id, name: 'Telefon konobara 1', kind: 'MOBILE' });

      const roleIds: Record<string, string> = {};
      for (const r of DEFAULT_ROLES) {
        const [row] = await tx.insert(s.roles).values({ organizationId: org.id, ...r }).returning();
        roleIds[r.code] = row.id;
      }

      const mkUser = async (fullName: string, role: string, opts: { email?: string; password?: string; pin?: string }) => {
        await tx.insert(s.users).values({
          organizationId: org.id, roleId: roleIds[role], fullName,
          email: opts.email ?? null,
          passwordHash: opts.password ? await hashSecret(opts.password) : null,
          pinHash: opts.pin ? await hashSecret(opts.pin) : null,
          pinLookup: opts.pin ? pinLookup(opts.pin, pinPepper) : null,
        });
      };
      await mkUser('Administrator', 'ADMIN', { email: 'admin@demo.local', password: 'Demo123!' });
      const [adminUser] = await tx.select().from(s.users).where(eq(s.users.email, 'admin@demo.local'));
      await mkUser('Marko Konobar', 'WAITER', { pin: '1111' });
      await mkUser('Ana Kasir', 'CASHIER', { pin: '2222' });
      await mkUser('Jelena Menadžer', 'MANAGER', { pin: '9999', email: 'menadzer@demo.local', password: 'Demo123!' });
      await mkUser('Kuhinja', 'KITCHEN', { pin: '3333' });

      // Oznake i stope proveriti prema važećem tehničkom vodiču PU pre produkcije.
      const [vat20] = await tx.insert(s.taxRates).values({ organizationId: org.id, label: 'Đ', name: 'Opšta stopa PDV', rate: '20.00' }).returning();
      const [vat10] = await tx.insert(s.taxRates).values({ organizationId: org.id, label: 'E', name: 'Posebna stopa PDV', rate: '10.00' }).returning();
      await tx.insert(s.taxRates).values({ organizationId: org.id, label: 'A', name: 'Bez PDV-a', rate: '0.00' });

      const cat = async (name: string, color: string, sortOrder: number) =>
        (await tx.insert(s.categories).values({ organizationId: org.id, name, color, sortOrder }).returning())[0];
      const kafa = await cat('Topli napici', '#8B5A2B', 1);
      const sok = await cat('Bezalkoholna pića', '#2E86AB', 2);
      const pivo = await cat('Pivo i vino', '#C9A227', 3);
      const hrana = await cat('Hrana', '#3C9D5D', 4);

      // Štampa i KDS (demo): SIMULIRANI štampači — Print Bridge ih ne šalje na papir, već ih beleži kao SIMULATED.
      const [prBar] = await tx.insert(s.printers).values({ locationId: loc.id, name: 'Šank – simulacija', connection: 'SIMULATED' }).returning();
      const [prKitchen] = await tx.insert(s.printers).values({ locationId: loc.id, name: 'Kuhinja – simulacija', connection: 'SIMULATED' }).returning();
      const [prReceipt] = await tx.insert(s.printers).values({ locationId: loc.id, name: 'Kasa 1 – računi (simulacija)', connection: 'SIMULATED' }).returning();
      const [stBar] = await tx.insert(s.prepStations).values({ locationId: loc.id, name: 'Šank', kind: 'BAR', printerId: prBar.id }).returning();
      const [stKitchen] = await tx.insert(s.prepStations).values({ locationId: loc.id, name: 'Kuhinja', kind: 'KITCHEN', printerId: prKitchen.id }).returning();
      for (const c of [kafa, sok, pivo]) await tx.update(s.categories).set({ prepStationId: stBar.id }).where(eq(s.categories.id, c.id));
      await tx.update(s.categories).set({ prepStationId: stKitchen.id }).where(eq(s.categories.id, hrana.id));
      await tx.update(s.devices).set({ receiptPrinterId: prReceipt.id }).where(eq(s.devices.id, pos1.id));
      const [kds] = await tx.insert(s.devices).values({ locationId: loc.id, name: 'KDS – Kuhinja', kind: 'KDS' }).returning();
      // Demo Print Bridge: ključ se ispisuje samo ovde (razvoj). U produkciji ključ izdaje ADMIN → Štampa.
      const bridgeKey = `pb_${randomBytes(32).toString('base64url')}`;
      const [bridge] = await tx.insert(s.devices).values({
        locationId: loc.id, name: 'Print Bridge – demo', kind: 'BRIDGE',
        apiKeyHash: createHash('sha256').update(bridgeKey).digest('hex'), apiKeyPrefix: bridgeKey.slice(0, 10),
      }).returning();

      const prods: [typeof kafa, string, string, string, string][] = [
        [kafa, 'K001', 'Espresso', '180.00', vat20.id],
        [kafa, 'K002', 'Kapućino', '230.00', vat20.id],
        [kafa, 'K003', 'Domaća kafa', '160.00', vat20.id],
        [kafa, 'K004', 'Čaj', '170.00', vat20.id],
        [sok, 'S001', 'Coca-Cola 0,25', '250.00', vat20.id],
        [sok, 'S002', 'Ceđena pomorandža', '320.00', vat20.id],
        [sok, 'S003', 'Kisela voda 0,33', '190.00', vat20.id],
        [pivo, 'P001', 'Točeno pivo 0,5', '330.00', vat20.id],
        [pivo, 'P002', 'Čaša vina', '390.00', vat20.id],
        [hrana, 'H001', 'Pileći file sa grilla', '1150.00', vat20.id],
        [hrana, 'H002', 'Pljeskavica', '990.00', vat20.id],
        [hrana, 'H003', 'Šopska salata', '450.00', vat20.id],
        [hrana, 'H004', 'Proja (posebna stopa – demo)', '200.00', vat10.id],
      ];
      let i = 0;
      for (const [c, code, name, price, tax] of prods) {
        const [p] = await tx.insert(s.products).values({ organizationId: org.id, categoryId: c.id, taxRateId: tax, code, name, price, sortOrder: i++ }).returning();
        await tx.insert(s.productPriceChanges).values({ productId: p.id, oldPrice: null, newPrice: price, userId: adminUser.id });
      }
      let order = 0;
      for (const [name, percent] of [['Popust 10%', '10'], ['Popust 20%', '20'], ['Popust 30%', '30'], ['Popust 40%', '40'], ['Loyalty 15%', '15']] as const) {
        await tx.insert(s.discounts).values({ organizationId: org.id, name, percent, sortOrder: order++ });
      }
      for (let t = 1; t <= 8; t++) {
        await tx.insert(s.diningTables).values({ locationId: loc.id, name: `Sto ${t}`, area: t <= 6 ? 'Sala' : 'Bašta', seats: 4, posX: ((t - 1) % 4) * 140, posY: Math.floor((t - 1) / 4) * 120 });
      }
      return {
        created: true, organizationId: org.id, locationId: loc.id, posDeviceId: pos1.id, kdsDeviceId: kds.id,
        bridgeDeviceId: bridge.id, bridgeKey, stations: { bar: stBar.id, kitchen: stKitchen.id },
      };
    });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  const pepper = process.env.PIN_PEPPER;
  if (!url || !pepper) {
    console.error('DATABASE_URL i PIN_PEPPER moraju biti postavljeni');
    process.exit(1);
  }
  seed(url, pepper)
    .then((r: any) => {
      if (!r.created) return console.log('Demo podaci već postoje — preskačem.');
      console.log(`Demo podaci kreirani (organizacija ${r.organizationId}).`);
      console.log(`Print Bridge (demo) — ključ za apps/print-bridge/.env (prikazuje se samo sada):\n  BRIDGE_KEY=${r.bridgeKey}`);
    })
    .catch((e) => { console.error('Seed nije uspeo:', e.message, e.cause?.message ? `\nUzrok: ${e.cause.message}` : ''); process.exit(1); });
}
