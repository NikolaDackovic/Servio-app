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
| Audit log | ✅ (upis); ✅ pregled u UI (Korisnici → Dnevnik aktivnosti, dnevnik promena proizvoda) |

## Faza 2 — Funkcionalna kasa
| Stavka | Stanje |
|---|---|
| Stolovi sa stanjem iz baze | ✅ mapa po prostorijama + spisak; vizuelni editor mape u ADMIN-u (iteracija 5) |
| Otvaranje računa, više računa po stolu, brza prodaja | ✅ |
| Stavke, količine, napomene, snimak cene/poreza | ✅ |
| Slanje u pripremu po turama, bez dupliranja | ✅ |
| Storniranje poslatih stavki sa razlogom i pravom | ✅ |
| Naplata: gotovina/kartica/virman, kombinovano, delimično, kusur | ✅ (TEST režim) |
| Idempotentnost i zaštita od duple naplate | ✅ |
| Blagajnička smena, uplate/isplate, očekivana gotovina, razlika | ✅ |
| Izveštaj prometa (porez, načini plaćanja, proizvodi, konobari, sati, storna) | ✅ |
| Popusti, podela po stavkama, prebacivanje stola/konobara, spajanje stolova | ✅ (iteracija 3) |
| Povraćaj novca / storno zatvorenog računa | ✅ ceo račun ili deo stavki, više puta do prodate količine; gotovina iz blagajne, roba nazad na lager, fiskalno REFUND, 2 primerka (potpis kupca); pravo order.refund |
| Štampa računa i kopije (preko Print Bridge-a) | ✅ (faza 3); ⬜ interni obračun |

## Faza 3 — Štampa, KDS, fiskalizacija
- ✅ Rutiranje: kategorija/proizvod → pripremna pozicija (šank, kuhinja…)
- ✅ `print_jobs` red u bazi (nastaje iz ture slanja u istoj transakciji, jedinstven `dedupe_key` po računu + turi + poziciji)
- 🟡 Print Bridge (Node servis): ESC/POS preko mreže ✅ (lažni TCP štampač u testovima), simulacija ✅, Windows RAW napisan ali **nije testiran na Windowsu**; instalacija kao Windows servis nije proverena — vidi PRINTING.md
- ✅ WebSocket kanal po lokalu/poziciji; KDS ekran sa statusima, zvukom, prikazom prekida veze i ponovnim povezivanjem
- ✅ `FiscalizationProvider` + testni adapter sa jasno vidljivim TEST statusom; ✅ izgled računa po rasporedu Poreske uprave (ćirilica CP1251 ili latinica, QR, refundacija sa potpisom kupca); ✅ ESIR veza ka LPFR/VPFR (API v3, PIN, sertifikat+PAC, prekidač TEST/pravi računi, provera veze) - testirano na simuliranom LPFR-u; ⬜ provera sa pravim LPFR-om, kopija preko PFR-a, sertifikacija ESIR-a

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

## ADMIN — ciljna struktura (zahtev vlasnika, iteracija 6+)
Prijava korisničkim imenom (ili emailom) i lozinkom ✅. Meni po celinama ✅; uvoz/izvoz iz Excel-a za sve tabele gde ima smisla; svaka celina = tabela + dodavanje/izmena u prozoru, isti izgled svuda.

1. **Proizvod**
   - ✅ Proizvod: osnovno (naziv, cena, grupa, ulazni PDV, izlazni PDV, JM: KOM/KG/L), sirovina i normativ, slika, izmene „bez leda…“, minimalna zaliha
   - ✅ Grupe (na kasi; vezane za kategoriju), uvoz/izvoz Excel
   - ✅ Kategorije (najviši nivo: ŠANK, KUHINJA)
   - ✅ Trenutno stanje robe
   - ✅ Stanje robe na dan (početno stanje izabranog dana)
   - ✅ Kartica proizvoda (od-do: prodaja po računima + kretanje zalihe)
   - ✅ Zalihe (crveno ispod minimuma, filter „samo ispod minimuma“)
   - ✅ Štampanje grupa (grupa → štampač po imenu Windows drajvera, širina trake 80/58)
2. **Smena**
   - ✅ Specifikacija pazara po datumu, sa štampom
   - ✅ Spajanje / podela smene (vreme preseka, npr. 05:00; spajanje „Ponedeljak“ + „Ponedeljak1“)
   - ✅ Pregled računa za datum (isečak levo; ko, sto, kreiran/izbačen, komitent/PIB, popust, način plaćanja; storno crveno + razlog)
3. **Korisnici**
   - ✅ Korisnik (ime, prezime, korisničko ime, PIN za kasu, lozinka za ADMIN, uloga, aktivan; uvoz/izvoz Excel), ✅ Uloge, ✅ Prava po ulozi (storno, prebacivanje, rastavljanje, kraj dana, admin…)
4. **Popust i cenovnik**
   - ✅ Popust: procenat, važi za ceo račun, izabrane grupe ili izabrane proizvode
   - ✅ Cenovnik (kopija svih proizvoda: stara cena, nova cena, štikliranje; izaberi/obriši sve; promena ručno, ±% ili ±RSD uz zaokruživanje, ručna izmena pojedinačno); kasa: „Postavi cenovnik“ (uz šifru kasira/menadžera) i natpis u donjem uglu samo kada postoji
   - ✅ Happy hour (od-do datum, vreme, dani u nedelji, grupa ili proizvod, nova cena ili popust %)
   - ✅ Dokumenta: ulazna faktura (UF) i ostala robna dokumenta; popis se knjiži samo na zatvorenu smenu (stanje za sutra)
5. **Štampanje**
   - ✅ Izgled porudžbine i fiskalnog isečka (logo kao raster, tekst na vrhu i kraju, velika/normalna slova); LPFR ili VPFR po kasi; prekidač TEST / pravi računi u podešavanjima kase
6. **Mape stolova**
   - ✅ prostorije, stolovi (pozicija, veličina, oblik), slika pozadine prostorije, boja stola
7. **Podešavanja**
   - 🟡 Kasa: šifra za svaki sto ✅, čuvar ekrana ✅ · Računari ✅ (po kasi: naziv, cenovnik, grupe koje se vide, prikaz funkcija/dugmadi, novi računar) · ⬜ Android telefoni (kao zasebna aplikacija)

## Instalirana kasa
- ✅ Windows instalacija (POS-Kasa-Setup.exe): ugrađeni PostgreSQL, server i kasa u jednom programu, pali se sa Windows-om, prvo pokretanje (firma i administrator ili demo), ADMIN /admin i KDS /kds preko mreže lokala
- ✅ Automatska rezervna kopija baze (pri pokretanju i gašenju, 7 kopija, dodatni folder); ⬜ ikonica i potpisan .exe (sertifikat), kasa kao Windows servis (radi i bez prijavljenog korisnika), automatsko ažuriranje

## Sledeći konkretan korak (iteracija 6)
1. Provera Print Bridge-a na Windowsu sa stvarnim mrežnim i USB termalnim štampačem; instalacioni paket (NSSM/servis).
2. Faza 5: API ključevi za integracije, webhookovi (outbox, HMAC potpis, retry).
3. Fiskalizacija: proučiti važeći Tehnički vodič PU i izabrati put (sertifikovani ESIR partner ili sopstvena sertifikacija) — tek tada LIVE provajder.

## Najveći rizici
| Rizik | Ublažavanje |
|---|---|
| Fiskalizacija (sertifikacija, PFR integracija) | Rana apstrakcija + testni adapter; provera aktuelnog tehničkog vodiča PU pre implementacije |
| Raznolikost štampača | Adapteri + procedura provere kompatibilnosti; bez obećanja "univerzalne" podrške |
| Hibridni rad | Odložen dok kasa nije stabilna; UUID i idempotentnost već sada |
| Obim | Vertikalni tokovi sa testovima, ne paralelni nedovršeni ekrani |

## Lakši unos (ADMIN)
- ✅ Početna: promet dana, šta traži pažnju, brze radnje, kontrolna lista za otvaranje lokala
- ✅ Ctrl+K pretraga svih stranica (sa sinonimima: faktura, PIN, štampač…)
- ✅ Proizvod: „Sačuvaj i novi“, pamti grupu/PDV/JM; podrazumevani PDV = opšta stopa
- ✅ Grupna izmena: cena ± %/din sa zaokruživanjem, premeštanje u grupu, uključi/isključi (pregled pre primene)
- ✅ Dokumenta: predlog poslednje nabavne cene, Enter/barkod u pretrazi, novi artikal i novi dobavljač bez napuštanja dokumenta, Proknjiži/Štampaj sami čuvaju, Ctrl+S
- ✅ Uputstvo u ADMIN-u (kasa, ADMIN, KDS, instalacija) sa slikama ekrana, dugme „?“ po stranici, pretraga, štampa; slike: `scripts/help-shots.mjs` + `apps/api/scripts/demo-server.ts`
- ✅ Uvoz artikala iz drugog programa: više naziva kolona (MPC, Naziv artikla…), PDV kao stopa (20%), „Napravi grupe koje ne postoje“
- ✅ Predlog narudžbine po dobavljaču (potrošnja × dani ili minimalna zaliha), nacrt ulazne fakture ili tekst za Viber/SMS jednim klikom
- ⬜ Probni rad na pravom hardveru (Bixolon, LPFR, dve kase u mreži)

## Lokal: nalozi, kartice, QR
- ✅ Podrazumevani nalozi u svakoj novoj bazi: ADMIN/0000 (ADMIN i kasa), KON01/11, KON02/22, tv/tv (KDS); upozorenje na Početnoj dok je ADMIN 0000
- ✅ Prijava karticom (čitač kao tastatura): kasa, sto, storno, kraj dana; dodela/uklanjanje u ADMIN → Korisnici
- ✅ QR naručivanje: meni na telefonu gosta (/m/<kod>), porudžbina u šank/kuhinju i na račun stola, obaveštenje na kasi, konobar preuzima i naplaćuje; štampa QR kodova (A4), novi kod po stolu, uključi/isključi
- ⬜ QR naručivanje van Wi-Fi mreže lokala (javna adresa / domen)
