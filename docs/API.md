# REST API

Osnovna putanja: `/api/v1`. Interaktivna dokumentacija (OpenAPI/Swagger): `http://localhost:3000/api/docs`.

## Konvencije
- Autentifikacija: `Authorization: Bearer <token>` (dobija se sa `/auth/login` ili `/auth/pin`, važi 12 h).
- Novac i količine su **stringovi** (`"180.00"`, `"0.333"`), nikada JSON brojevi.
- Greške uvek imaju isti oblik:
  ```json
  { "error": { "code": "AMOUNT_EXCEEDS_REMAINING", "message": "…", "details": { … }, "requestId": "…" } }
  ```
  Klijenti se oslanjaju na `code`. Statusi: 400 validacija, 401 prijava, 403 pravo, 404 ne postoji (ili nije vaše), 409 konflikt stanja, 422 poslovno neispravan unos, 429 previše pokušaja.
- Paginacija (gde postoji): `page`, `pageSize`; odgovor `{ data, page, pageSize, total }`.
- Idempotentnost: `idempotencyKey` u telu za otvaranje porudžbine (opciono) i naplatu (obavezno). Isti ključ = isti rezultat, bez dupliranja.
- Optimistička kontrola: `expectedVersion` u izmenama porudžbine → `409 STALE_ORDER` ako je neko u međuvremenu menjao.
- Svaki odgovor ima `X-Request-Id`.

## Rute (iteracija 1)

| Metoda i putanja | Pravo | Opis |
|---|---|---|
| GET `/health` | javno | Stanje servisa i baze; prikazuje `paymentMode` i `fiscalization` |
| POST `/auth/login` | javno | `{ email, password, locationId?, deviceId? }` |
| POST `/auth/pin` | javno | `{ deviceId, pin }` — prijava na kasi |
| GET `/auth/me` | prijavljen | Korisnik, prava, lokali, uređaji |
| GET `/tax-rates` | catalog.read | Aktivne poreske stope |
| GET/POST `/categories`, PATCH `/categories/:id` | catalog.read / catalog.write | |
| GET `/products?categoryId&search&includeInactive&page&pageSize` | catalog.read | |
| POST `/products`, PATCH `/products/:id` | catalog.write | Promena cene se beleži u istoriji |
| GET `/products/:id/price-history` | catalog.read | |
| GET `/tables`, POST `/tables` | table.read / table.write | Stanje stola izvedeno iz otvorenih računa |
| GET `/orders?status&tableId&businessDayId&waiterId&mine&page&pageSize` | order.read | Konobar vidi samo svoje bez `order.read_all` |
| POST `/orders` | order.write | `{ tableId?, guests?, note?, idempotencyKey? }` |
| GET `/orders/:id` | order.read | Stavke, plaćanja, preostalo, PDV rekapitulacija |
| POST `/orders/:id/items` | order.write | `{ productId, quantity?, note?, expectedVersion? }` |
| PATCH `/orders/:id/items/:itemId` | order.write | Samo neposlate stavke |
| DELETE `/orders/:id/items/:itemId?expectedVersion=` | order.write | Samo neposlate stavke |
| POST `/orders/:id/send` | order.write | Nove stavke → tura N; ponovljeno bez novih ne radi ništa |
| POST `/orders/:id/items/:itemId/void` | order.write + order.void | `{ reason }` — samo poslate stavke |
| POST `/orders/:id/cancel` | order.write | Samo bez naplate i bez poslatih stavki |
| POST `/orders/:id/payments` | payment.create | `{ method, amount?, tendered?, idempotencyKey }`; zahteva otvorenu smenu na kasi |
| GET `/shifts/current` | order.read | Otvorena smena kase + obračun |
| POST `/shifts/open`, `/shifts/close`, `/shifts/current/cash-movements` | shift.manage | |
| GET `/shifts`, `/shifts/:id/report` | shift.manage | |
| GET `/reports/sales?from&to` ili `?businessDayId` (+ `waiterId`, `deviceId`) | report.read | Po datumu (zona lokala) ili po poslovnom danu |
| GET `/business-days/current` | order.read | Otvoren dan + obračun |
| POST `/business-days/open` `{ date? }` | day.manage | Datum mora biti posle poslednjeg dana |
| POST `/business-days/current/close` | day.manage | 409 `DAY_HAS_OPEN_ORDERS` / `DAY_HAS_OPEN_CASH_SHIFTS` sa spiskom |
| GET `/business-days?month=YYYY-MM` | report.read | Kalendar |
| GET `/business-days/:id` | report.read | Obračun, kase, smene zaposlenih |
| GET `/staff-shifts/current`, POST `/staff-shifts/current/end` | order.read | Specifikacija pazara; kraj smene (409 `STAFF_HAS_OPEN_ORDERS`) |
| GET `/staff-shifts?businessDayId`, GET `/staff-shifts/:id` | order.read | Tuđe smene uz order.read_all |
| GET `/staff/waiters` | order.read | Zaposleni koji mogu da preuzmu račune |
| POST `/orders/:id/settle` `{ parts[{method, amount?, tendered?}], idempotencyKey }` | payment.create | Više delova u jednoj transakciji (mix); `REPRESENTATION` samo ceo račun |
| PUT `/orders/:id/discount` `{ discountId \| null }` | order.write + order.discount | Popust na ceo račun |
| PUT `/orders/:id/buyer` `{ idType, idValue, optionalBasis?, optionalValue? }` | order.write | Kupac; `idType: null` briše |
| PATCH `/orders/:id` `{ tabName }` | order.write | Naziv ture |
| POST `/orders/:id/move-items` `{ itemIds[], toOrderId? \| toTableId?, toTabName? }` | order.write | Stavke na drugu turu / novu turu / drugi sto |
| POST `/orders/:id/merge` `{ fromOrderIds[] }` | order.write | Spajanje tura (izvorne bez naplate → MERGED) |
| POST `/orders/:id/void-all` `{ reason }` | order.write + order.void | Storno celog računa |
| GET/POST `/discounts`, PATCH `/discounts/:id` | order.read / discount.manage | Popusti |
| GET `/fiscal/buyer-codes` | order.read | Šifarnici kupca |
| POST `/orders/transfer` `{ orderIds[], toUserId }` | order.write | Svoje račune; tuđe uz order.transfer; sve-ili-ništa |
| GET `/orders/:id/history` | order.read | Istorija računa iz revizijskog traga |

## Rute — faza 3 (štampa, KDS, fiskalizacija)
| Metoda i putanja | Pravo | Opis |
|---|---|---|
| GET/POST `/printers`, PATCH `/printers/:id` | settings.manage | Štampači (SIMULATED / NETWORK_ESCPOS / WINDOWS_RAW) |
| POST `/printers/:id/test` | settings.manage | Probna strana u red štampe |
| GET `/prep-stations` | catalog.read | Pripremne pozicije |
| POST `/prep-stations`, PATCH `/prep-stations/:id` | settings.manage | Pozicija: štampač, KDS |
| `categories` / `products` polje `prepStationId` | catalog.write | Rutiranje (artikal ima prednost) |
| GET `/devices`, PATCH `/devices/:id/receipt-printer` | settings.manage | Uređaji, štampač računa po kasi |
| POST `/print-bridges`, POST `/print-bridges/:id/rotate-key` | settings.manage | Registracija bridge-a; ključ se vraća samo u odgovoru |
| GET `/print-jobs?status&orderId`, POST `/print-jobs/:id/retry` | settings.manage | Red štampe, ponavljanje neuspelih |
| POST `/orders/:id/print-receipt` `{ idempotencyKey }` | order.read | Račun/predračun na štampač kase; isti ključ = isti zadatak |
| GET `/kds/stations`, GET `/kds/tickets?stationId&view=active\|done` | kds.use | KDS |
| POST `/kds/tickets/:id/status` `{ status }` | kds.use | NEW / IN_PROGRESS / READY / DONE (409 `INVALID_TRANSITION`) |
| POST `/kds/items/:id/ready` `{ ready }` | kds.use | Stavka spremna; sve spremne → kartica READY |
| GET `/fiscal/status` | order.read | Provajder i režim (TEST / DISABLED) |
| GET `/fiscal/receipts?status`, POST `/fiscal/receipts/:id/retry` | settings.manage | Fiskalni red |

`GET /orders/:id` sada vraća i `fiscal` (status, broj, isTest, greška), `kdsTickets` i na stavkama `prepStationName` / `prepStatus`.

### Print Bridge API (zaglavlje `X-Bridge-Key: pb_…`, bez JWT-a)
| Metoda i putanja | Opis |
|---|---|
| POST `/bridge/hello` | Provera ključa, spisak štampača lokala, beleži poslednji kontakt |
| POST `/bridge/jobs/claim` `{ limit? }` | Atomsko preuzimanje (PENDING kome je došlo vreme ili PRINTING sa isteklim zakupom od 60 s) |
| POST `/bridge/jobs/:id/result` `{ status: PRINTED\|SIMULATED\|FAILED, error?, retryable? }` | Samo bridge koji drži zakup (inače 409 `JOB_NOT_CLAIMED`) |

### WebSocket `ws(s)://host/api/v1/ws?token=<JWT>&stationId=<opciono>`
Pristup: aktivni korisnik sa `order.read` ili `kds.use` (provera u bazi pri povezivanju; inače 401). Poruke `{ type, stationId, data, at }`: `kds.ticket.created`, `kds.ticket.updated`, `kds.item.voided`, `order.updated`, `order.prep.updated`, `print.job.created`, `print.job.updated`, `fiscal.updated`. Događaji se šalju **tek posle commit-a**; klijent na tekst „ping“ dobija „pong“. Posle ponovnog povezivanja klijent treba da ponovo učita stanje preko REST-a.

## Rute — faza 4 (robno)
| Metoda i putanja | Pravo | Opis |
|---|---|---|
| GET `/partners?search&includeInactive`, POST, PATCH `/partners/:id` | stock.read / stock.write | Partneri; PIB sa kontrolnom cifrom, jedinstven |
| GET/POST `/warehouses`, PATCH `/warehouses/:id` | stock.read / stock.write | Skladišta; tačno jedno podrazumevano |
| PUT `/prep-stations/:id/warehouse` `{ warehouseId }` | stock.write | Iz kog skladišta pozicija troši |
| GET `/stock/documents?kind&status&warehouseId&partnerId&from&to&page` | stock.read | Lista dokumenata |
| POST `/stock/documents` `{ kind, warehouseId, targetWarehouseId?, partnerId?, docDate?, externalNumber?, note? }` | stock.write | Nacrt |
| GET `/stock/documents/:id`, PATCH `/stock/documents/:id` | stock.read / stock.write | Detalji (stavke, vrednosti, razlike popisa) / izmena zaglavlja nacrta |
| PUT `/stock/documents/:id/lines` `{ lines[{productId, quantity, unitCost?, note?}], expectedVersion? }` | stock.write | Zamena stavki nacrta (422 `INVALID_LINES`, `DUPLICATE_LINE`) |
| POST `/stock/documents/:id/fill-stocktake` | stock.write | Popis: dodaje sve artikle sa zalihom |
| POST `/stock/documents/:id/post` `{ expectedVersion? }` | stock.post | Knjiženje (sve ili ništa); 422 `INSUFFICIENT_STOCK`, `PARTNER_REQUIRED`; ponovljeno → `alreadyPosted: true` |
| POST `/stock/documents/:id/cancel` `{ reason }` | stock.post | Nacrt → odbačen; proknjižen → suprotna kretanja |
| GET `/stock/balances?warehouseId&search&nonZero` | stock.read | Stanje, PPNC, vrednost, minus |
| GET `/stock/card?productId&warehouseId&from&to` | stock.read | Kartica: početno, kretanja, promet, završno |
| GET `/recipes?productId`, POST `/recipes`, PUT `/recipes/:id` | stock.read / stock.write | Normativi (izmena samo nacrta) |
| POST `/recipes/:id/activate`, POST `/recipes/:id/retire` | stock.write | Aktivacija (prethodna → RETIRED) / povlačenje |
| POST `/import/{products\|partners\|document-lines}/preview` `{ fileName, content(base64), documentId? }` | stock.write | Pregled: redovi, akcija (novo/izmena), greške |
| POST `/import/.../commit` `{ …, skipInvalid? }` | stock.write (+ catalog.write za artikle) | Bez `skipInvalid` i sa greškama → 422 `IMPORT_HAS_ERRORS` i ništa se ne upisuje |
| GET `/import/:entity/template?format=csv\|xlsx` | stock.write | Šablon |
| GET `/export/{products\|partners\|stock-balances}?format=csv\|xlsx&warehouseId` | stock.read | Izvoz (CSV: `;`, decimalni zarez, UTF-8 BOM) |

`GET /products` prima i `sellable=true|false` i `trackStock=true`; artikal ima `trackStock`, `isSellable`. Dodavanje sirovine na račun → 422 `PRODUCT_NOT_SELLABLE`.

## Primer: kafa za sto i kombinovana naplata
```bash
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/pin -H 'content-type: application/json' \
  -d '{"deviceId":"<id kase>","pin":"2222"}' | jq -r .accessToken)
H="Authorization: Bearer $TOKEN"
curl -s -X POST localhost:3000/api/v1/shifts/open -H "$H" -H 'content-type: application/json' -d '{"openingCash":"5000.00"}'
ORDER=$(curl -s -X POST localhost:3000/api/v1/orders -H "$H" -H 'content-type: application/json' -d '{}' | jq -r .id)
curl -s -X POST localhost:3000/api/v1/orders/$ORDER/items -H "$H" -H 'content-type: application/json' -d '{"productId":"<id>","quantity":"2"}'
curl -s -X POST localhost:3000/api/v1/orders/$ORDER/payments -H "$H" -H 'content-type: application/json' \
  -d '{"method":"CARD","amount":"200.00","idempotencyKey":"pos1-20261022-0001"}'
curl -s -X POST localhost:3000/api/v1/orders/$ORDER/payments -H "$H" -H 'content-type: application/json' \
  -d '{"method":"CASH","tendered":"500.00","idempotencyKey":"pos1-20261022-0002"}'
```

## Planirano (nije implementirano)
Integracioni API ključevi, webhookovi (`order.created`, `payment.completed`, …) — faza 5, vidi ROADMAP.md.
