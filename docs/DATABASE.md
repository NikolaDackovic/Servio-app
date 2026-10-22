# Baza podataka

PostgreSQL 16. Šema: `apps/api/src/db/schema.ts`. Migracije: `apps/api/migrations/*.sql` (generiše `npm run db:generate`, primenjuje `npm run db:migrate`).

## Entiteti (iteracija 1)

| Tabela | Svrha |
|---|---|
| organizations, locations, devices | Višelokalni kontekst; uređaj = kasa / mobilni / KDS |
| roles, users | Uloge sa listom prava; korisnik ima lozinku i/ili PIN (heš + HMAC lookup) |
| tax_rates, categories, products, product_price_changes | Katalog, poreske stope, istorija cena |
| dining_tables | Stolovi po prostoriji, pozicija za mapu |
| orders, order_items | Porudžbina/račun i stavke sa snimkom naziva, cene i poreza |
| payments | Plaćanja (metoda, režim TEST/LIVE, kusur, idempotency ključ) |
| cash_shifts, cash_movements | Blagajnička smena po uređaju, uplate i isplate |
| document_counters | Atomska numeracija po lokalu i vrsti dokumenta |
| audit_logs | Revizijski trag (ko, šta, kada, podaci, request-id) |

## Pravila za novac i zaokruživanje
- Tipovi: novac `numeric(14,2)`, količina `numeric(12,3)`, stopa `numeric(5,2)`.
- Cene su **bruto** (sa PDV-om). Iznos stavke = `round_half_up(cena × količina, 2)`.
- Iznos računa = zbir zaokruženih iznosa aktivnih (ne-storniranih) stavki — bez dodatnog zaokruživanja.
- PDV po stopi = `round_half_up(bruto_po_stopi × stopa / (100 + stopa), 2)`; osnovica = bruto − PDV. Računa se po zbiru stopa, ne po stavci (izbegava gomilanje grešaka zaokruživanja). **Pre fiskalizacije uskladiti sa pravilima tehničkog vodiča PU.**
- Stavka čuva snimak cene i stope: promena cene ili stope ne menja postojeće račune.

## Ograničenja na nivou baze
- `orders_paid_not_over_total`: `0 ≤ paid_total ≤ total`
- `orders_paid_means_settled`: status PAID ⇒ `paid_total = total` i `closed_at` postoji
- `order_items_qty_pos`, `order_items_price_nonneg`, `order_items_void_has_reason`
- `payments_amount_pos`, `payments_change_nonneg`; jedinstven `(order_id, idempotency_key)`
- `shifts_one_open_per_device_uq`: parcijalni jedinstveni indeks — najviše jedna otvorena smena po kasi
- Jedinstvenost: šifra proizvoda po organizaciji, broj porudžbine po lokalu, PIN po organizaciji

## Vreme
- Sve kolone su `timestamptz` (UTC). Lokal ima `timezone` (podrazumevano `Europe/Belgrade`); izveštaji računaju granice dana u zoni lokala.
- Razdvojeno: `opened_at`/`closed_at` (poslovno vreme), `created_at`, `updated_at`.

## Konkurentnost
Izmene porudžbine i naplata: transakcija + `SELECT … FOR UPDATE` na porudžbini + `version`. Numeracija: `INSERT … ON CONFLICT DO UPDATE … RETURNING` (atomski). Testovi dokazuju: 10 paralelnih naplata → 1 uspešna; 20 paralelnih dodavanja → tačan zbir.

## Migracije u produkciji
1. Backup (DEPLOYMENT.md). 2. `npm run db:migrate:prod`. Migrator vodi evidenciju u šemi `drizzle` i primenjuje samo nove fajlove. Migracije se ne menjaju nakon objave — samo se dodaju nove.
