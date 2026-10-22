# Arhitektura

## Pregled

Modularni monolit: jedan backend proces sa jasno odvojenim poslovnim modulima, jedna PostgreSQL baza, više klijenata koji koriste isti verzionisani REST API:
- **KASA** (`apps/web`, port 5173 / 8080) — touch aplikacija samo za kucanje, naplatu, smene i dan.
- **ADMIN** (`apps/admin`, port 5174 / 8081) — backoffice: artikli, kalendar, računi, izveštaji; levi meni, prijava lozinkom.
- Kasnije: KDS, mobilni konobar. Prava se proveravaju na API-ju, pa podela na aplikacije nije bezbednosna granica već radna.

```
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │ Kasa (touch) │  │  Backoffice  │  │ Mobilni (PWA)│  │ KDS ekran    │   apps/web (React + Vite)
 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
        └─────────── HTTPS /api/v1 (REST) ──┴──── WebSocket (iter. 2) ┘
                                   │
 ┌─────────────────────────────────▼──────────────────────────────────┐
 │ apps/api (NestJS)                                                   │
 │  auth · catalog · tables · orders · payments · shifts · reports     │
 │  [iter. 2+] printing · kds · inventory · documents · webhooks · fiscal
 │  Zajedničko: AuthGuard (prava iz baze), audit, decimalni novac,     │
 │  standardizovane greške, request-id                                 │
 └─────────────────────────────────┬──────────────────────────────────┘
                                   │ transakcije, FOR UPDATE, CHECK
                           ┌───────▼────────┐
                           │  PostgreSQL 16 │
                           └────────────────┘
 ┌───────────────────────────┐
 │ Print Bridge (Windows)    │  lokalni servis u objektu — vidi PRINTING.md (iter. 2)
 └───────────────────────────┘
```

## Struktura repozitorijuma

```
apps/api          NestJS backend
  src/db          šema (Drizzle), konekcija, migrator, seed (DEMO)
  src/common      auth/prava, audit, novac, greške, request-id, bezbednost
  src/modules     auth, catalog, tables, shifts (kasa), day (poslovni dan, smene zaposlenih), orders, reports, health
  migrations      SQL migracije (u repozitorijumu, pregledne)
  test/unit       čista poslovna logika
  test/e2e        integracioni testovi kroz HTTP nad pravom PostgreSQL bazom
apps/web          KASA: React + Vite + TypeScript (touch, PWA manifest); deli komponente sa adminom
apps/admin        ADMIN/backoffice: React + Vite, koristi zajedničke komponente iz apps/web/src (@shared)
docs              arhitektura, plan, baza, API, štampa, instalacija, testiranje
```

## Ključne odluke (ADR)

### ADR-001: Modularni monolit umesto mikroservisa
Jedna baza i jedan proces daju ACID transakcije preko porudžbine, plaćanja, lagera i revizijskog traga — što je u POS-u važnije od nezavisnog skaliranja. Moduli komuniciraju kroz servise, ne kroz tabele drugih modula; kasnije izdvajanje (npr. webhook dispečer) ide preko outbox tabele.

### ADR-002: Drizzle ORM umesto Prisme
Specifikacija je predlagala Prismu. U razvojnom okruženju Prisma (i verzija 7) nije mogla da radi jer zahteva preuzimanje binarnog schema-engine-a sa njihovog servera. To je ukazalo na realan rizik i za instalacije u lokalu: offline instalacija, Windows, restriktivni firewall. Drizzle je čist TypeScript, migracije su obični SQL fajlovi u repozitorijumu (lako za pregled i za rukom pisane delove — CHECK ograničenja, parcijalni indeksi), a zaključavanje (`FOR UPDATE`) i sirovi SQL za izveštaje su prvoklasni. Cena: manje "magije" pri relacionim upitima — prihvatljivo.

### ADR-003: Novac kao decimalni string od baze do UI-ja
`numeric(14,2)` u bazi, drajver ga vraća kao string (parser za OID 1700), aritmetika ide kroz `decimal.js` (backend) ili cele pare kao `BigInt` (frontend). JS `number` se nigde ne koristi za novac. Detalji zaokruživanja: DATABASE.md.

### ADR-004: Prava se proveravaju na backendu pri svakom zahtevu
JWT nosi samo identitet i kontekst (korisnik, organizacija, lokal, uređaj). Uloga i prava se čitaju iz baze pri svakom zahtevu — deaktivacija naloga i promena prava deluju odmah. UI sakriva dugmad samo radi preglednosti.

### ADR-005: Konkurentnost porudžbina
Svaka izmena porudžbine: transakcija → `SELECT ... FOR UPDATE` na redu porudžbine → izmena → preračun iznosa iz stavki u bazi → `version + 1`. Klijent može poslati `expectedVersion`; neslaganje vraća `409 STALE_ORDER` (dva konobara na istom stolu ne prepisuju jedan drugog). Naplata dodatno koristi idempotency ključ (jedinstven indeks `(order_id, idempotency_key)`).

### ADR-006: Fiskalizacija iza apstrakcije (iteracija 3)
`FiscalizationProvider` interfejs (izdavanje, status, provera, retry) sa implementacijama po pružaocu (L-PFR/V-PFR). Interna porudžbina, komercijalni obračun i fiskalni račun su različiti entiteti. Račun se nikad ne prikazuje kao fiskalizovan bez potvrde provajdera. **Trenutno stanje: nije implementirano**; health endpoint vraća `fiscalization: NOT_CONFIGURED`, sva plaćanja su `mode = TEST`.

## Režimi rada

| Režim | Stanje |
|---|---|
| Lokalna instalacija (server + baza u lokalu) | Radi (Node + PostgreSQL ili Docker Compose) |
| Centralni server | Arhitektura podržava (sve je HTTP + org/lokal kontekst); nije postavljeno produkciono okruženje |
| Hibridni (offline kasa + sinhronizacija) | **Nije implementirano** — strategija ispod |

### Strategija za hibridni rad (plan, faza 7)
- **Identifikatori**: UUID generisan na izvoru (već sada) — nema kolizija pri spajanju.
- **Numeracija**: brojač po lokalu + uređaju (`document_counters` već ima `kind`; dodaće se prefiks uređaja), tako da offline kase ne dele isti niz.
- **Red događaja (outbox)**: svaka lokalna promena upisuje događaj u istoj transakciji; sinhronizator ga šalje centralnom serveru sa idempotency ključem = id događaja → ponavljanje je bezbedno.
- **Konflikti**: porudžbina ima jednog "vlasnika" (lokalni server lokala); centralni server prihvata, ne menja operativne podatke. Katalog/cene teku obrnuto (centrala → lokal) sa verzijama.
- **Dupli računi**: sprečeni idempotency ključem plaćanja i jedinstvenim brojem po uređaju.
- **Oporavak**: sinhronizator pamti poslednji potvrđeni događaj; posle prekida nastavlja odatle.

## Bezbednost (trenutno)
- Lozinke i PIN-ovi: bcrypt (12 rundi). PIN pretraga preko HMAC(pin, PIN_PEPPER) — sam PIN se ne čuva.
- Helmet zaglavlja, CORS lista, validacija svih ulaza (`whitelist` + `forbidNonWhitelisted`), ograničenje pokušaja prijave (10/min).
- Izolacija: svaki upit je filtriran po organizaciji/lokalu iz tokena; tuđi lokal/organizacija vraća 404/401.
- Audit log u istoj transakciji kao promena; tajne se ne upisuju u logove.
- Request-ID u svakom odgovoru i grešci (`X-Request-Id`).

### ADR-007: Poslovni dan i smena zaposlenog (iteracija 2)
- **Poslovni dan** (`business_days`): najviše jedan otvoren po lokalu (parcijalni jedinstveni indeks). Računi, plaćanja i kase nose `business_day_id`, pa promet posle ponoći pripada danu, a ne kalendarskom datumu. Zaključak je moguć samo bez otvorenih računa i otvorenih kasa; čuva snimak obračuna.
- **Smena kase** (`cash_shifts`, gotovina po uređaju) i **smena zaposlenog** (`staff_shifts`, pazar po konobaru) su namerno odvojene: na jednoj kasi radi više konobara, a konobar može naplaćivati i na telefonu.
- Smena zaposlenog počinje prvom radnjom (otvaranje računa / naplata), ne prijavom. Plaćanje nosi `staff_shift_id`, pa je specifikacija pazara tačna i kada konobar preuzme tuđ sto.
- Kraj smene je moguć tek kada na zaposlenom nema otvorenih računa — prebacuju se drugom (`POST /orders/transfer`, sve-ili-ništa, zaključavanje u stalnom redosledu).

### ADR-008: Print Bridge preuzima zadatke odlaznim HTTP pozivima (polling), ne preko WebSocket-a
- **Odluka**: bridge na 1,5 s poziva `POST /bridge/jobs/claim` (atomski zakup `FOR UPDATE SKIP LOCKED`, istek 60 s) i javlja rezultat. Prijava ključem uređaja (`X-Bridge-Key`, u bazi samo SHA-256).
- **Zašto**: radi kroz bilo koji ruter/proxy bez otvaranja porta u lokalu; posle pada bridge-a ili servera ništa se ne gubi (stanje je u bazi); jednostavno za testiranje. Kašnjenje ≤ 1,5 s je prihvatljivo za kuhinjski blok.
- **Cena**: stalni mali saobraćaj; moguće dvostruko štampanje ako se rezultat izgubi posle uspešne štampe (svesno: bolje nego izgubljen blok).

### ADR-009: Događaji u realnom vremenu samo posle commit-a; WebSocket je obaveštenje, REST je izvor istine
- **Odluka**: servisi skupljaju događaje u transakciji i objavljuju ih posle commit-a (`EventBus`); klijent posle ponovnog povezivanja ponovo učitava stanje. Jedan proces = jedan `EventBus` u memoriji.
- **Cena**: više API procesa zahteva deljeni kanal (npr. PostgreSQL `LISTEN/NOTIFY` ili Redis) — nije urađeno.

### ADR-010: Fiskalni red odvojen od naplate
- **Odluka**: zahtev nastaje u transakciji naplate, šalje se posle commit-a (čeka se najviše 5 s), ponovni pokušaji u pozadini. Naplata nikad ne čeka niti pada zbog fiskalnog sistema; račun je „fiskalizovan“ samo uz potvrđen odgovor stvarnog provajdera.

### ADR-011: Lager kao nepromenljiva kartica + stanje
- **Odluka**: svako kretanje je red u `stock_movements` (nikad se ne menja ni briše; storno = suprotno kretanje), a `stock_balances` je keš stanja koji menja samo jedna funkcija, u istoj transakciji, uz zaključavanje u stalnom redosledu. PPNC se računa pri svakom ulazu.
- **Zašto**: revizija i kartica artikla bez rekonstrukcije; konkurentni izlazi ne mogu da „prođu“ istovremeno preko stanja (test).
- **Pravilo**: prodaja sme u minus (roba je izdata), ručna dokumenta i storno ne smeju.
