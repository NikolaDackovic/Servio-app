# POS platforma za ugostiteljstvo

Modularni POS sistem: kasa, backoffice, (uskoro) KDS, štampa, lager i integracije. Backend NestJS + PostgreSQL (Drizzle), frontend React + Vite.

**Status: iteracija 3 — kasa: ture na stolu, prebacivanje i spajanje, napomene, nova naplata (popusti, kupac/PIB, mix, reprezentacija), pregled računa uz PIN.** Naplata je isključivo u **TEST režimu**: nema platnog terminala ni fiskalizacije, i aplikacija to jasno prikazuje. Nije za produkcionu upotrebu u lokalu.

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
npm test             # 58 testova
```
**Dve aplikacije, isti API i baza:**
- **KASA** (http://localhost:5173) — samo kucanje i računi. Prvi put: `admin@demo.local` / `Demo123!` → izbor kase → zatim PIN 2222 (kasir), 1111 (konobar), 9999 (menadžer).
- **ADMIN** (http://localhost:5174) — artikli i cene, kalendar dana, računi, izveštaji. Prijava: `admin@demo.local` ili `menadzer@demo.local`, lozinka `Demo123!`.

**Demo nalozi su samo za razvoj.**

## Šta radi
**Kasa:**
- Poslovni dan: otvaranje, zaključak dana (samo bez otvorenih računa i kasa), promet posle ponoći ostaje u danu
- Smena konobara: specifikacija pazara po načinu plaćanja, prebacivanje otvorenih stolova drugom konobaru, kraj smene
- Mapa stolova po prostorijama, ekran kucanja (kategorije, artikli, izbor stavke, +1/−1/količina/napomena/storno), F1/F2/F9/Esc
- Pregled računa uz PIN (konobar vidi svoje, admin/menadžer/kasir sve) sa stavkama, plaćanjima, porezom i istorijom izmena
- Ture (podračuni) na istom stolu, prebacivanje izabranih stavki na drugu turu ili sto, spajanje tura, predaja računa konobaru, storno celog računa
- Napomena za stavku direktno u desnom panelu (brze napomene: bez leda, bez šećera…)
- Naplata: popusti iz ADMIN-a, gotovina, kartica, mix, virman, reprezentacija; kupac na računu (PIB, JMBG, diplomatska… — docs/FISCAL.md)
- Panel desno: Novi račun (F1), Pregled računa (F2), Moja smena, Cenovnik, Otvaranje/Zatvaranje smene, Osveži (F5), Ceo ekran; dole datum dana i cenovnik

**Admin:** kalendar poslovnih dana, detalji dana (porez, kase, smene zaposlenih, popusti), računi dana, izveštaj prometa, artikli i cene, popusti.

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
Ulaz robe, lager, normativi i dokumenti (sledeća iteracija), upravljanje zaposlenima, štampa i Print Bridge, KDS i WebSocket, fiskalizacija, više cenovnika (srećni sat), povraćaj novca, uvoz/izvoz, API ključevi i webhookovi, offline/hibridni rad. Plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## Dokumentacija
[Arhitektura](docs/ARCHITECTURE.md) · [Plan](docs/ROADMAP.md) · [Baza](docs/DATABASE.md) · [API](docs/API.md) · [Štampa](docs/PRINTING.md) · [Instalacija](docs/DEPLOYMENT.md) · [Testiranje](docs/TESTING.md) · [Kupac i plaćanja](docs/FISCAL.md)
