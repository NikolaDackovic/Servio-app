# Kupac na računu, načini plaćanja i fiskalizacija

> Stanje: podaci se **čuvaju na računu**, ali se još ne šalju fiskalnom uređaju (fiskalizacija nije povezana — TEST režim).

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
