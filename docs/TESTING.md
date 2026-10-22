# Testiranje

## Pokretanje
```bash
# jednom: test baza (ime MORA da se završava na _test — testovi brišu njenu šemu)
#   CREATE DATABASE pos_test OWNER pos;
npm test                                  # svi testovi (unit + integracioni)
npm run test:unit -w apps/api             # samo čista logika (bez baze)
npm run test:e2e  -w apps/api             # integracioni, nad PostgreSQL-om
TEST_DATABASE_URL=postgresql://… npm test # druga test baza
```
Integracioni testovi pre svakog fajla brišu šemu test baze, primenjuju **sve** SQL migracije i učitavaju demo seed, zatim pokreću pravi NestJS server i šalju HTTP zahteve. Nema mock-ova baze.

## Rezultati — iteracija 2 (22.10.2026, Node 22.22, PostgreSQL 16, Linux)

**44 / 44 prošlo** (29 iz iteracije 1 + 15 novih u `test/e2e/day-shift.e2e.spec.ts`). Na Windowsu sa PostgreSQL 18 korisnik je potvrdio 29/29 za iteraciju 1.

Novi testovi: bez otvorenog dana nema računa ni smene kase · konobar ne može da otvori dan · dvostruko otvaranje dana · specifikacija pazara · kraj smene blokiran dok postoje otvoreni stolovi · prebacivanje tuđeg računa odbijeno, sve-ili-ništa · prebacivanje i pregled kod novog konobara · sačuvana specifikacija · istorija računa · zaključak blokiran (računi, pa kasa) · zaključak sa snimkom i zatvorenim smenama · kalendar i detalji dana · promet posle ponoći ostaje u poslovnom danu · novi dan mora biti posle poslednjeg.

UI provera (headless Chrome): KASA — otvaranje dana i kase, kucanje kroz kategorije, količina preko tastature, slanje, naplata, prebacivanje stola, kraj smene, zatvaranje kase, zaključak dana; ADMIN — kalendar, detalji dana, računi dana sa istorijom, artikli. Bez grešaka u konzoli. Pronađeno i ispravljeno: posle odjave je ostajao ekran prethodnog korisnika; prostorije i stolovi nisu bili prirodno sortirani; preklapanje dugmeta „+ račun“ na mapi.

## Rezultati — iteracija 1

**29 / 29 prošlo.** Posle ispravki pokrenuto 7 puta zaredom — svaki put 29/29, bez nestabilnih (flaky) testova.

### e2e/pos-flow.e2e.spec.ts
- ✅ Autentifikacija i prava › odbija pogrešan PIN, pogrešnu lozinku i zahtev bez tokena
- ✅ Autentifikacija i prava › konobar ne može da menja katalog ni da čita izveštaje (provera na backendu)
- ✅ Autentifikacija i prava › deaktiviran nalog gubi pristup odmah, i sa važećim tokenom
- ✅ Autentifikacija i prava › validacija: cena kao float broj i nepoznata polja se odbijaju
- ✅ Scenario A › administrator kreira kategoriju i proizvode sa poreskom stopom (duplikat šifre → 409)
- ✅ Scenario A › naplata bez otvorene smene je odbijena
- ✅ Scenario A › kasir otvara smenu; druga otvorena smena na istoj kasi nije moguća
- ✅ Scenario A › konobar otvara sto, dodaje kafu i sok; porudžbina se čuva i ponovo učitava iz baze
- ✅ Scenario A › slanje u pripremu: prva tura šalje obe stavke, naknadna samo novu stavku
- ✅ Scenario A › poslata stavka ne može da se obriše; konobar bez prava ne može da je stornira
- ✅ Scenario A › menadžer stornira poslatu stavku uz razlog; iznos se preračunava, istorija ostaje
- ✅ Scenario A › naplata kombinacijom kartice i gotovine (sa kusurom) zatvara račun
- ✅ Scenario A › izveštaj prikazuje promet, porez i plaćanja dosledno
- ✅ Scenario A › zatvaranje smene: očekivana gotovina = početna + gotovina + uplate − isplate
- ✅ Integritet › isti idempotency ključ ponovljen 2× i paralelno 5× pravi tačno jednu naplatu
- ✅ Integritet › 10 paralelnih naplata celog iznosa (različiti ključevi) → tačno jedna uspeva
- ✅ Integritet › 20 paralelnih dodavanja stavki → ukupan iznos tačno odgovara zbiru stavki
- ✅ Integritet › zastarela verzija (optimistički konflikt) vraća 409 STALE_ORDER
- ✅ Integritet › decimalne količine se pravilno zaokružuju
- ✅ Integritet › promena cene ne menja već dodate stavke (snimak cene) i ostaje u istoriji
- ✅ Integritet › nakon delimične naplate izmena ne sme da spusti račun ispod naplaćenog
- ✅ Integritet › baza sama odbija nedozvoljena stanja (CHECK ograničenja)
- ✅ Integritet › konobar ne vidi tuđu porudžbinu; kasir sa pravom pregleda vidi sve
- ✅ Integritet › idempotentno otvaranje porudžbine ne pravi duplikat

### unit/money.spec.ts
- ✅ nema floating-point grešaka (0.1 + 0.2)
- ✅ iznos stavke = round2(cena × količina), HALF_UP
- ✅ PDV se izdvaja iz bruto iznosa
- ✅ formatiranje količina i novca
- ✅ validacija decimalnih stringova

### Greške koje su testovi pronašli i koje su ispravljene
1. Duplikat šifre proizvoda vraćao je 500 umesto 409 — Drizzle umotava PostgreSQL grešku u `cause`; filter grešaka sada prati lanac.
2. Demo seed nije upisivao početnu cenu u istoriju cena.

## Provera korisničkog interfejsa (ručno automatizovana, headless Chrome 153)
Skripta je prošla kroz: prijava administratora → registracija kase → PIN prijava kasira → stolovi → Sto 2 → 4 stavke → "Pošalji" (tura 1) → nova stavka → delimična naplata karticom 1.000,00 → gotovina 2.000,00 sa kusurom 780,00 → račun zatvoren → smena → odjava → menadžer → izveštaj; zatim mobilni prikaz (390 px). Bez JavaScript grešaka u konzoli.

Pronađeno i ispravljeno tokom provere:
- Dodir brzog iznosa dok je prethodna naplata u obradi mogao je biti obrisan odgovorom servera → unos u dijalogu naplate je zaključan dok traje obrada.
- Na telefonu je stranica izlazila van širine ekrana (navigacija) → ispravljen raspored, provereno 0 px horizontalnog prelivanja.

Ova UI provera **nije** deo `npm test` (zahteva browser); prelazak na Playwright test u repozitorijumu je planiran.

## Nije pokriveno (još ne postoji funkcionalnost)
Scenariji B (kuhinjske stanice/KDS), C (ulaz robe/lager), D (integracioni API ključevi/webhookovi), E (štampa) — vidi ROADMAP.md.
