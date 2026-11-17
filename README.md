# Servio - kasa za ugostiteljstvo i hotele

Modularni POS sistem: kasa, backoffice, KDS, štampa (Print Bridge), lager i (uskoro) integracije. Backend NestJS + PostgreSQL (Drizzle), frontend React + Vite.

**Status: iteracija 4 — faze 3 i 4: štampa i KDS, fiskalni red sa TEST adapterom, lager (dokumenta, PPNC, kartica, normativi, automatski utrošak, popis, uvoz/izvoz).** Naplata je isključivo u **TEST režimu**, a fiskalizacija postoji samo kao **testni adapter**: nijedan račun nije fiskalni i aplikacija to piše svuda (kasa, ADMIN, odštampan račun). Nije za produkcionu upotrebu u lokalu.

## Brzi start
Preduslovi: Node.js 20.12+ i PostgreSQL 16 sa korisnikom `pos` i bazama `pos` i `pos_test` (vidi [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#windows--razvoj)).

Komande su u zasebnim redovima, pa rade i u Windows PowerShell 5 (koji ne podržava `&&`):
```
npm install
cp apps/api/.env.example apps/api/.env
npm run db:migrate
npm run db:seed
npm run dev:api      # API     :3000  (Swagger: http://localhost:3000/api/docs)
npm run dev:web      # KASA    :5173  (drugi terminal)
npm run dev:admin    # ADMIN   :5174  (treći terminal)
npm run dev:bridge   # Print Bridge (četvrti terminal; ključ iz seed-a u apps/print-bridge/.env)
npm test             # 178 testova API + 14 Print Bridge (uklj. LPFR prema simuliranom PFR-u)
```
**Instalirana kasa (Windows):** `npm run dist:kasa` pravi `apps/desktop/release/POS-Kasa-Setup-<verzija>.exe` - program sa sopstvenom bazom i serverom, radi bez interneta; ADMIN i KDS preko mreže lokala. Uputstvo: [docs/INSTALACIJA.md](docs/INSTALACIJA.md).

**Aplikacije u razvoju (isti API i baza; http://localhost:3000 prikazuje linkove):**
- **KASA** (http://localhost:5173) — samo kucanje i računi; kasa lokala se prepoznaje sama, prijava PIN-om: 2222 (kasir), 1111 (konobar), 9999 (menadžer). Posle 5 pogrešnih PIN-ova kasa se zaključava na 60 s.
- **ADMIN** (http://localhost:5174) — artikli i cene, kalendar dana, računi, izveštaji, lager, štampa i KDS, fiskalizacija. Prijava: `admin@demo.local` ili `menadzer@demo.local`, lozinka `s`. Tamna tema (☀ gore desno za svetlu); sve tabele imaju red za filtere ispod naslova kolona.
- **KDS** (http://localhost:5173/kds) — ekran kuhinje i šanka; prepoznaje KDS uređaj lokala sam, PIN 3333. Kartice iz zatvorenih smena se ne prikazuju. Dodir na stavku je precrtava, dodir na zaglavlje kartice je sklanja (vraća se iz „Završene“). ⚙ Podešavanja ekrana (čuvaju se na tom uređaju): kartice u boji statusa ili klasične, kategorije i grupe koje se prikazuju, tamna/svetla pozadina, veličina slova, kolone, redosled (po redovima ili kolonama), tajmer za žutu/crvenu boju, zvuk.

**Demo nalozi su samo za razvoj.**

## Šta radi
**Kasa:**
- Poslovni dan: otvaranje, zaključak dana (samo bez otvorenih računa i kasa), promet posle ponoći ostaje u danu
- Smena konobara: specifikacija pazara po načinu plaćanja, prebacivanje otvorenih stolova drugom konobaru, kraj smene
- Izgled klasične touch kase: mapa stolova (drveni pod, stolovi kao pločice sa konobarom i iznosom, plavi tabovi prostorija + SPISAK), kolona akcija desno (Novi račun F1, Pregled računa F2, Presek stanja, Prodati artikli, Kraj dana, Smena, Cenovnik, Osveži F5)
- Prijava na kasu samo PIN-om (kasa jedinog lokala se sama prepoznaje); smena, storno, pregled računa i količina preko male iskačuće tastature
- Smena: otvaranje PIN-om uz datum i naziv (Petak, Petak1…), bez unosa gotovine; zatvaranje uz „Da li ste sigurni?“ zatvara i dan, i nije moguće dok postoji nenaplaćen sto
- Šifra konobara za svaki sto i brzi račun (ADMIN → Podešavanja → Kasa); sto se otvara kao konobar čija je šifra
- Na stolu: GOTOVINA (mali kalkulator), KARTICA, PREBACIVANJE i STORNIRANJE sa količinama po stavci (numerička tastatura, Izaberi sve / Poništi); prebacivanje dalje bira sto na mapi i traži šifru (svoju ili drugog konobara)
- Kraj dana: Razduživanje (pazar svih zaposlenih, štampa svakome), Prodaja — Šank i Prodaja — Kuhinja (artikli za ceo dan po količini)
- Prebacivanje: ceo sto na drugi sto, pojedini artikli na drugi sto / novu turu, uz opcioni PIN drugog konobara (prelazak u njegov reon)
- Polje iznad računa: `*espresso` traži artikle, običan tekst + Enter je napomena (izmena) na stavci za bon u pripremi; artikli sa izmenama iz ADMIN-a (bez leda, bez voća…) otvaraju veliki prozor odmah po kucanju
- Naplata: popusti levo, iznos sa „čovečuljkom“ (kupac: PIB, JMBG…) desno; gotovina/miks otvaraju mali kalkulator (račun / dao / kusur), kartica/virman/reprezentacija se naplaćuju odmah
- Pregled računa (PIN): svi računi dana u jednoj listi (status u koloni, storno crveno), desno sve što je bilo na izabranom stolu (stornirano precrtano); Presek stanja / pazar (crno-bela tabela, štampa, razduživanje), Prodati artikli; dole Prebacivanje, Storniranje (uz PIN ovlašćenog), Prebaci sve otvorene stolove, Otvori sto
- Ekran kucanja: sjajne pločice kategorija (BRZI = najčešće kucani na toj kasi, SVI), bele pločice artikala sa slikom i cenom; račun desno (nova porudžbina gore, „Na stolu do sada“ ispod, crvena traka = iznos nove porudžbine); dugmad + / − / Obriši stavku / Obriši sve / Sačuvaj i novi / Sačuvaj / Unesi količinu (i pre izbora artikla) / Zatvori; F9 naplata
- Pregled računa uz PIN (konobar vidi svoje, admin/menadžer/kasir sve) sa stavkama, plaćanjima, porezom i istorijom izmena
- Ture (podračuni) na istom stolu, prebacivanje izabranih stavki na drugu turu ili sto, spajanje tura, predaja računa konobaru, storno celog računa
- Napomena za stavku direktno u desnom panelu (brze napomene: bez leda, bez šećera…)
- Naplata: popusti iz ADMIN-a, gotovina, kartica, mix, virman, reprezentacija; kupac na računu (PIB, JMBG, diplomatska… — docs/FISCAL.md)
- Panel desno: Novi račun (F1), Pregled računa (F2), Moja smena, Cenovnik, Otvaranje/Zatvaranje smene, Osveži (F5), Ceo ekran; dole datum dana i cenovnik

**Štampa i KDS (faza 3):**
- Pripremne pozicije (šank, kuhinja…) i rutiranje kategorija/artikala; tura slanja pravi KDS kartice i zadatke štampe u istoj transakciji, bez duplikata
- Print Bridge (`apps/print-bridge`): ESC/POS preko mreže, simulacija, Windows RAW (nije testiran na Windowsu); ponovni pokušaji, zakup, oporavak posle pada
- KDS ekran: kartice po poziciji, boje po čekanju, zvuk, stavka/kartica spremna, završene, upozorenje na prekid veze i ponovno povezivanje; kasa vidi status pripreme u realnom vremenu (WebSocket)
- Štampa računa/predračuna i kopije; fiskalni red sa TEST adapterom (status, ponovni pokušaji, ručno ponavljanje)

**Lager (faza 4, ADMIN):**
- Partneri (PIB sa kontrolnom cifrom), skladišta, sirovine (ne prodaju se na kasi)
- Robna dokumenta: prijemnica, izlaz, povrat, prenos, otpis, interna potrošnja, popis — nacrt → proknjižen → storniran (suprotna kretanja)
- Prosečna ponderisana nabavna cena, stanje sa vrednošću, kartica artikla sa stanjem posle svakog kretanja
- Normativi sa verzijama; automatski utrošak pri naplati (idempotentno po stavci), iz skladišta pozicije
- Uvoz CSV/XLSX (artikli, partneri, stavke dokumenta) sa pregledom, greškama po redovima i izveštajem; izvoz CSV/XLSX

**Admin:** kalendar poslovnih dana, detalji dana (porez, kase, smene zaposlenih, popusti), računi dana, izveštaj prometa, artikli i cene (slika artikla, boja i redosled kategorija), popusti, **mapa stolova** (prostorije, prevlačenje, veličina, oblik, dodavanje/brisanje stolova), lager, štampa i KDS, fiskalizacija.

**Osnova (iteracija 1):**
- Prijava lozinkom i PIN-om na registrovanoj kasi; uloge i prava provereni na backendu
- Kategorije i proizvodi (šifra, barkod, PDV stopa, istorija cena)
- Stolovi sa stanjem iz baze, više računa po stolu, brza prodaja
- Stavke, količine, napomene; slanje u pripremu po turama bez dupliranja
- Storniranje poslatih stavki uz razlog i pravo; revizijski trag
- Naplata gotovinom/karticom/virmanom, kombinovano i delimično, kusur; zaštita od duple naplate
- Blagajnička smena, uplate/isplate, očekivana gotovina i razlika
- Izveštaj prometa: porez, načini plaćanja, proizvodi, zaposleni, sati, storna
- Responsive interfejs (touch kasa, telefon), svetla/tamna tema po sistemu

## Šta još ne radi
Fiskalizacija prema stvarnom LPFR/VPFR uređaju nije proverena (veza je urađena po Tehničkom vodiču i testirana na simuliranom LPFR-u, ESIR nije sertifikovan - vidi docs/FISCAL.md). Upravljanje zaposlenima, kalkulacija/nivelacija/PDF dokumenata, API ključevi i webhookovi, offline/hibridni rad. Print Bridge nije proveren na Windowsu ni sa stvarnim štampačem. Plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## Dokumentacija
[Arhitektura](docs/ARCHITECTURE.md) · [Plan](docs/ROADMAP.md) · [Baza](docs/DATABASE.md) · [API](docs/API.md) · [Štampa](docs/PRINTING.md) · [Instalacija](docs/DEPLOYMENT.md) · [Testiranje](docs/TESTING.md) · [Kupac i plaćanja](docs/FISCAL.md)
