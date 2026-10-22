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
| Popusti, podela po stavkama, prebacivanje stola/konobara, spajanje stolova | ✅ (iteracija 3) |
| Povraćaj novca / storno zatvorenog računa | ⬜ |
| Štampa računa i kopije (preko Print Bridge-a) | ✅ (faza 3); ⬜ interni obračun |

## Faza 3 — Štampa, KDS, fiskalizacija
- ✅ Rutiranje: kategorija/proizvod → pripremna pozicija (šank, kuhinja…)
- ✅ `print_jobs` red u bazi (nastaje iz ture slanja u istoj transakciji, jedinstven `dedupe_key` po računu + turi + poziciji)
- 🟡 Print Bridge (Node servis): ESC/POS preko mreže ✅ (lažni TCP štampač u testovima), simulacija ✅, Windows RAW napisan ali **nije testiran na Windowsu**; instalacija kao Windows servis nije proverena — vidi PRINTING.md
- ✅ WebSocket kanal po lokalu/poziciji; KDS ekran sa statusima, zvukom, prikazom prekida veze i ponovnim povezivanjem
- ✅ `FiscalizationProvider` + testni adapter sa jasno vidljivim TEST statusom; ⬜ stvarna PFR/ESIR integracija

## Faza 4 — Backoffice i lager
- ✅ Partneri; ulazni/izlazni dokumenti sa statusima nacrt → proknjižen → storniran
- ✅ Skladišta, kartica artikla, prosečna ponderisana nabavna cena
- ✅ Normativi sa verzijama, automatski utrošak (idempotentno po stavci)
- ✅ Popis, otpis, prenosi, interna potrošnja, povrat; uvoz/izvoz CSV/XLSX sa pregledom i izveštajem grešaka
- ⬜ Nivelacija/promena prodajnih cena kao dokument, kalkulacija (marža, RUC), knjiga KEPU, PDF dokumenata

## Faza 5 — API i integracije
- 🟡 REST `/api/v1`, Swagger, standardne greške, paginacija (urađeno za postojeće resurse)
- ⬜ API ključevi za integracije, opoziv, dozvole po ključu, evidencija poziva
- ⬜ Webhookovi: outbox, potpis (HMAC + timestamp), retry sa backoff-om, ponovno slanje

## Faza 6 — Mobilni rad
- 🟡 Responsive UI i PWA manifest (radi na telefonu, provereno na 390 px)
- ⬜ Service worker / offline keš, izbor stola optimizovan za jednu ruku, status pripreme

## Faza 7 — Napredno
- ⬜ Više lokala u UI, hibridna sinhronizacija (strategija u ARCHITECTURE.md), dostava, loyalty, kiosk, QR meni

## Sledeći konkretan korak (iteracija 5)
1. Zaposleni i uloge kroz ADMIN (PIN, lozinka, deaktivacija, dodela prava).
2. Provera Print Bridge-a na Windowsu sa stvarnim mrežnim i USB termalnim štampačem; instalacioni paket (NSSM/servis).
3. Faza 5: API ključevi za integracije, webhookovi (outbox, HMAC potpis, retry).
4. Fiskalizacija: proučiti važeći Tehnički vodič PU i izabrati put (sertifikovani ESIR partner ili sopstvena sertifikacija) — tek tada LIVE provajder.
5. Povraćaj novca / storno naplaćenog računa (uz fiskalnu refundaciju i povrat robe na lager).

## Najveći rizici
| Rizik | Ublažavanje |
|---|---|
| Fiskalizacija (sertifikacija, PFR integracija) | Rana apstrakcija + testni adapter; provera aktuelnog tehničkog vodiča PU pre implementacije |
| Raznolikost štampača | Adapteri + procedura provere kompatibilnosti; bez obećanja "univerzalne" podrške |
| Hibridni rad | Odložen dok kasa nije stabilna; UUID i idempotentnost već sada |
| Obim | Vertikalni tokovi sa testovima, ne paralelni nedovršeni ekrani |
