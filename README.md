# POS platforma za ugostiteljstvo

Modularni POS sistem: kasa, backoffice, (uskoro) KDS, štampa, lager i integracije. Backend NestJS + PostgreSQL (Drizzle), frontend React + Vite.

**Status: iteracija 1 — prvi vertikalni tok radi end-to-end, sa testovima nad pravom bazom.** Naplata je isključivo u **TEST režimu**: nema platnog terminala ni fiskalizacije, i aplikacija to jasno prikazuje. Nije za produkcionu upotrebu u lokalu.

## Brzi start
Preduslovi: Node.js 20.12+ i PostgreSQL 16 sa korisnikom `pos` i bazama `pos` i `pos_test` (vidi [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#windows--razvoj)).

Komande su u zasebnim redovima, pa rade i u Windows PowerShell 5 (koji ne podržava `&&`):
```
npm install
cp apps/api/.env.example apps/api/.env
npm run db:migrate
npm run db:seed
npm run dev:api      # :3000  (Swagger: http://localhost:3000/api/docs)
npm run dev:web      # u drugom terminalu, :5173
npm test             # 29 testova
```
Prijava: `admin@demo.local` / `Demo123!` → izaberite "Kasa 1 – Šank" → PIN 2222 (kasir), 1111 (konobar), 9999 (menadžer). **Demo nalozi su samo za razvoj.**

## Šta radi
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
Štampa i Print Bridge, KDS i WebSocket, fiskalizacija, popusti, podela računa po stavkama, prebacivanje/spajanje stolova, povraćaj, lager i dokumenti, uvoz/izvoz, API ključevi i webhookovi, upravljanje zaposlenima kroz UI, offline/hibridni rad. Plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## Dokumentacija
[Arhitektura](docs/ARCHITECTURE.md) · [Plan](docs/ROADMAP.md) · [Baza](docs/DATABASE.md) · [API](docs/API.md) · [Štampa](docs/PRINTING.md) · [Instalacija](docs/DEPLOYMENT.md) · [Testiranje](docs/TESTING.md)
