# Kupac na računu, načini plaćanja i fiskalizacija

> Stanje: fiskalni red, TEST adapter i **ESIR veza ka LPFR/VPFR** (API v3 Tehničkog vodiča). Veza je proverena samo prema **simuliranom** LPFR-u u testovima — **nije još proverena sa stvarnim LPFR uređajem/programom ni sa VPFR-om Poreske uprave**, a ESIR nije sertifikovan. Pre rada sa pravim računima: proba u Training režimu sa pravim LPFR-om i dogovor sa knjigovođom.

## Uključivanje (TEST → pravi računi)
1. ADMIN → Računari → kasa → *Fiskalizacija ove kase*: LPFR adresa (npr. `localhost:5555`) + PIN, ili VPFR (sertifikat `.pfx`, lozinka, PAC). Dugme **Proveri vezu** čita status PFR-a i otključava ga PIN-om — račun se ne izdaje.
2. ADMIN → Podešavanja kase → *Fiskalni procesor*: **TEST** (podrazumevano) ili **LPFR / VPFR – pravi računi**. Od tog trenutka svaka naplata i povraćaj idu u PFR kase koja ih izdaje.
- Račune šalje **server na glavnoj kasi**: `localhost` u adresi LPFR-a je glavni računar. LPFR druge kase upisati njenom IP adresom (npr. `192.168.1.21:5555`); sertifikat za VPFR mora biti na glavnom računaru.
- PIN, PAC i lozinka sertifikata čitaju se iz podešavanja kase u trenutku slanja; **ne upisuju se u fiskalni red** i kasa ih ne vidi (`/computers/me`).

## Fiskalni red
- Kada račun pređe u PAID, u **istoj transakciji** nastaje zapis u `fiscal_receipts` (status PENDING) sa zahtevom: stavke posle popusta, oznake PDV-a, načini plaćanja, kupac, kasir, kasa.
- Posle commit-a zahtev se šalje (čeka se najviše 5 s da naplata ne visi). PFR nedostupan / 5xx: ponovni pokušaji sa rastućim razmakom (5 s … 10 min), najviše 8. Odbijen račun (4xx) → FAILED odmah; ručni „Ponovi“ u ADMIN → Fiskalizacija. **Naplata ne zavisi od fiskalnog sistema.**
- Račun se prikazuje kao fiskalizovan **samo** kada je status SIGNED i provajder nije testni. Broj računa, vreme PFR-a, brojač (npr. `12/15ПП`) i verifikacioni URL (QR) na isečku dolaze iz odgovora PFR-a.
- `FISCAL_PROVIDER=NONE` (env) potpuno isključuje fiskalni red.

### ESIR zahtev (src/modules/fiscal/esir.ts)
- LPFR: `GET /api/v3/status` (gsc 1300 = nema kartice, 1500 = traži PIN) → `POST /api/v3/pin` → `POST /api/v3/invoices`.
- VPFR: `POST /api/v3/invoices` preko https sa klijentskim sertifikatom i zaglavljem `PAC`.
- Telo: `invoiceType` Normal/Training, `transactionType` Sale/Refund (refundacija nosi `referentDocumentNumber/DT` računa prodaje), `payment[]`, `items[]` (ćirilične oznake Ђ/Е/А/Г/Ж, jedinična cena posle popusta), `cashier`, `buyerId`, broj ESIR-a/broj računa.
- Mapiranje plaćanja: Gotovina → Cash, Kartica → Card, Virman → WireTransfer, Reprezentacija → Other.

### Šta još nije urađeno
Kopija računa preko PFR-a (Copy) — kopija se sada štampa lokalno sa oznakom КОПИЈА; avansni računi; preuzimanje poreskih stopa iz PFR-a; žurnal sa PFR-a na isečku (koristi se sopstveni raspored); sertifikacija ESIR-a. Poreski tretman reprezentacije proveriti sa knjigovođom.

## Reprezentacija
Na kasi: REPREZENTACIJA → razlog (Čast kuće / Osoblje / Reprezentacija). Roba se skida sa stanja, novac se ne evidentira. Isečak piše samo **РЕПРЕЗЕНТАЦИЈА** i razlog — bez TEST/ОБУКА oznaka, i u test režimu.
## Identifikacija kupca (`orders.buyer_id_type`, `orders.buyer_id`)
Šifre vrste identifikacije prema šifarniku eFiskalizacije (izvor: javno uputstvo knjigovodstvenog softvera Minimax koje prenosi šifarnik PU):

| Šifra | Identifikacija | Za koga | Provera u kasi |
|---|---|---|---|
| 10 | PIB | domaće pravno lice | 9 cifara + kontrolna cifra (ISO 7064 MOD 11,10) |
| 11 | JMBG | domaći preduzetnik | 13 cifara + kontrolna cifra |
| 12 | PIB i JBKJS | korisnik javnih sredstava | `PIB:JBKJS` (9:5 cifara) |
| 20 | Lična karta | domaće fizičko lice | format |
| 21 | Izbeglička legitimacija | domaće fizičko lice | format |
| 22 | EBS | strano lice sa boravkom u Srbiji | format |
| 23 | Pasoš (domaći) | domaće fizičko lice | format |
| 30 | Pasoš (strani) | strano fizičko lice | format |
| 31 | Diplomatska legitimacija / LK | strani diplomata | format |
| 32–35 | Lična karta MKD / MNE / ALB / BIH | strano fizičko lice | format |
| 40 | Strani poreski broj (TIN) | — | format |

**Pre produkcione fiskalizacije** spisak uskladiti sa važećim Tehničkim vodičem PU (https://www.purs.gov.rs/eFiskalizacija/tehnicki-vodic.html).

## Opciono polje kupca (`buyer_optional_basis`, `buyer_optional_value`)
Čuva se kao **osnov + broj** (npr. „LNPDV — lice sa pravom na oslobođenje od PDV-a“ + broj). Zvanične numeričke šifre ovog polja nisam mogao da potvrdim iz javnog izvora, pa ih kasa namerno ne izmišlja; mapiranje osnova na šifre se radi pri povezivanju sa fiskalnim uređajem, iz Tehničkog vodiča.

## Načini plaćanja
| Kasa | Napomena |
|---|---|
| Gotovina | primljeno i kusur; ulazi u očekivanu gotovinu kase |
| Kartica | ceo ili deo iznosa |
| Mix | deo kartica, ostatak gotovina — **jedna transakcija**, sve-ili-ništa |
| Virman | prenos na račun |
| Reprezentacija | samo ceo račun, bez drugih načina; **nije naplaćen novac** — u smeni, danu i izveštaju se prikazuje odvojeno. Poreski tretman reprezentacije proveriti sa knjigovođom pre produkcije. |

## Popusti
Definišu se u ADMIN-u (naziv, procenat). Na kasi se primenjuju na ceo račun; popust se raspoređuje po stavkama (`order_items.discount_amount = round(iznos × % / 100, 2)`) da bi PDV rekapitulacija po stopama bila tačna. `orders.total = subtotal − discount_total` je i CHECK ograničenje u bazi.
