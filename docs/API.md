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
| GET `/orders?status&tableId&mine&page&pageSize` | order.read | Konobar vidi samo svoje bez `order.read_all` |
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
| GET `/reports/sales?from&to&waiterId&deviceId` | report.read | Datumi u zoni lokala, uključivo |

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
Integracioni API ključevi, webhookovi (`order.created`, `payment.completed`, …), štampa, KDS, lager i dokumenti — vidi ROADMAP.md.
