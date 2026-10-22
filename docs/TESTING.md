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

`npm test` u korenu pokreće i testove Print Bridge-a (`apps/print-bridge/test`).

## Rezultati — iteracija 4: faze 3 i 4 (22.10.2026, Node 22.22, PostgreSQL 16, Linux)

**API: 107 / 107 prošlo** (58 ranijih + 26 u `print-kds-fiscal.e2e.spec.ts` + 23 u `stock.e2e.spec.ts`), dva uzastopna pokretanja.
**Print Bridge: 12 / 12 prošlo** (`apps/print-bridge/test/bridge.spec.ts`).

Faza 3 (`print-kds-fiscal.e2e.spec.ts`):
- rutiranje ture po pozicijama (kartica + zadatak štampe po poziciji), artikal bez pozicije ostaje nerutiran · nova tura samo za nove stavke, ponovljeno slanje ne pravi ništa · 5 paralelnih slanja → jedna tura · baza odbija dupli `dedupe_key` i duplu karticu · storno pravi STORNO tiket jednom · pozicija bez štampača (samo KDS) · artikal sa sopstvenom pozicijom
- Print Bridge API: bez ključa / pogrešan ključ 401, bridge ne može PIN prijavu · dva paralelna preuzimanja nikad isti zadatak · greška → odlaganje → ponovni pokušaj → trajna greška → ručno ponavljanje · istek zakupa vraća zadatak, drugi bridge ne može da javi tuđi rezultat · novi ključ poništava stari, heš se ne vraća
- validacija štampača i prava
- KDS: prava, filtriranje po poziciji, statusi, stavka spremna → kartica spremna, nedozvoljen prelaz 409, konobar vidi status pripreme, stornirana stavka na kartici
- WebSocket: 401 bez/sa neispravnim tokenom i za deaktiviranog korisnika · filtriranje po poziciji · događaj tek posle commit-a, neuspela izmena ne šalje događaj · status sa KDS-a stiže kasi
- Fiskalizacija: `/health` pokazuje TEST · TEST broj, zahtev sa kupcem i načinima plaćanja, ponovljena naplata ne pravi drugi zahtev · nedostupan fiskalni sistem: naplata uspeva, račun nije označen kao fiskalizovan, ponovni pokušaji pa uspeh · trajna greška → FAILED → ručni pokušaj · CHECK: SIGNED bez broja · NONE provajder · štampa računa sa „TEST — OVO NIJE FISKALNI RAČUN“, idempotentno, kopija
- **Stvarni Print Bridge ↔ stvarni API**: kuhinjski blok stiže na lažni TCP štampač kao ESC/POS (CP852 bajtovi proveren), šank (simulacija) → SIMULATED, drugi krug ništa ne štampa

Faza 4 (`stock.e2e.spec.ts`):
- prava (konobar/kasir bez pristupa) · partner: PIB kontrolna cifra, jedinstven PIB · tačno jedno podrazumevano skladište (i u bazi)
- prijemnica: validacija stavki, partner obavezan · PPNC (10×1000 + 5×1600)/15 = 1200 · ponovno knjiženje idempotentno · proknjižen dokument se ne menja · kartica sa stanjem posle svakog kretanja
- otpis više od stanja → INSUFFICIENT_STOCK i **ništa** se ne knjiži · dva paralelna izlaza preko stanja → tačno jedan uspeva · prenos po PPNC
- automatski utrošak: normativ iz skladišta pozicije, artikal sa zalihom troši sebe, minus pri prodaji vidljiv · idempotentno (ponovni poziv, ponovljena naplata, jedinstveni indeks) · stornirana stavka se ne troši · verzije normativa: aktivna se ne menja, aktivacija povlači prethodnu, prodaja beleži verziju
- storno prijemnice vraća stanje i PPNC; storno koji bi doveo do minusa odbijen · popis: predlog, snimak knjižnog stanja, kretanja samo za razlike · kartica sa početnim stanjem
- kasa ne nudi sirovine · uvoz CSV sa greškama po redovima (kategorija, PDV, cena, duplikat, da/ne), potvrda sa greškama odbijena u celosti, „preskoči neispravne“ sa izveštajem · nedostaju kolone · XLSX partneri (izmena po PIB-u) · stavke dokumenta iz CSV-a sa zarezom · izvoz CSV (BOM, `;`) i XLSX, izvezeni XLSX se ponovo uvozi bez grešaka

Print Bridge (`bridge.spec.ts`): sadržaj kuhinjskog/storno bloka i računa (oznaka „nije fiskalni“ gore i dole) · kodiranje ascii/CP852/CP1250 · ESC/POS komande · TCP: tačni bajtovi, odbijena veza, timeout · simulacija nikad PRINTED · Windows RAW van Windows-a → trajna greška · petlja sa lažnim serverom · server nedostupan → petlja ne pada.

Greške pronađene i ispravljene:
- polja DTO klase postoje kao `undefined` (ES2022 class fields) pa je provera izmene štampača gazila postojeće vrednosti — bazni CHECK je uhvatio grešku, provera ispravljena
- `@Type(() => Boolean)` je query `false` pretvarao u `true` (npr. `includeInactive=false`) — zamenjeno sa `@ToBool()` svuda
- normativ: odgovor se čitao van transakcije (prazan odgovor) — čita se u transakciji
- kartica: kretanja iz iste transakcije imaju isto vreme → dodata kolona `seq` za redosled
- KDS: negativno „-1′“ zbog zastarelog sata ekrana — ispravljeno

UI (headless Chrome):
- faza 3 (dva pregledača: kasa i KDS uređaj): slanje → status „Kuhinja: primljeno“ · nova tura stiže na KDS u realnom vremenu · „Počni“/stavka spremna/„Spremno“ menja status na kasi u realnom vremenu · gašenje API-ja → crvena traka na KDS-u, ponovno pokretanje → „Povezano“ · naplata sa porukom o TEST fiskalizaciji · štampa računa · Print Bridge pokrenut kao poseban proces: zadaci u ADMIN-u „Simulirano“, sadržaj blokova proveren u `simulated-output` · ADMIN pozicije, štampači, bridge, red štampe, fiskalizacija
- faza 4 (ADMIN): prijemnica (nacrt → stavke → knjiženje PRI-1) · prenos MP-1 · prodaja preko API-ja · stanje lagera sa minusom · kartica u šanku sa utroškom po normativu · normativ v2 aktiviran · popis POP-1 sa razlikama · uvoz CSV sa 2 greške → pregled → „uvezi ispravne“ · partneri · artikal kao sirovina sa lagerom. Bez grešaka u konzoli.

Nije testirano: Windows (Print Bridge RAW adapter, servis), stvarni termalni štampači, Docker Compose.

## Rezultati — iteracija 3 (22.10.2026, Node 22.22, PostgreSQL 16, Linux)

**58 / 58 prošlo** (44 ranijih + 14 novih u `test/e2e/checkout.e2e.spec.ts`), dva puzastopna pokretanja.

Novi testovi: definisanje popusta (prava, opseg) · raspodela popusta po stavkama i PDV po stopama (20% i 10%) · nova stavka nasleđuje popust · izveštaj posle popusta · PIB/JMBG kontrolne cifre · kupac (PIB, diplomatska + opciono polje, brisanje) · mix sa kusurom + idempotentnost · mix preko duga ne upisuje ništa · reprezentacija samo za ceo račun i odvojeno u smeni/danu · ture sa nazivima · prebacivanje stavke na turu (ostaje poslata) i na drugi sto · spajanje tura (MERGED) i odbijanje ture sa naplatom · preimenovanje ture · storno celog računa.

Greška pronađena testom i ispravljena: pogrešan test-vektor za JMBG u samom testu (kontrolna cifra ručno proverena).
Greška pronađena pre testa: u migraciji 0002 CHECK `total = subtotal − popust` dodavao se pre popunjavanja `subtotal` za postojeće račune — redosled ispravljen i provereno nad bazom sa postojećim računima.

UI (headless Chrome): otvaranje smene jednim dugmetom (dan + kasa), sto sa napomenom iz panela, dve ture, opcije stola, spajanje tura, naplata sa popustom 10%, PIB kupca i mix, pregled računa uz PIN konobara sa istorijom. Bez grešaka u konzoli.

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
