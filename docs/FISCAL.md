# Kupac na računu, načini plaćanja i fiskalizacija

> Stanje: postoji **fiskalni red i TESTNI adapter**. Stvarna integracija sa PFR/ESIR sistemom Poreske uprave **ne postoji** — nijedan račun iz ovog sistema nije fiskalni račun.

## Fiskalni red (faza 3)
- Kada račun pređe u PAID, u **istoj transakciji** nastaje zapis u `fiscal_receipts` (status PENDING) sa zahtevom: stavke posle popusta, oznake PDV-a, načini plaćanja, kupac.
- Posle commit-a zahtev se šalje provajderu (čeka se najviše 5 s da odgovor naplate ne visi). Neuspeh: ponovni pokušaji sa rastućim razmakom (5 s … 10 min), najviše 8; trajna greška → FAILED i ručni „Ponovi“ u ADMIN → Fiskalizacija. **Naplata ne zavisi od fiskalnog sistema.**
- Račun se prikazuje kao fiskalizovan **samo** kada je status SIGNED i provajder nije testni. CHECK u bazi: SIGNED mora imati broj i vreme.
- Interfejs `FiscalizationProvider` (src/modules/fiscal/fiscal.ts): `sign(zahtev) → {ok, invoiceNumber, verificationUrl} | {ok:false, retryable, error}`.
- `FISCAL_PROVIDER=TEST` (podrazumevano): `TestFiscalProvider` ništa ne šalje van sistema; broj je `TEST-YYYYMMDD-XXXXXXXX-N`, vrsta računa TRAINING, bez verifikacionog URL-a. Kasa, ADMIN, `/health` i odštampan račun jasno pišu „TEST — OVO NIJE FISKALNI RAČUN“.
- `FISCAL_PROVIDER=NONE`: fiskalni zahtevi se ne prave; račun prikazuje „Nije fiskalizovano“.
- Mapiranje načina plaćanja u zahtevu: Gotovina → Cash, Kartica → Card, Virman → WireTransfer, Reprezentacija → Other. **Nije provereno** prema Tehničkom vodiču — proveriti pre integracije (posebno reprezentaciju).

### Šta nedostaje za stvarnu fiskalizaciju
Sertifikat/bezbednosni element, ESIR/PFR API prema važećem Tehničkom vodiču, vrste računa (promet, avans, kopija, refundacija, obuka), QR/verifikacioni URL na računu, žurnal, rad bez veze (lokalni PFR), sertifikacija ESIR-a. Ništa od toga nije urađeno.


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
