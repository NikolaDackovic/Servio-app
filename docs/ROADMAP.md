# Plan razvoja

Legenda: ✅ urađeno i pokriveno testom · 🟡 delimično · ⬜ nije započeto

## Faza 1 — Temelj sistema
| Stavka | Stanje |
|---|---|
| Monorepo, TypeScript, NestJS, React/Vite | ✅ |
| PostgreSQL šema, SQL migracije, CHECK ograničenja | ✅ |
| Organizacije, lokali, uređaji | ✅ (model + seed; nema UI za administraciju) |
| Prijava lozinkom i PIN-om, JWT, ograničenje pokušaja | ✅ |
| Uloge i prava, provera na backendu | ✅ |
| Upravljanje zaposlenima i ulogama kroz UI/API | ⬜ (sada samo seed) |
| Kategorije i proizvodi (CRUD, istorija cena) | ✅ |
| Audit log | ✅ (upis); ⬜ pregled u UI |

## Faza 2 — Funkcionalna kasa
| Stavka | Stanje |
|---|---|
| Stolovi sa stanjem iz baze | ✅ (lista po prostoriji; ⬜ vizuelni editor mape) |
| Otvaranje računa, više računa po stolu, brza prodaja | ✅ |
| Stavke, količine, napomene, snimak cene/poreza | ✅ |
| Slanje u pripremu po turama, bez dupliranja | ✅ |
| Storniranje poslatih stavki sa razlogom i pravom | ✅ |
| Naplata: gotovina/kartica/virman, kombinovano, delimično, kusur | ✅ (TEST režim) |
| Idempotentnost i zaštita od duple naplate | ✅ |
| Blagajnička smena, uplate/isplate, očekivana gotovina, razlika | ✅ |
| Izveštaj prometa (porez, načini plaćanja, proizvodi, konobari, sati, storna) | ✅ |
| Popusti, podela po stavkama, prebacivanje stola/konobara, spajanje stolova | ⬜ |
| Povraćaj novca / storno zatvorenog računa | ⬜ |
| Ponovna štampa, interni obračun | ⬜ (zavisi od faze 3) |

## Faza 3 — Štampa, KDS, fiskalizacija
- ⬜ Rutiranje: kategorija/proizvod → pripremna pozicija (šank, kuhinja…)
- ⬜ `print_jobs` red u bazi (nastaje iz ture slanja, idempotentno po `order_id + batch + station`)
- ⬜ Print Bridge (Windows servis) — vidi PRINTING.md
- ⬜ WebSocket kanal po lokalu/stanici; KDS ekran sa statusima, zvukom, prikazom prekida veze
- ⬜ `FiscalizationProvider` + testni adapter sa jasno vidljivim TEST statusom

## Faza 4 — Backoffice i lager
- ⬜ Partneri; ulazni/izlazni dokumenti sa statusima nacrt → proknjižen → storniran
- ⬜ Skladišta, kartica artikla, prosečna ponderisana nabavna cena
- ⬜ Normativi sa verzijama, automatski utrošak (idempotentno po stavci)
- ⬜ Popis, otpis, prenosi; uvoz/izvoz CSV/XLSX sa pregledom i izveštajem grešaka

## Faza 5 — API i integracije
- 🟡 REST `/api/v1`, Swagger, standardne greške, paginacija (urađeno za postojeće resurse)
- ⬜ API ključevi za integracije, opoziv, dozvole po ključu, evidencija poziva
- ⬜ Webhookovi: outbox, potpis (HMAC + timestamp), retry sa backoff-om, ponovno slanje

## Faza 6 — Mobilni rad
- 🟡 Responsive UI i PWA manifest (radi na telefonu, provereno na 390 px)
- ⬜ Service worker / offline keš, izbor stola optimizovan za jednu ruku, status pripreme

## Faza 7 — Napredno
- ⬜ Više lokala u UI, hibridna sinhronizacija (strategija u ARCHITECTURE.md), dostava, loyalty, kiosk, QR meni

## Sledeći konkretan korak (iteracija 3 — ADMIN: robno)
1. Dobavljači, skladišta, ulazni dokument (nacrt → proknjižen → storniran), kartica artikla, prosečna nabavna cena.
2. Normativi sa verzijama i automatski utrošak pri prodaji (idempotentno po stavci).
3. Zaposleni i uloge kroz ADMIN (PIN, lozinka, deaktivacija).
4. Popusti, premeštanje računa na drugi sto, podela računa po stavkama.

## Posle toga (štampa i KDS)
1. Pripremne pozicije + rutiranje + `print_jobs` (tabela, migracija, servis, testovi).
2. WebSocket gateway + KDS ekran (prijem ture, statusi stavki, prikaz prekida veze).
3. Print Bridge v0: Node servis za Windows sa ESC/POS preko mreže (TCP 9100) i Windows spooler adapterom, testni (SIMULATED) adapter, red i retry.
4. Testovi za scenarije B i E iz specifikacije.

## Najveći rizici
| Rizik | Ublažavanje |
|---|---|
| Fiskalizacija (sertifikacija, PFR integracija) | Rana apstrakcija + testni adapter; provera aktuelnog tehničkog vodiča PU pre implementacije |
| Raznolikost štampača | Adapteri + procedura provere kompatibilnosti; bez obećanja "univerzalne" podrške |
| Hibridni rad | Odložen dok kasa nije stabilna; UUID i idempotentnost već sada |
| Obim | Vertikalni tokovi sa testovima, ne paralelni nedovršeni ekrani |
