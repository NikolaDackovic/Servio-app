# Baza podataka

PostgreSQL 16. Šema: `apps/api/src/db/schema.ts`. Migracije: `apps/api/migrations/*.sql` (generiše `npm run db:generate`, primenjuje `npm run db:migrate`).

## Entiteti (iteracije 1–3)

| Tabela | Svrha |
|---|---|
| organizations, locations, devices | Višelokalni kontekst; uređaj = kasa / mobilni / KDS |
| roles, users | Uloge sa listom prava; korisnik ima lozinku i/ili PIN (heš + HMAC lookup) |
| tax_rates, categories, products, product_price_changes | Katalog, poreske stope, istorija cena |
| dining_tables | Stolovi po prostoriji: pozicija, veličina i oblik za mapu (0005; CHECK oblik i opseg veličine) |
| product_images | Slika artikla za kasu (0005), odvojeno od `products` da lista artikala ostane lagana |
| products.note_options | Izmene artikla za kasu (0006, jsonb niz); `print_job_kind` dobija `SHIFT_REPORT` (štampa pazara) |
| orders, order_items | Porudžbina/račun i stavke sa snimkom naziva, cene i poreza |
| payments | Plaćanja (metoda, režim TEST/LIVE, kusur, idempotency ključ) |
| cash_shifts, cash_movements | Blagajnička smena po uređaju, uplate i isplate |
| document_counters | Atomska numeracija po lokalu i vrsti dokumenta |
| audit_logs | Revizijski trag (ko, šta, kada, podaci, request-id) |
| business_days, staff_shifts, discounts | Poslovni dan, smene zaposlenih, popusti (iteracije 2–3) |

## Entiteti — faza 3 (migracija 0003)
| Tabela | Svrha |
|---|---|
| printers | Štampač lokala: SIMULATED / NETWORK_ESCPOS (host, port) / WINDOWS_RAW (naziv u Windows-u), širina 58/80 mm |
| prep_stations | Pripremna pozicija (šank, kuhinja): štampač, prikaz na KDS-u, skladište iz kog se troši |
| categories.prep_station_id, products.prep_station_id | Rutiranje: artikal → pozicija (artikal ima prednost nad kategorijom) |
| kds_tickets | KDS kartica = (račun, tura, pozicija), jedinstveni indeks; statusi NEW → IN_PROGRESS → READY → DONE |
| order_items.prep_station_id, kds_ticket_id, ready_at | Snimak rutiranja pri slanju i status stavke |
| print_jobs | Red štampe; `dedupe_key` jedinstven (`ticket:{order}:{tura}:{pozicija}`, `void:{stavka}`, `receipt:{order}:{ključ}`); statusi PENDING/PRINTING/PRINTED/SIMULATED/FAILED, broj pokušaja, sledeći pokušaj, zakup |
| devices.kind = BRIDGE, api_key_hash, api_key_prefix, last_seen_at | Print Bridge uređaj (ključ se čuva samo kao SHA-256) |
| devices.receipt_printer_id | Štampač računa po kasi |
| fiscal_receipts | Fiskalni red: zahtev, odgovor, broj, pokušaji; jedinstveno (račun, vrsta transakcije); CHECK: SIGNED ⇒ broj i vreme postoje |

## Entiteti — faza 4 (migracija 0004)
| Tabela | Svrha |
|---|---|
| products.track_stock, products.is_sellable | Vođenje zalihe; sirovine (`is_sellable = false`) se ne prodaju na kasi |
| partners | Dobavljači/kupci; PIB jedinstven po organizaciji (parcijalni indeks) |
| warehouses | Skladišta lokala; tačno jedno podrazumevano (parcijalni jedinstveni indeks) — migracija ga pravi za svaki postojeći lokal |
| stock_balances | Stanje (warehouse, product): količina `numeric(16,4)` i prosečna nabavna cena `numeric(16,4)` |
| stock_documents, stock_document_lines | Robna dokumenta: RECEIPT, ISSUE, RETURN, TRANSFER, WRITE_OFF, INTERNAL, STOCKTAKE; DRAFT → POSTED → CANCELLED; broj se dodeljuje pri knjiženju (`document_counters`, vrsta `STOCK_*`) |
| stock_movements | Kartica: svako kretanje (izvor DOCUMENT / SALE / REVERSAL), stanje i PPNC posle kretanja, `seq` za redosled. Ne menja se i ne briše |
| recipes, recipe_lines | Normativi sa verzijama (DRAFT / ACTIVE / RETIRED); najviše jedna aktivna po artiklu |

### Pravila lagera
- `stock_balances` menja isključivo `applyMovement` (src/modules/stock/engine.ts), uvek zajedno sa upisom u `stock_movements`, u istoj transakciji, sa zaključanim redom stanja (zaključavanje u stalnom redosledu skladište/artikal).
- PPNC: ulaz `(stanje×prosek + q×cena)/(stanje+q)`; ako je stanje ≤ 0, prosek = cena ulaza. Izlaz po proseku (prosek se ne menja). Storno ulaza skida po ceni tog ulaza i vraća prosek.
- Ručna dokumenta ne smeju u minus (`INSUFFICIENT_STOCK`), prodaja sme (roba je fizički izdata) — minus se vidi u stanju i kartici.
- Jedinstveni indeksi: utrošak `(order_item_id, product_id)` za izvor SALE; knjiženje `(document_line_id, warehouse_id)` za DOCUMENT; storno `reverses_movement_id`.

## Pravila za novac i zaokruživanje
- Tipovi: novac `numeric(14,2)`, količina na računu `numeric(12,3)`, količina na lageru i nabavna cena `numeric(16,4)`, stopa `numeric(5,2)`.
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
