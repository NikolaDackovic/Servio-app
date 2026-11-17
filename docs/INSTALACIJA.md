# Instalacija Servio kase (Windows)

Kasa se instalira kao program na računar u lokalu. Sve radi lokalno, bez interneta:
baza, server i kasa su na tom računaru. ADMIN i KDS se otvaraju u pregledaču sa bilo kog
uređaja u istoj mreži lokala (računar u kancelariji, tablet u kuhinji).

## Instalacija

1. Pokrenite `Servio-Setup-<verzija>.exe` i pratite korake (izbor foldera je opcion). Na radnoj površini nastaju ikonice **Servio** (kasa) i **Servio ADMIN** (backoffice na ovom računaru).
2. Kasa se otvara sama, preko celog ekrana. Prvo pokretanje traje oko minut (pravi se baza).
3. Ekran **Prvo pokretanje**: podaci firme (naziv, PIB, prodajno mesto, adresa). Nalozi se prave sami:
   **ADMIN / 0000** (ADMIN i kasa), **KON01 / 11**, **KON02 / 22** (konobari), **tv / tv** (KDS). Za probu postoji dugme **Demo podaci**.
   Zaboravljena šifra ili baza iz starije verzije: na glavnoj kasi **Ctrl+Shift+R** vraća ove naloge.
4. Windows može da pita da li „Servio" sme da koristi mrežu - izaberite **Privatne mreže** i potvrdite.
   Bez toga ADMIN i KDS ne mogu da se otvore sa drugih uređaja (kasa i dalje radi).

Kasa se posle toga pali sama sa Windows-om.

## ADMIN i KDS

Na kasi pritisnite **Ctrl+Shift+A** - prikazuju se adrese, npr.:

- ADMIN: `http://192.168.1.10:3000/admin` (korisničko ime i lozinka administratora)
- KDS: `http://192.168.1.10:3000/kds` (PIN kuvara; podešavanja ekrana na ⚙)

Preporuka: u ruteru lokala dodelite kasi stalnu IP adresu, da adrese ne bi menjale.

## Više kasa u lokalu (POS-PC2, POS-PC3…)

Jedna kasa je **glavna** (na njoj je baza). Ostale su **dodatne** i povezuju se na glavnu u mreži lokala.

1. Na glavnoj kasi: Ctrl+Shift+A prikazuje IP adresu (npr. 192.168.1.10).
2. Na dodatnom računaru instalirajte isti program. Pri prvom pokretanju izaberite **Dodatna kasa**, upišite IP glavne
   kase i korisničko ime/lozinku administratora.
3. Računar se sam prijavi: u ADMIN → Podešavanja → Računari pojavi se pod svojim imenom (npr. POS-PC2), sa svojim
   Print Bridge-om („Štampa POS-PC2").
4. U ADMIN → Podešavanja → Računari za svaku kasu podesite: štampač računa (fiskalni isečak), cenovnik, grupe koje se
   vide, dugmad, i fiskalizaciju (VPFR ili LPFR, PIN, JID).

Glavna kasa mora biti upaljena dok rade dodatne (dodatna čeka i javlja „Čekam glavnu kasu").

## Štampači

ADMIN → Štampanje → Štampanje grupa:

- **USB štampač** (npr. Bixolon za račune): instalirajte drajver u Windowsu na računaru na koji je priključen. U ADMIN-u
  dodajte štampač: tačan naziv iz Windowsa (npr. `GenericSank_40`), veza „Windows", i **računar** na koji je priključen.
  Taj štampač štampa samo kasa tog računara.
- **Mrežni štampač** (kuhinja, šank): veza „Mrežni", IP adresa i port (obično 9100), računar „bilo koji".
- **Širina trake**: 80 mm (48 znakova) ili 58 mm (32 znaka). Veličina papira u drajveru (80×3276, 80×297…) ne utiče:
  kasa šalje komande direktno štampaču i seče papir posle svakog isečka.
- **Grupe → štampač**: npr. Bezalkoholna pića → GenericSank_40, Glavna jela → GenericKuhinja_40. Grupa bez svog
  štampača štampa na štampač svoje kategorije (Šank, Kuhinja).
- **Kvačice i ćirilica**: u `config.json` polje `codepage` (podrazumevano `cp852`; `cp1250` latinica,
  `cp1251` ćirilica, `ascii` bez kvačica). Probna strana: Štampanje → Napredno.

## ADMIN od kuće (preko interneta)

Kasa radi u lokalu i nije izložena internetu (namerno - bezbednost). Za pristup od kuće preporuka je besplatan
**VPN** (npr. Tailscale): instalira se na glavnu kasu i na kućni računar/telefon, i ADMIN se otvara na
`http://<tailscale-ip-kase>:3000/admin`. Ne otvarajte port 3000 na ruteru ka internetu (nema šifrovane veze).

## Hotel (sobe)

U ADMIN → Mape stolova označite sto kao **Hotelska soba**. Otvoren račun sobe ne blokira zatvaranje smene i dana:
prelazi u sledeći dan i naplaćuje se pri odjavi gosta (naplata se knjiži u dan naplate).

## Uloge

Podrazumevane: Administrator, Vlasnik, Menadžer, Kasir, Konobar, Šanker (kao konobar + ekran šanka), Kuhinja (KDS),
Knjigovođa (dokumenta, stanje, izveštaji, dnevnik - bez rada na kasi). Prava se menjaju u ADMIN → Korisnici → Uloge i prava.

## Prečice na kasi

- **F11** - ceo ekran uključen/isključen
- **Ctrl+Shift+A** - adrese za ADMIN, KDS i dodatne kase

## Gde su podaci

`%APPDATA%\POS Kasa`

| Folder/fajl | Šta je |
|---|---|
| `config.json` | tajni ključevi ove kase (prave se pri prvom pokretanju) i portovi (server 3000, baza 5433) |
| `db\` | baza (PostgreSQL) |
| `logs\kasa.log`, `logs\postgres.log` | zapisi za podršku |

Deinstalacija programa **ne briše** podatke. Za potpuno brisanje obrišite i ovaj folder.

## Rezervna kopija

Glavna kasa **sama** pravi kopiju baze u `%APPDATA%\POS Kasa\backup\baza-GGGG-MM-DD-SS-MM`:
pri pokretanju programa (pre podizanja baze) i pri urednom gašenju (gašenje računara, izlaz) — najviše jednom u 20 sati.
Čuva se poslednjih 7 kopija. Kopira se dok baza miruje, pa je kopija dosledna. Poslednja kopija se vidi na **Ctrl+Shift+A**.

Kopija na drugom disku / USB-u / mrežnom folderu: u `%APPDATA%\POS Kasa\config.json` dodajte
`"backupDir": "D:\\POS-backup"` — kopija se pravi i tamo. **Preporuka:** jedna kopija van lokala (USB koji se nosi kući ili OneDrive folder).

Povratak: zatvorite kasu, preimenujte folder `db` (npr. `db-staro`), kopirajte željeni `baza-…` folder kao `db`, pokrenite kasu.

## Pravljenje instalacije (za programere)

```bash
npm install
npm run dist -w apps/desktop      # → apps/desktop/release/POS-Kasa-Setup-<verzija>.exe
```

Instalacija sadrži: server (API spojen u jedan fajl), kasu/KDS i ADMIN (statički fajlovi),
SQL migracije i PostgreSQL za Windows. Migracije se primenjuju same pri svakom pokretanju.

Napomena za VS Code: terminal VS Code-a postavlja `ELECTRON_RUN_AS_NODE=1`; pre `electron .` ili
`electron-builder` tu promenljivu treba ukloniti (`env -u ELECTRON_RUN_AS_NODE …`).

## Prečice na kasi
- **Ctrl+Shift+A** - adrese (ADMIN, KDS, dodatne kase) i poslednja rezervna kopija
- **Ctrl+Shift+D** ili dugme „ADMIN (backoffice)" - ADMIN u prozoru na ovom računaru
- **Ctrl+Shift+R** (glavna kasa) - vrati podrazumevane naloge
- **F11** - ceo ekran

Podaci ostaju u `%APPDATA%POS Kasa` i posle preimenovanja programa u Servio (nova instalacija preko stare zadržava bazu).

## ADMIN i praćenje sa drugog računara, telefona ili od kuće

ADMIN je stranica koju služi **glavna kasa**. Svi (drugi računari, telefon, kancelarija) otvaraju istu adresu u pregledaču
i rade nad istom bazom. Prijava je šifrom (kao na kasi).

**U lokalu (ista mreža):** `http://<IP glavne kase>:<port>/admin` - npr. `http://192.168.10.88:3000/admin`.
IP i port se vide na glavnoj kasi sa **Ctrl+Shift+A**. Telefon mora biti na Wi-Fi mreži lokala.
Da se IP ne bi menjao: u ruteru dodelite glavnoj kasi stalnu adresu (DHCP rezervacija).

**Drugi port (npr. 8081):** zatvorite kasu, u `%APPDATA%\POS Kasa\config.json` promenite `"port": 3000` u `"port": 8081`,
pokrenite kasu. Adresa je tada `http://192.168.10.88:8081/admin`. (Dodatne kase posle toga treba povezati na novi port.)

**Van objekta (od kuće), dva načina:**
1. **Tailscale (preporuka, bez otvaranja rutera):** besplatan program na glavnoj kasi i na vašem telefonu/računaru,
   isti nalog. ADMIN se otvara na Tailscale adresi glavne kase: `http://100.x.y.z:3000/admin`. Niko drugi ne vidi kasu.
2. **Javna adresa i prosleđivanje porta na ruteru:** u ruteru napravite pravilo *spoljni port 8083 → 192.168.10.88:3000*
   (TCP). Od kuće: `http://89.86.120.23:8083/admin` (javna IP adresa lokala; ako se menja - DDNS ime iz rutera).
   Pre toga obavezno promenite šifru ADMIN-a (ne 0000) i ostavite samo naloge koji smeju u ADMIN.
   Veza je tada nešifrovana (http) - za stalni rad od kuće bolji je Tailscale.

Windows zaštitni zid: pri prvom pokretanju dozvolite „Servio“ na **privatnoj mreži**.
