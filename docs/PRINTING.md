# Štampa i Print Bridge

> **Stanje: projektovano, nije implementirano.** U iteraciji 1 nijedna akcija ne štampa i aplikacija to ne tvrdi. "Pošalji" označava stavke kao poslate u pripremu (tura N) — to je ulaz za štampu i KDS u iteraciji 2.

## Zašto poseban servis
Web pregledač ne može pouzdano da šalje sirove ESC/POS komande na USB/mrežni štampač niti da štampa bez dijaloga. `window.print()` nije rešenje za kuhinjske blokove. Zato u lokalu radi mali **Print Bridge** servis na Windows računaru.

## Tok
```
Pošalji (tura N) ──▶ rutiranje po pripremnoj poziciji ──▶ print_jobs (u istoj transakciji)
                                                            │ status: PENDING
Print Bridge ◀── preuzima poslove svog lokala (outbound HTTPS/WebSocket, bez otvaranja porta u lokalu)
   │ adapter: ESC/POS-TCP · Windows spooler (RAW / drajver) · SIMULATED
   └──▶ potvrda: PRINTED / FAILED(greška) ──▶ UI prikazuje neuspeh, ručni "ponovi"
```

## Garancije
- **Bez duple štampe**: posao ima jedinstven ključ `(order_id, send_batch, station_id, kind)`; bridge potvrđuje id posla, server ne vraća već potvrđen posao. Ponovna štampa je poseban posao sa oznakom **KOPIJA**.
- **Bez tihog gubitka**: posao ostaje `PENDING`/`FAILED` dok se ne potvrdi; UI prikazuje broj neodštampanih.
- **Simulacija je vidljiva**: SIMULATED adapter upisuje status `SIMULATED`, nikada `PRINTED`.

## Podrška štampačima (plan)
| Tip | Adapter | Napomena |
|---|---|---|
| Mrežni termalni (ESC/POS, port 9100) | ESC/POS-TCP | Najpouzdaniji; test: "testna stranica" iz backoffice-a |
| USB termalni sa Windows drajverom | Windows spooler RAW | Štampač mora biti instaliran u Windowsu; bridge koristi ime štampača |
| Običan A4 štampač | Windows spooler + PDF/GDI | Za fakture i izveštaje, ne za kuhinjske blokove |
| Bluetooth | — | Nije planirano za v1; ne tvrdi se podrška |

Postupak provere kompatibilnosti: testna stranica → testni blok sa srpskim slovima (kodna strana CP1250/WPC1250 ili rasterizacija) → sečenje papira → širina 58/80 mm.

## Instalacija (plan)
Node servis pakovan kao Windows servis (npr. preko `node-windows`/NSSM), konfiguracija: URL servera, token uređaja (izdaje backoffice, opoziv moguć), lista lokalnih štampača. Komunikacija samo odlazna (bridge → server) preko HTTPS.
