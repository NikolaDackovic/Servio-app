/**
 * Uputstvo za korisnike (kasa, ADMIN, KDS, instalacija). Tekst je ovde, slike u public/help (pravi ih skripta
 * scripts/help-shots.mjs iz pravog programa, pa se lako osvežavaju kad se ekran promeni).
 *
 * Telo teme je niz redova:
 *   "# Naslov"        podnaslov
 *   "- tekst"         stavka liste
 *   "1. tekst"        korak (numerisano)
 *   "! tekst"         savet / upozorenje (istaknuto)
 *   "img:ime.jpg|opis" slika ekrana
 *   ostalo            običan pasus
 * **reč** = podebljano, `TASTER` = dugme ili taster.
 */
export type HelpArea = 'kasa' | 'admin' | 'kds' | 'instalacija';
export interface HelpTopic { id: string; area: HelpArea; title: string; /** stranice ADMIN-a za koje je ovo uputstvo ("?") */ pages?: string[]; body: string[] }

export const AREAS: { id: HelpArea; title: string; intro: string }[] = [
  { id: 'kasa', title: 'Kasa', intro: 'Kucanje, naplata i pregled računa - za konobare, šankere i kasire.' },
  { id: 'admin', title: 'ADMIN', intro: 'Artikli, roba, korisnici, štampači, izveštaji - za vlasnika, menadžera i knjigovođu.' },
  { id: 'kds', title: 'KDS ekran', intro: 'Ekran u kuhinji ili na šanku koji prikazuje porudžbine umesto papira.' },
  { id: 'instalacija', title: 'Instalacija i održavanje', intro: 'Više kasa, rezervne kopije, rad od kuće.' },
];

export const TOPICS: HelpTopic[] = [
  // ------------------------------------------------------------------ KASA
  {
    id: 'kasa-prijava', area: 'kasa', title: 'Prijava na kasu',
    body: [
      'Svaki zaposleni ima svoju **šifru (PIN)** od 1 do 10 cifara. Šifru dodeljuje vlasnik ili menadžer u ADMIN → Korisnici.',
      '1. Ukucajte šifru na ekranu ili tastaturom.',
      '2. Pritisnite `PRIJAVA` ili `Enter`.',
      'Ako u lokalu ima više kasa, prvi put se bira koja je ovo kasa (npr. „Kasa 1 - Šank“). Izbor se pamti.',
      '- **Kasa bez šifre** (npr. fast food): ADMIN → Podešavanje računara → Osnovni podaci → Podrazumevani korisnik. Kasa se sama prijavljuje kao on i ne traži šifru ni za stolove; posle `Odjava` se kuca šifra do ponovnog pokretanja.',
      '! Posle 5 pogrešnih pokušaja kasa čeka jedan minut. Šifru ne govorite drugima - svaki račun se vodi na onoga ko je prijavljen.',
    ],
  },
  {
    id: 'kasa-nalozi', area: 'kasa', title: 'Podrazumevane šifre i kartice',
    body: [
      'Svaka nova kasa dobija iste naloge (menjaju se u ADMIN → Korisnici):',
      '- **ADMIN** / **0000** - ADMIN (korisničko ime i šifra) i kasa (PIN 0000)',
      '- **KON01** / **11** i **KON02** / **22** - konobari (PIN na kasi)',
      '- **tv** / **tv** - KDS ekran (korisničko ime i šifra)',
      '! Šifru ADMIN-a promenite odmah, naročito ako se ADMIN otvara od kuće. Početna ADMIN-a upozorava dok je i dalje 0000.',
      '# Kartice',
      'Umesto kucanja šifre zaposleni može da **prisloni karticu** na čitač (USB čitač koji radi kao tastatura). Radi svuda gde se kuca šifra: prijava, sto, storno, kraj dana.',
      '1. ADMIN → Korisnici → zaposleni → polje **Kartica**: kliknite u polje i prislonite karticu.',
      '2. `Sačuvaj`. Ista kartica ne može biti dodeljena dvojici.',
      '- Izgubljena kartica: `Ukloni karticu` - ona odmah prestaje da radi.',
    ],
  },
  {
    id: 'kasa-qr', area: 'kasa', title: 'QR porudžbine gostiju',
    body: [
      'Gost skenira QR kod na stolu, izabere artikle na telefonu i pošalje porudžbinu.',
      'img:qr-meni.jpg|Meni na telefonu gosta',
      '- Porudžbina **odmah** ide u šank i kuhinju (štampač / KDS), kao da ju je konobar otkucao.',
      '- Na svakoj kasi iskoči plavo obaveštenje „Nova QR porudžbina - sto 5“ uz kratak zvuk.',
      'img:kasa-qr.jpg|Obaveštenje na kasi',
      '- Ako sto već ima račun konobara, stavke se dodaju na taj račun. Ako je sto bio prazan, na mapi piše **Gost (QR)**.',
      '- **Prvi konobar koji otvori taj sto preuzima račun** - posle je to njegov račun.',
      '- Naplatu radi konobar, kao i uvek. Gost ne može da naplati ni da vidi tuđe račune.',
      '! Ako dan (smena) nije otvoren, gost dobija poruku da lokal trenutno ne prima porudžbine.',
    ],
  },
  {
    id: 'kasa-dan', area: 'kasa', title: 'Početak i kraj radnog dana (smena)',
    body: [
      '# Otvaranje',
      'Na početku dana kasir otvara smenu dugmetom `Otvaranje smene` (ime smene je dan u nedelji, npr. „Ponedeljak“). Dok smena nije otvorena, stolovi se ne mogu otvarati.',
      '# Zatvaranje',
      '1. Svi računi moraju biti naplaćeni ili prebačeni (osim hotelskih soba - one ostaju otvorene za sledeći dan).',
      '2. `Kraj dana` prikazuje promet po zaposlenima, gotovinu i karticu, prodaju po šanku i kuhinji (razduživanje). Odštampajte ga ako treba.',
      '3. `Zatvaranje smene` zatvara dan. Posle toga se dan vidi u ADMIN → Specifikacija pazara.',
      '! Ako zatvaranje ne uspe, kasa kaže zašto (npr. „ostala su 2 otvorena stola“) i nudi rešenje.',
    ],
  },
  {
    id: 'kasa-stolovi', area: 'kasa', title: 'Stolovi i brza prodaja',
    body: [
      'img:kasa-stolovi.jpg|Mapa stolova: zauzet sto pokazuje konobara i iznos',
      '- Gore su delovi lokala (`SALA`, `BAŠTA`…) i `SPISAK` - svi stolovi kao lista.',
      '- **Slobodan** sto je samo broj. **Zauzet** sto pokazuje ime konobara i iznos računa.',
      '- Klik na sto otvara račun tog stola. Ako je uključeno „PIN po stolu“, kasa prvo traži šifru konobara.',
      '- `Novi račun F1` je brza prodaja bez stola (za šank, poneti).',
      '- `Osveži podatke F5` ponovo učitava stolove (inače se osvežavaju sami).',
    ],
  },
  {
    id: 'kasa-kucanje', area: 'kasa', title: 'Kucanje porudžbine',
    body: [
      'img:kasa-porudzbina.jpg|Ekran porudžbine: grupe gore, artikli u sredini, račun desno',
      '1. Izaberite grupu gore (`Topli napici`, `Hrana`…) ili `SVI` / `BRZI` (najprodavaniji).',
      '2. Klik na artikal ga dodaje na račun. Ponovni klik povećava količinu.',
      '3. Ako artikal ima dodatke (npr. „Bez šećera“, „Duplo“), pojavi se izbor - `POTVRDI` ili `BEZ IZMENA`.',
      '4. `SAČUVAJ` šalje porudžbinu u šank i kuhinju (štampač ili KDS ekran) i vraća na stolove.',
      '# Korisni tasteri',
      '- `UNESI KOLIČINU`: prvo ukucajte broj (npr. 3), pa artikal.',
      '- `+` i `−`: količina označene stavke.',
      '- `OBRIŠI STAVKU`: briše još neposlatu stavku. Za već poslatu piše `STORNO STAVKE` i traži razlog.',
      '- Napomena (polje gore desno): upišite i pritisnite `Enter`. Zvezdica ispred teksta (`*kola`) pretražuje artikle po nazivu.',
      '- `ZATVORI`: izlaz; ako ima neposlatih stavki, kasa pita da li da ih pošalje.',
      'img:kasa-dodaci.jpg|Dodaci uz artikal',
    ],
  },
  {
    id: 'kasa-ture', area: 'kasa', title: 'Ture, prebacivanje i spajanje',
    body: [
      '- `+ Tura`: poseban račun na istom stolu (npr. „Pera“ plaća svoje). Između tura se prelazi klikom na karticu ture.',
      '- `PREBACIVANJE`: izabrane stavke (ili sve - `IZABERI SVE`) idu na drugi sto ili turu.',
      '- Dugme `PREGLED · opcije stola` (ispod broja stola) otvara opcije: prebacivanje, spajanje tura, **Spoji porudžbinu** (ova tura ide u račun drugog stola ili ture), nova tura, naziv ture, storno celog računa.',
      '- Prazan sto (otvoren, ništa otkucano) se takođe prebacuje na drugi, slobodan sto.',
      '- **Storno**: ko ima pravo storniranja (ADMIN, menadžer…) samo izabere razlog i potvrdi; ostali kucaju šifru nekoga ko ima to pravo - ako ga nema, kasa javlja da nema prava.',
      '- `PRETH. PORUDŽ.`: šta je i kada već poslato u kuhinju/šank.',
      'img:kasa-prebacivanje.jpg|Prebacivanje stavki',
    ],
  },
  {
    id: 'kasa-naplata', area: 'kasa', title: 'Naplata',
    body: [
      '**Najbrže:** `GOTOVINA` ili `KARTICA` dole levo - ceo račun se naplaćuje jednim klikom.',
      'Za sve ostalo `NAPLATA` (ili `F9`):',
      'img:kasa-naplata.jpg|Naplata: popusti, kupac, načini plaćanja',
      '- **Popust**: izaberite procenat gore (definišu se u ADMIN → Popusti).',
      '- **Kupac** (firma traži račun na PIB): `KUPAC` → vrsta (PIB, JMBG…) i broj. Kasa proverava kontrolnu cifru PIB-a.',
      '- `GOTOVINA`, `KARTICA`, `VIRMAN`: ceo iznos.',
      '- `MIKS`: deo karticom (ukucajte iznos), ostatak gotovinom.',
      '- `REPREZENTACIJA`: vidi posebno uputstvo.',
      '- `OTKAŽI`: povratak bez naplate.',
      'Posle naplate sto postaje slobodan, a račun se štampa na štampaču računa ove kase.',
    ],
  },
  {
    id: 'kasa-reprezentacija', area: 'kasa', title: 'Reprezentacija (čast kuće, osoblje)',
    body: [
      'img:kasa-reprezentacija.jpg|Izbor razloga reprezentacije',
      '1. `NAPLATA` → `REPREZENTACIJA`.',
      '2. Izaberite razlog: `ČAST KUĆE`, `OSOBLJE` ili `REPREZENTACIJA`.',
      '- Izdaje se **regularan (fiskalni) račun** po pravilima PU; način plaćanja na isečku: „Друго безготовинско“.',
      '- Roba se **skida sa stanja**, a iznos **ulazi u pazar** kao posebna stavka (Reprezentacija) - ne u gotovinu za predaju.',
      '- U lokalu se račun pravda potpisom na poleđini (na kuću, osoblje, domaći proizvodi…); razlog ostaje zapisan u sistemu.',
      '! Reprezentacija nema povraćaj ni promenu načina plaćanja. Poreski tretman proverite sa knjigovođom.',
    ],
  },
  {
    id: 'kasa-pregled', area: 'kasa', title: 'Pregled računa (F2)',
    body: [
      'img:kasa-pregled.jpg|Pregled računa: lista levo, detalj desno',
      '`Pregled računa F2` traži šifru: konobar vidi svoje račune, menadžer i kasir sve.',
      '- Klik na račun: desno `STAVKE` (sve stavke, stornirane precrtane, način plaćanja, fiskalni broj) ili `ISEČAK` - račun tačno kako je odštampan (naplaćen račun se odmah prikazuje kao isečak).',
      '- `PRESEK STANJA / PAZAR`: koliko ko treba da preda (gotovina, kartica).',
      '- `PRODATI ARTIKLI`: šta je i koliko prodato danas.',
      '- `PREBACIVANJE`, `STORNIRANJE` (nenaplaćen račun), `OTVORI STO`.',
      '- `PREBACI SVE OTVORENE STOLOVE`: kad konobar odlazi, svi njegovi stolovi idu kolegi.',
      '- `POVRAĆAJ`: vidi sledeće uputstvo.',
    ],
  },
  {
    id: 'kasa-povracaj', area: 'kasa', title: 'Povraćaj novca (refundacija)',
    body: [
      'img:kasa-povracaj.jpg|Povraćaj: izbor stavki i količina',
      '1. `Pregled računa F2` → izaberite naplaćen račun → `POVRAĆAJ`.',
      '2. Za svaku stavku upišite koliko se vraća (ili `IZABERI SVE`).',
      '3. `VRATI` → razlog i šifra menadžera.',
      '- Roba se vraća na stanje, novac izlazi iz kase (gotovina) ili ide nazad na karticu.',
      '- Štampa se račun refundacije u dva primerka; kupac potpisuje jedan.',
    ],
  },
  {
    id: 'kasa-precice', area: 'kasa', title: 'Tasteri i prečice',
    body: [
      '- `F1` novi (brzi) račun · `F2` pregled računa · `F5` osveži · `F9` naplata',
      '- `F11` ili dugme `Ceo ekran / prozor` (dole desno), `Umanji`, `Zatvori` - za kase bez tastature',
      '- `F12`: **izgled kase** na ovom računaru - veličina i debljina teksta artikala i grupa, boja teksta, kartice u boji grupe, tamna tema',
      '- `Ctrl+Shift+A` na glavnoj kasi: adrese za ADMIN, KDS i dodatne kase + poslednja rezervna kopija',
      '- `Ctrl+Shift+D`: ADMIN u posebnom prozoru na ovom računaru (radi i kad smena nije otvorena)',
      '- `Ctrl+Shift+R` na glavnoj kasi: vraća podrazumevane naloge (ADMIN/0000, KON01/11, KON02/22, tv/tv) - kad niko ne zna šifru',
      '# ADMIN na računaru',
      'Instalacija pravi dve ikonice na radnoj površini: **Servio** (kasa) i **Servio ADMIN** (backoffice na istom računaru). Od kuće: ADMIN u pregledaču preko javne adrese ili Tailscale-a (vidi Instalacija → ADMIN od kuće).',
      '- Na prijavi: cifre, `Backspace`, `Enter` sa obične tastature',
    ],
  },

  // ------------------------------------------------------------------ ADMIN
  {
    id: 'admin-pocetna', area: 'admin', title: 'Prijava, tabovi i pretraga (Ctrl+K)', pages: ['products'],
    body: [
      '# Prijava',
      'Kao na kasi: ukucajte **šifru** (PIN, 1-10 cifara) ili prislonite karticu - korisničko ime ne treba. U ADMIN ulazi svako; meni prikazuje sve stranice, a one za koje uloga nema pravo su **posivljene** i ne otvaraju se (npr. konobar: specifikacija pazara, spajanje i podela smene). Prava se menjaju u Korisnici → Uloge i prava.',
      'img:admin-prijava.jpg|Prijava u ADMIN šifrom',
      '# Tabovi',
      'img:admin-pocetna.jpg|Više otvorenih stranica (tabovi) i radnje nad računom',
      'Svaka stranica koju otvorite iz menija postaje **tab** ispod menija (kao u pregledaču): npr. Pretraga računa, Ulazna faktura i Trenutno stanje robe otvoreni odjednom. Tab pamti šta ste radili dok ga ne zatvorite sa `×`, srednjim tasterom miša ili dugmetom `Zatvori` na samoj stranici. Sačuvan dokument dobija svoj tab (npr. „UF 12“), a meni otvara novi prazan.',
      '- Dugme ☾ gore desno menja temu (tema kase / tamna).',
      '# Pretraga',
      '`Ctrl+K` (ili `Traži` gore desno) - ukucajte šta tražite („faktura“, „PIN“, „štampač“) i `Enter`.',
      'img:admin-pretraga.jpg|Pretraga svih stranica',
    ],
  },
  {
    id: 'admin-proizvodi', area: 'admin', title: 'Artikli (proizvodi i sirovine)', pages: ['products'],
    body: [
      'img:admin-proizvodi.jpg|Tabela artikala',
      '- **Filteri** su u redu iznad naslova kolona (kao u Octopos-u): kucajte u kolonu (npr. „cola“ u Naziv) ili birajte iz liste. Klik na naslov sortira.',
      '- Jedan klik označava red, **dvoklik otvara** artikal.',
      '# Novi artikal',
      '1. `Dodaj` u traci ispod tabele.',
      '2. Naziv i cena sa PDV-om. Šifra može ostati prazna - dodeljuje se sledeći broj.',
      '3. `Sačuvaj i novi` - forma ostaje otvorena za sledeći artikal; grupa, PDV i jedinica mere ostaju izabrani.',
      'img:admin-novi-artikal.jpg|Forma artikla',
      '# Vrste',
      '- **Prodajni artikal** se vidi na kasi. Kod komadnih (Coca-Cola) štiklirajte „Prati se zaliha“.',
      '- **Sirovina** (kafa u kg, mleko u l) se ne prodaje, nego troši kroz **normativ** prodajnog artikla (npr. espreso = 0,007 kg kafe).',
      '- **Dodaci**: izbor na kasi (Bez šećera, Duplo…).',
      '- **Kategorija (Šank / Kuhinja)**: gde se porudžbina štampa; podrazumevano prema grupi.',
      '# Ostalo',
      '- `Kopiraj`: novi artikal sa istim podacima (Coca-Cola → Fanta), menja se samo naziv i cena.',
      '- `Gde je u normativu`, `Dnevnik promena` (ko je i kada menjao cenu).',
      '- `Obriši` samo isključuje artikal - istorija prodaje ostaje. Vraća se štikliranjem „Aktivan“ (uz „Prikaži neaktivne“).',
    ],
  },
  {
    id: 'admin-grupna', area: 'admin', title: 'Grupna izmena cena', pages: ['products'],
    body: [
      'img:admin-grupna.jpg|Grupna izmena: pregled stare i nove cene',
      '1. Artikli → `Grupna izmena`.',
      '2. Izaberite grupu (ili sve) i šta se menja: cena, grupa ili uključeno/isključeno.',
      '3. Za cenu: iznos u `%` ili `din` (minus = pojeftinjenje) i zaokruživanje (npr. na 10 din).',
      '4. U tabeli se vidi stara i nova cena. Skinite kvačicu sa artikala koje ne treba menjati.',
      '5. `Primeni`.',
      '! Promena cene važi za nove stavke; već otkucani računi zadržavaju staru cenu. Svaka promena ostaje u istoriji cena.',
    ],
  },
  {
    id: 'admin-grupe', area: 'admin', title: 'Grupe i kategorije', pages: ['groups', 'categories'],
    body: [
      '- **Grupe** su dugmad na kasi (Topli napici, Hrana…): naziv i boja; strelicama ▲▼ u koloni „Redosled na kasi“ birate redosled dugmadi.',
      '- **Za prodaju**: grupa bez kvačice je grupa **sirovina / troška** (npr. „Sirovine voće“ sa limunom u KG) - ne vidi se na kasi ni u QR meniju.',
      '! Primer: grupa „Sirovine voće“ (nije za prodaju) → sirovina „Limun KG“. Grupa „Ceđeni sokovi“ (za prodaju) → artikal „Limunada 0,33“ sa normativom: Limun KG, količina bruto 0,05.',
      '- **Kategorije** (Šank, Kuhinja, Pica…) određuju gde se porudžbina šalje: na koji štampač ili KDS ekran. Strelicama ▲▼ birate **redosled na kasi** (dugmad kategorija i artikli na SVE).',
      'Grupa se vezuje za kategoriju; pojedinačni artikal može imati drugu kategoriju od svoje grupe.',
    ],
  },
  {
    id: 'admin-dokumenta', area: 'admin', title: 'Dokumenta: ulazna faktura, popis, otpis, korekcija', pages: ['documents'],
    body: [
      'img:admin-dokument.jpg|Ulazna faktura',
      'Svaki dokument je **poseban ekran** i unosi se isto: meni **Dokumenta** → Ulazna faktura, Ulazna otpremnica, Izlazna faktura, Povrat dobavljaču, Prenos između magacina, Otpis, Interna potrošnja, Popis, Korekcija zalihe. Otvara se u svom tabu.',
      '# Ulazna faktura (prijem robe)',
      '1. Gore: magacin, **dobavljač** (`+` = novi dobavljač, naziv i PIB), broj dokumenta (broj fakture), datum prometa i datum valute, napomena i interna napomena (ne štampa se).',
      '2. Gore desno, u polje **Šifra, barkod ili naziv** kucajte (npr. „coca“) ili skenirajte barkod i `Enter`.',
      '3. Otvara se **Kalkulator jedinične cene**: trenutna zaliha, poslednja nabavna cena; količina **pakovanja × komada** (2 × 24 = 48); cenu upišite kako piše na fakturi - u bilo koje od četiri polja (jedinična ili ukupna, bez ili sa PDV-om), ostala se računaju; **popust** (rabat); **rezultat** je nova nabavna cena bez PDV-a. Dole **marža %** i **prodajna cena** - promena prodajne cene se upisuje u artikal. `Potvrdi` (ili Enter).',
      'img:admin-stavka.jpg|Kalkulator jedinične cene',
      '4. Stavka je u tabeli: šifra, naziv, poslednja nabavna (crveno), trenutno stanje, količina, cena, rabat, PDV, iznos. Količina, cena i rabat se menjaju i direktno u tabeli; klik na naziv ponovo otvara kalkulator.',
      '5. Dole levo bira se šta je kolona cene: **Jed. bez PDV / Jed. sa PDV / Uk. bez PDV / Uk. sa PDV**. „Kalkulacija“ uključuje/isključuje kalkulator posle izbora artikla (ili kvačica „Ne prikazuj automatski“ u njemu).',
      '6. Desno gore: iznos bez PDV, rabat, osnovica, PDV, **iznos sa PDV** - uporedite sa fakturom.',
      '7. `Sačuvaj` - dokument se knjiži i roba ulazi na stanje. `Sačuvaj i novi` - odmah prazan sledeći dokument. `Sačuvaj nacrt` čuva bez knjiženja (zalihe se ne menjaju).',
      '! Artikal bez vođenja zalihe se sam prebacuje na „prati se zaliha“ čim ga stavite na dokument. Artikla nema? Pretraga nudi `+ Napravi novi artikal`.',
      '# Ostala dokumenta - isti princip',
      '- **Izlazna faktura, povrat, otpis, interna potrošnja**: roba izlazi; kalkulator traži samo količinu.',
      '- **Prenos**: iz magacina → u magacin.',
      '- **Popis**: `Pripremi popis` - štiklirajte kategorije (npr. Kuhinja) ili grupe i svi artikli sa zalihom upisuju se u tabelu. Kolone: **Očekivano** (šta je kucano i uneto - ulaz i izlaz; minus znači da ulaz nije unet kako treba), **Izmereno** (upisujete redom šta ste izbrojali), **Razlika** (izmereno - očekivano) i vrednost razlike. `Štampaj popis` daje listu za brojanje na papiru. Za artikle koje ne brojite (npr. lepinje) - `Prazno = očekivano`; ostali bez upisanog „Izmereno“ se pri čuvanju izbacuju iz popisa (program pita). Nabavna cena se može ukucati. Knjiže se samo razlike, kada je smena zatvorena.',
      '- **Korekcija zalihe**: kada je, npr., gostu data obična Coca-Cola umesto Zero: Coca-Cola **−1** (izlaz), Coca-Cola Zero **+1** (ulaz). U kalkulatoru izaberite `+ Ulaz` ili `− Izlaz`, ili u tabeli upišite količinu sa minusom. Kolona „Novo stanje“ pokazuje stanje posle korekcije.',
      '# Pregled dokumenata',
      '- Svi dokumenti u tabeli sa filterima; dvoklik otvara dokument u novom tabu. Proknjižen dokument se ne menja - `Storniraj` pravi suprotna kretanja.',
      '- `Štampaj` (A4), `Eksport` (CSV), `Uvoz stavki` (Excel dobavljača).',
    ],
  },
  {
    id: 'admin-stanje', area: 'admin', title: 'Stanje robe, zalihe i kartica', pages: ['balances', 'asOf', 'levels', 'card', 'recipes', 'warehouses'],
    body: [
      '- **Trenutno stanje robe**: gore levo stablo kategorija i grupa sa kućicama (ništa = sve), izbor magacina. U tabeli: kategorija, grupa, šifra, barkod, proizvod, JM, PDV, količina, nabavna cena i vrednost (bez i sa PDV-om), prodajna cena i vrednost (bez i sa PDV-om); u dnu **UKUPNO**. Dvoklik otvara karticu proizvoda.',
      '- **Kartica proizvoda**: početna i završna smena, proizvod, `Pronađi`. Vreme, ulaz, izlaz, stanje, dokument (KS = kasa, UF = ulazna faktura, KOR = korekcija…), komitent, nabavna i prodajna cena bez PDV-a, PDV, vrednosti; u dnu UKUPNO.',
      '- **Stanje robe na dan**: stanje za bilo koji datum unazad.',
      '- **Zalihe**: artikli ispod minimalne zalihe su crveni - spisak za naručivanje.',
      '- **Magacini** (meni Dokumenta): magacini i iz kog magacina prodaja troši robu po kategoriji (Šank, Kuhinja).',
      '- **Normativi**: pregled šta svaki artikal troši.',
      '! Prodaja kad nema robe je dozvoljena - stanje ide u minus, a prijem robe ga vraća.',
    ],
  },
  {
    id: 'admin-narudzbina', area: 'admin', title: 'Šta naručiti (predlog narudžbine)', pages: ['reorder'],
    body: [
      'img:admin-narudzbina.jpg|Predlog narudžbine po dobavljaču',
      'Program računa šta treba naručiti, po dobavljaču:',
      '- **Dnevna potrošnja** = koliko je prodato u poslednjih 14 dana (može 7, 30, 60) podeljeno brojem dana.',
      '- **Naručiti** = dovoljno za 7 dana (može 3-30) ili do minimalne zalihe, šta je više - minus ono što već imate.',
      '- Komadi se zaokružuju na ceo broj. Dobavljač i cena su iz poslednje ulazne fakture za taj artikal.',
      '1. Proizvod → `Predlog narudžbine` (ili na Početnoj `Šta naručiti`).',
      '2. Promenite količine po potrebi, skinite kvačicu sa onoga što ne naručujete.',
      '3. `Kopiraj tekst narudžbine` i nalepite u Viber, SMS ili mejl dobavljaču.',
      '4. `Napravi nacrt ulazne fakture`: kad roba stigne, otvorite nacrt u Dokumentima, uskladite sa fakturom i proknjižite.',
      '! Predlog radi za artikle sa vođenjem zalihe. Upišite minimalnu zalihu u formi artikla za ono što nikad ne sme da nestane.',
    ],
  },
  {
    id: 'admin-partneri', area: 'admin', title: 'Partneri (dobavljači i kupci)', pages: ['partners'],
    body: [
      'Dobavljači su potrebni za ulazne fakture. Upisuje se naziv, PIB (proverava se kontrolna cifra), matični broj, adresa i kontakt.',
      'Najbrže: novog dobavljača dodajte direktno iz nove ulazne fakture.',
    ],
  },
  {
    id: 'admin-uvoz', area: 'admin', title: 'Uvoz i izvoz (Excel)', pages: ['import'],
    body: [
      '- **Izvoz**: artikli, stanje i dokumenta u Excel (CSV/XLSX) - za knjigovođu ili rezervu.',
      '- **Uvoz**: artikli iz tabele (npr. pri prelasku sa drugog programa). Prvo se vidi provera svakog reda, pa tek onda upis.',
      '! Počnite od dugmeta `Šablon XLSX` - kolone moraju imati ta imena. Redovi sa greškom se ne upisuju; `Preuzmi izveštaj grešaka` kaže šta treba ispraviti.',
    ],
  },
  {
    id: 'admin-korisnici', area: 'admin', title: 'Korisnici, uloge i prava', pages: ['users', 'roles'],
    body: [
      '- Svaki zaposleni dobija **ime i šifru (PIN)** za kasu, i po želji **karticu** (prisloni karticu u polje Kartica). Vlasnik i knjigovođa dobijaju i korisničko ime i lozinku za ADMIN.',
      '- **Uloge**: Vlasnik, Menadžer, Kasir, Konobar, Šanker, Kuvar, Knjigovođa. Svaka uloga ima prava (npr. konobar ne može storno bez menadžera).',
      '- Prava uloge se menjaju u **Uloge i prava**.',
      '- Zaposleni koji ode: isključite ga („Aktivan“) - istorija ostaje, prijava više ne radi.',
    ],
  },
  {
    id: 'admin-popusti', area: 'admin', title: 'Popusti, cenovnici i happy hour', pages: ['discounts', 'priceLists', 'happy'],
    body: [
      '- **Popusti**: naziv i procenat; važe za ceo račun, jednu grupu ili jedan artikal. Biraju se na kasi pri naplati.',
      '- **Cenovnik**: druge cene za isti artikal (npr. terasa, dostava); bira se po kasi.',
      '- **Happy hour**: niže cene u određene dane i sate - kasa ih primenjuje sama.',
    ],
  },
  {
    id: 'admin-izvestaji', area: 'admin', title: 'Pazar, izveštaji i računi', pages: ['calendar', 'report', 'receipts', 'shiftTools', 'sold'],
    body: [
      '- **Specifikacija pazara**: kalendar dana; klik na dan → promet po zaposlenima, načinima plaćanja i artiklima, štampa.',
      '- **Specifikacija izdatih artikala**: levo početna i završna smena, tip računa (promet, reprezentacija), „Za vreme“ od-do, `Pronađi`; zatim liste sa kućicama: korisnik, magacin, popust, kategorija, grupa, proizvod, sto. Desno: proizvod, količina, prodajna cena, prodajna vrednost i UKUPNO.',
      '- **Izveštaj prometa**: bilo koji period, po artiklima, grupama, PDV stopama.',
      '# Pretraga računa',
      'img:admin-pocetna.jpg|Pretraga računa',
      '- Levo: početna i završna smena, `Pronađi`, Otvoreni / Storno / Fiskalni (svi, da, ne), a ispod **isečak** izabranog računa - tačno kako je odštampan. Korisnik, sto, tip računa i način plaćanja biraju se u redu filtera iznad kolona tabele.',
      '- Desno tabela: boja (zeleno = naplaćen, žuto = otvoren, crveno = storniran), originalni broj, broj fiskalnog isečka, tip, sto, korisnik, vreme kreiranja i štampanja, popust, komitent, način plaćanja, količina, iznos; u dnu prosek i zbir.',
      '- Dole: `Storniranje` - isti prozor kao na kasi (izbor stavki i količina, razlog, način povraćaja, PIN); novac se vraća iz kase gde je račun izdat, a ako tamo smena nije otvorena - iz otvorene smene druge kase; `Promeni način plaćanja` (npr. kartica → gotovina, zbir isti, dok su dan i smena otvoreni), `Kopija fiskalnog računa` (štampa na kasi gde je izdat).',
      '- **Otvaranje i zatvaranje smene**: i iz ADMIN-a (npr. konobar sa telefona) - datum i naziv smene su već predloženi. Zatvaranje traži da su svi stolovi naplaćeni i smene na kasama zatvorene.',
      '- **Spajanje smena**: izaberete dve zatvorene smene; **ostaje početna** (ranije otvorena) - Ponedeljak + Ponedeljak1 = Ponedeljak.',
      '- **Podela smene**: smena nije zatvorena na vreme (npr. sreda, a danas je petak). Izaberite sredu, **datum nove smene** četvrtak i **vreme preseka** → sve od tada je „Četvrtak“. Zatim isto za četvrtak sa datumom petak.',
    ],
  },
  {
    id: 'admin-stampa', area: 'admin', title: 'Štampači i izgled računa', pages: ['groupPrinting', 'printing', 'appSettings'],
    body: [
      '# Štampanje grupa',
      '- Dodajte štampač: naziv iz Windowsa (npr. „GenericSank_40“, „Bixolon“) ili mrežni (IP adresa, port 9100). Širina papira 80 mm ili 58 mm.',
      '- Uz štampač izaberite **računar** na koji je priključen (USB štampač) - mrežni štampač može „bilo koji“.',
      '- Za svaku kategoriju (Šank, Kuhinja) izaberite štampač porudžbina.',
      '! U Windows podešavanju drajvera papir postavite na 80 × 3276 mm (beskonačna rolna), ne A4/80×297.',
      '# Podešavanje aplikacije',
      '- **Podaci o računima**: PIB, firma, prodajno mesto, adresa, ESIR broj, matični broj, žiro račun, telefon, email, sajt, tekst ispod zaglavlja, **logo**, veličina slova porudžbina. Desno je pregled isečka.',
      '- **Reprezentacija (na kuću)** - na kartici Podaci o računima birate jedan od dva izgleda (sa slikom): **fiskalni račun** sa natpisom „ОВО ЈЕ ФИСКАЛНИ РАЧУН - РЕПРЕЗЕНТАЦИЈА“ na dnu, ili **kratak isečak** kao porudžbina (sto, konobar, vreme, stavke, „Za naplatu“ posle popusta).',
      '- **Elektronska fiskalizacija**: TEST / LPFR / VPFR, **slika na kraju računa**, **tekst na kraju računa** i **datum od-do** (npr. čestitka samo za praznike; bez datuma = uvek).',
      '- **Podešavanje aplikacije** (kasa), **Fiskalni** (red računa), **Print server** (red štampe, Print Bridge, KDS).',
      '# Po računaru',
      '- Podešavanje računara → **Štampa**: štampač računa te kase, „Štampaj logo na fiskalnom računu“, „Štampaj tekst i sliku na kraju računa“.',
    ],
  },
  {
    id: 'admin-racunari', area: 'admin', title: 'Podešavanje računara (kase i KDS ekrani)', pages: ['computers'],
    body: [
      'Levo su računari, desno tabovi za izabrani računar:',
      '- **Osnovni podaci**: naziv, cenovnik, aktivan.',
      '- **Izgled (grupe)**: koje grupe se vide (npr. kasa na šanku bez hrane). **Funkcije**: koja dugmad postoje.',
      '- **Štampa**: štampač računa, logo i kraj računa na ovom računaru. Kasa sama štampa račun posle naplate (vreme štampe se vidi u Pretrazi računa); ako fiskalni uređaj sam štampa, isključite automatsku štampu.',
      '- **Elektronska fiskalizacija**: Koristi VPFR, LPFR URL, putanja do pfx, lozinka za pfx, PAK, PIN, JID. `Proveri vezu` proverava bez izdavanja računa.',
      '! Račune šalje glavna kasa: „localhost“ znači glavni računar, a putanja do pfx je na glavnom računaru. LPFR na drugoj kasi upišite njenom IP adresom.',
    ],
  },
  {
    id: 'admin-fiskal', area: 'admin', title: 'Fiskalizacija', pages: ['fiscal'],
    body: [
      '- Dok je izabran **TEST**, računi su ОБУКА i nisu fiskalni.',
      '- Za prave račune: Podešavanje aplikacije → Elektronska fiskalizacija = LPFR ili VPFR, a u Podešavanje računara → Elektronska fiskalizacija podaci procesora za svaku kasu.',
      '- Fiskalni (red računa) prikazuje svaki fiskalni zahtev: potpisan, čeka, neuspeo. Neuspeo: `Ponovi` kad se veza vrati.',
      '! Naplata nikad ne čeka fiskalni sistem: ako LPFR ne radi, račun se šalje sam čim proradi.',
    ],
  },
  {
    id: 'admin-stolovi', area: 'admin', title: 'Mapa stolova i hotelske sobe', pages: ['tables'],
    body: [
      'img:admin-stolovi.jpg|Mapa stolova',
      '- Gore: `Postavi pozadinu` / `Ukloni pozadinu` (slika sale), `Dodaj izabrane stolove`, `Dodaj stolove` (od broja do broja, npr. 1-20), `Obriši sve stolove`, `Dodaj mapu` (naziv i odmah slika pozadine), `Obriši mapu`, pa mape (SALA, BAŠTA…). Dvoklik na mapu je preimenuje.',
      '- Levo su svi stolovi: štiklirajte stolove sa druge mape pa `Dodaj izabrane stolove` - prelaze na ovu mapu.',
      '- Stolovi se prevlače mišem, ugao dole desno menja veličinu. **Dvoklik ili desni klik** na sto: naziv, broj mesta, oblik, boja, brisanje. `Sačuvaj raspored` posle pomeranja.',
      '- **Soba** (hotel): račun sobe ostaje otvoren i preko zatvaranja dana - gost plaća pri odlasku.',
    ],
  },
  {
    id: 'admin-qr', area: 'admin', title: 'QR kodovi stolova (gosti naručuju sami)', pages: ['tables'],
    body: [
      'img:admin-qr.jpg|QR kodovi stolova',
      '1. ADMIN → Mapa stolova → `QR kodovi`.',
      '2. Proverite **adresu u QR kodu**: mora biti IP adresa glavne kase u mreži lokala (npr. http://192.168.1.10:3000), ne „localhost“. Program nudi adrese koje glavna kasa ima. `Zapamti adresu`.',
      '3. Probajte jedan kod svojim telefonom (`otvori meni` ili skenirajte sa ekrana).',
      '4. `Štampaj QR kodove` - na A4 po 9 kartica (sto, „Skenirajte i naručite“); isecite i zalepite na stolove.',
      '- Gosti moraju biti na **Wi-Fi mreži lokala**.',
      '- Kvačica „Naručivanje preko QR koda je uključeno“ isključuje sve kodove odjednom.',
      '- `Novi kod` za jedan sto: stari kod prestaje da radi (npr. ako je nalepnica odneta).',
      '! Meni prikazuje aktivne prodajne artikle i osnovne cene po grupama. Dodaci (Bez šećera…) se biraju kao i na kasi.',
    ],
  },
  {
    id: 'admin-kasa', area: 'admin', title: 'Podešavanja kase i dnevnik', pages: ['appSettings', 'activity'],
    body: [
      '- Podešavanje aplikacije → **Podešavanje aplikacije**: „PIN po stolu“ (konobar ukucava šifru pri svakom otvaranju stola) i čuvar ekrana (tekst ili slika naziva lokala).',
      '- **Dnevnik aktivnosti**: ko je i kada šta uradio (storno, promena cene, prijava, knjiženje) - ne može se brisati.',
    ],
  },

  // ------------------------------------------------------------------ KDS
  {
    id: 'kds-rad', area: 'kds', title: 'Rad na KDS ekranu',
    body: [
      'img:kds.jpg|KDS: kartice porudžbina',
      'KDS je ekran (tablet, TV, računar) u kuhinji ili na šanku. Otvara se u pregledaču na adresi koju glavna kasa pokaže na `Ctrl+Shift+A` (npr. http://192.168.1.10:3000/kds). Prijava: korisničko ime **tv**, šifra **tv**.',
      '- Svaka porudžbina je **kartica**: sto, konobar, vreme, stavke sa napomenama.',
      '- **Klik na stavku** je precrtava (gotova). Ponovni klik vraća.',
      '- **Klik na zaglavlje kartice** uklanja celu karticu (porudžbina izdata).',
      '- Boja kartice pokazuje koliko porudžbina čeka (zelena → žuta → crvena).',
      '- `Završene`: poslednje uklonjene kartice, ako je nešto sklonjeno greškom.',
    ],
  },
  {
    id: 'kds-podesavanja', area: 'kds', title: 'Podešavanja KDS ekrana', pages: ['printing'],
    body: [
      '`⚙ Podešavanja ekrana` na samom KDS-u:',
      '- **Kategorije i grupe**: šta ovaj ekran prikazuje - npr. jedan ekran samo Roštilj, drugi samo Salate.',
      '- **Izgled**: tamna/svetla pozadina, kartice u boji statusa, veličina slova, broj kolona, redosled.',
      '- **Tajmer**: posle koliko minuta je kartica žuta, a posle koliko crvena.',
      '- **Zvuk**: kratak signal za novu porudžbinu (`Uključi zvuk` - pregledač traži jedan klik).',
      'Podešavanja se pamte na tom ekranu.',
    ],
  },

  // ------------------------------------------------------------------ INSTALACIJA
  {
    id: 'inst-vise-kasa', area: 'instalacija', title: 'Više kasa u lokalu',
    body: [
      '1. Na glavnom računaru instalirajte „POS Kasa“ i izaberite **Glavna kasa**. Baza je na njemu.',
      '2. Na glavnoj kasi `Ctrl+Shift+A` pokazuje IP adresu (npr. 192.168.1.10).',
      '3. Na drugom računaru instalirajte isti program i izaberite **Dodatna kasa**, upišite IP glavne kase i administratorski nalog.',
      '4. U ADMIN → Računari podesite štampač računa i grupe za novu kasu.',
      '! Glavna kasa mora biti uključena dok druge rade. Windows zaštitni zid treba da dozvoli port 3000.',
    ],
  },
  {
    id: 'inst-backup', area: 'instalacija', title: 'Rezervna kopija baze',
    body: [
      '- Glavna kasa sama pravi kopiju pri pokretanju i pri gašenju (najviše jednom u 20 sati), čuva 7 poslednjih.',
      '- Poslednja kopija se vidi na `Ctrl+Shift+A`.',
      '- Kopija na USB/drugi disk: u `%APPDATA%\\POS Kasa\\config.json` dodajte `"backupDir": "D:\\\\POS-backup"`.',
      '! Jednom nedeljno odnesite kopiju van lokala (USB ili OneDrive folder). Požar ili krađa računara inače nose i bazu i kopije.',
      '- Povratak: zatvorite kasu, preimenujte folder `db`, kopirajte željenu `baza-…` kao `db`, pokrenite kasu.',
    ],
  },
  {
    id: 'inst-od-kuce', area: 'instalacija', title: 'ADMIN na drugom računaru, telefonu i od kuće',
    body: [
      'ADMIN služi glavna kasa - svi otvaraju istu adresu u pregledaču i rade nad istom bazom. Prijava je šifrom.',
      '- **Na koji server sam povezan?** Na ekranu prijave i gore desno u ADMIN-u piše server (npr. „ovaj računar (glavna kasa)“ ili „192.168.10.88:3000“). ADMIN pri svakom otvaranju traži šifru.',
      '# Backoffice na drugom računaru (kancelarija, kuća)',
      '1. Na tom računaru instalirajte Servio i izaberite **Povezivanje na glavnu kasu**: upišite IP adresu glavne kase, ADMIN korisnika i lozinku.',
      '2. Ikonica „Servio ADMIN“ otvara ADMIN povezan na glavnu kasu - ista baza, iste šifre.',
      '3. Promena servera kasnije: na ekranu prijave ADMIN-a `Promeni server` - program se ponovo pokreće i pita na koju glavnu kasu da se poveže.',
      '- Bez instalacije: u pregledaču otvorite **http://<IP glavne kase>:<port>/admin** (u lokalu ili preko VPN-a).',
      '# U lokalu',
      '- Adresa sa `Ctrl+Shift+A` na glavnoj kasi, npr. **http://192.168.10.88:3000/admin**. Telefon mora biti na Wi-Fi mreži lokala.',
      '- U ruteru dodelite glavnoj kasi stalnu IP adresu (DHCP rezervacija), da se adresa ne menja.',
      '- Drugi port (npr. 8081): zatvorite kasu, u `%APPDATA%\\POS Kasa\\config.json` promenite `"port": 3000` u `"port": 8081` i pokrenite kasu.',
      '# Van objekta',
      '1. **Tailscale** (preporuka): besplatan program na glavnoj kasi i na telefonu/računaru, isti nalog → **http://100.x.y.z:3000/admin**. Ruter se ne dira.',
      '2. **Javna adresa**: u ruteru prosledite spoljni port (npr. 8083) na IP glavne kase, port 3000 → od kuće **http://89.86.120.23:8083/admin** (javna IP lokala ili DDNS ime).',
      '! Pre otvaranja prema internetu obavezno promenite šifru ADMIN-a (ne 0000). Veza preko javne adrese nije šifrovana - za stalni rad bolji je Tailscale.',
    ],
  },
];

/** Teme za stranicu ADMIN-a (dugme "?"). */
export const topicsForPage = (page: string) => TOPICS.filter((t) => t.pages?.includes(page));
