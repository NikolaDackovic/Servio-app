# Štampa, KDS i Print Bridge

> Stanje (faza 3): **implementirano i testirano** — rutiranje, red štampe u bazi, Print Bridge (Node servis), ESC/POS preko mreže, simulacija, KDS ekran sa realnim vremenom. **Windows RAW adapter je napisan, ali nije proveren na stvarnom Windows računaru i štampaču.** Nijedan stvarni termalni štampač nije testiran — mrežni adapter je proveren lažnim TCP štampačem u testovima.

## Zašto poseban servis
Pregledač ne može pouzdano da šalje sirove ESC/POS komande na USB/mrežni štampač niti da štampa bez dijaloga. Zato u lokalu radi mali **Print Bridge** (`apps/print-bridge`) koji preuzima zadatke sa servera.

## Tok
```
Pošalji (tura N) ─▶ rutiranje: artikal → pozicija (artikal, inače kategorija)
                 ─▶ u ISTOJ transakciji: kds_tickets (račun, tura, pozicija) + print_jobs (dedupe_key)
                 ─▶ posle commit-a: WebSocket događaji (kds.ticket.created, order.updated)
Print Bridge ── POST /bridge/jobs/claim (X-Bridge-Key) ── atomski zakup (FOR UPDATE SKIP LOCKED)
   │ adapter: NETWORK_ESCPOS (TCP 9100) · WINDOWS_RAW (spooler) · SIMULATED (tekst fajl)
   └─▶ POST /bridge/jobs/:id/result  PRINTED | SIMULATED | FAILED(retryable?)
```

## Garancije
- **Bez duple štampe iz baze**: `dedupe_key` je jedinstven (`ticket:{račun}:{tura}:{pozicija}`, `void:{stavka}`, `voidall:{račun}:{pozicija}`, `receipt:{račun}:{ključ}`). Ponovljeno slanje bez novih stavki ne pravi ništa; 5 paralelnih slanja → jedna tura (test).
- **Dva bridge-a ne dobijaju isti zadatak** (`FOR UPDATE SKIP LOCKED`, test sa paralelnim preuzimanjem).
- **Bez tihog gubitka**: zadatak ostaje PENDING dok ga bridge ne preuzme; ako bridge padne usred štampe, zadatak se posle 60 s vraća u red. Greška: ponovni pokušaj sa rastućim razmakom (5 s … 5 min), najviše 6; trajna greška → FAILED i „Ponovi“ u ADMIN → Štampa i KDS → Red štampe.
- **Ograničenje ESC/POS-a**: PRINTED znači da je štampač primio sve bajtove i uredno zatvorio vezu. Protokol nema standardnu potvrdu „odštampano“ (nestanak papira se ne vidi). Ako bridge ne uspe da javi rezultat, zadatak će se posle isteka zakupa odštampati ponovo — svesno: dupli blok je manje zlo od izgubljenog.
- **Simulacija je vidljiva**: SIMULATED štampač upisuje blok u `apps/print-bridge/simulated-output/*.txt` i javlja status SIMULATED, nikada PRINTED.
- **Račun koji nije fiskalni** na papiru ima „TEST — OVO NIJE FISKALNI RAČUN“ ili „OVO NIJE FISKALNI RAČUN“ (gore i dole). Ponovna štampa nosi oznaku KOPIJA.

## Podešavanje (ADMIN → Štampa i KDS)
1. **Štampači**: naziv, veza (Simulacija / Mrežni ESC/POS: IP + port / Windows štampač: tačan naziv), papir 58/80 mm, „Probna strana“.
2. **Pozicije i rutiranje**: pozicija (Šank, Kuhinja…), štampač pozicije, prikaz na KDS-u; kategorija → pozicija; na artiklu (Artikli i cene) može posebna pozicija.
3. **Kase i Print Bridge**: štampač računa po kasi; registracija bridge-a → ključ (prikazuje se jednom) → `apps/print-bridge/.env`.
4. **Red štampe**: stanje svakog zadatka, greška, „Ponovi“.

## Pokretanje Print Bridge-a
```
cd apps/print-bridge
copy .env.example .env      (Linux/macOS: cp)
# upisati BRIDGE_KEY i API_URL
npm run dev                 # razvoj
npm run build && npm start  # produkcija
```
Demo seed ispisuje ključ demo bridge-a u konzoli (`npm run db:seed`).

| Promenljiva | Opis |
|---|---|
| `API_URL` | npr. `http://192.168.1.10:3000/api/v1` |
| `BRIDGE_KEY` | ključ iz ADMIN-a (`pb_…`) |
| `POLL_MS` | koliko često proverava red (podrazumevano 1500 ms) |
| `CODEPAGE` | `ascii` (š→s, đ→dj; uvek čitljivo), `cp852` ili `cp1250` — proveriti probnom stranom |
| `CODEPAGE_NUMBER` | broj za ESC t n ako se razlikuje od Epson podrazumevanog (PC852=18, WPC1250=45) |
| `SIMULATED_DIR` | gde se upisuju simulirani blokovi |

### Kao Windows servis (nije testirano)
Preporuka: [NSSM](https://nssm.cc/) — `nssm install POS-PrintBridge "C:\Program Files\nodejs\node.exe" "C:\pos\apps\print-bridge\dist\main.js"`, radni direktorijum `C:\pos\apps\print-bridge`. Servis treba da radi pod nalogom koji vidi Windows štampače (za WINDOWS_RAW). Ovaj postupak **nije proveren** u ovoj iteraciji.

## Podrška štampačima
| Tip | Adapter | Stanje |
|---|---|---|
| Mrežni termalni (ESC/POS, port 9100) | NETWORK_ESCPOS | Implementirano; testirano lažnim TCP štampačem, ne stvarnim uređajem |
| USB termalni sa Windows drajverom | WINDOWS_RAW (PowerShell + winspool.drv) | Napisano, **nije testirano na Windowsu** |
| Običan A4 štampač | — | Nije podržano |
| Bluetooth | — | Nije podržano |

Postupak provere štampača: probna strana → srpska slova (promeniti `CODEPAGE` ako su pogrešna) → sečenje papira → širina 58/80 mm.

## KDS
- Uređaj tipa KDS (registracija uređaja na kasi → „KDS – Kuhinja (KDS)“) posle PIN prijave prikazuje samo ekran pripreme; korisnik mora imati pravo `kds.use` (seed: PIN 3333 „Kuhinja“).
- Kartice po poziciji, najstarije prve; boja po čekanju (10 min žuto, 20 min crveno); dodir na stavku = spremno; „Počni“, „Spremno“, „Završi“; „Završene“ sa vraćanjem greškom zatvorene kartice. Storno stavke je precrtan i crven.
- Zvuk na novu karticu (Web Audio) — pregledač ga dozvoljava tek posle dodira na „Uključi zvuk“.
- Prekid veze: crvena traka „Veza sa serverom je prekinuta — nove porudžbine možda NISU prikazane“, automatsko ponovno povezivanje (1 s → 15 s), osvežavanje na 10 s dok veza ne radi; posle povratka veze ekran se ponovo učitava.
- Kasa vidi status pripreme na stavci („Kuhinja: u pripremi / spremno“) u realnom vremenu.
