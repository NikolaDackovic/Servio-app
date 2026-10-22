# Instalacija i pokretanje

## Razvoj (Linux/macOS/Windows)
Preduslovi: Node.js 20.12+ (testirano na 22), PostgreSQL 16 (lokalno ili `docker compose up -d db`).

```bash
npm install                       # u korenu repozitorijuma (npm workspaces)
cp apps/api/.env.example apps/api/.env   # pa promeniti tajne
# kreiranje baze (ako ne koristite docker compose):
#   CREATE USER pos WITH PASSWORD 'pos_dev' CREATEDB; CREATE DATABASE pos OWNER pos;
npm run db:migrate                # primena SQL migracija
npm run db:seed                   # DEMO podaci (samo za razvoj)
npm run dev:api                   # http://localhost:3000/api/v1, Swagger: /api/docs
npm run dev:web                   # KASA  http://localhost:5173 (proxy /api → 3000)
npm run dev:admin                 # ADMIN http://localhost:5174 (proxy /api → 3000)
```

Prvi ulazak na KASU: prijava `admin@demo.local` / `Demo123!` → izbor kase ("Kasa 1 – Šank") → PIN prijava. Demo PIN-ovi: 1111 konobar, 2222 kasir, 9999 menadžer. ADMIN: `admin@demo.local` ili `menadzer@demo.local` / `Demo123!`.

Postojeća baza se ažurira sa `npm run db:migrate`: `0001` dodaje poslovni dan i smene zaposlenih (pravo `day.manage`), `0002` popuste, kupca na računu, ture, reprezentaciju i prava `order.discount` / `discount.manage`. Postojeća baza **nema demo popuste** (seed se ne ponavlja) — dodajte ih u ADMIN → Popusti.

## Windows — razvoj
1. Instalirati **PostgreSQL 16** (EDB installer sa postgresql.org). Zapamtiti lozinku korisnika `postgres`, port ostaviti 5432.
2. Napraviti korisnika i baze (PowerShell; putanja zavisi od verzije):
   ```powershell
   & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -c "CREATE USER pos WITH PASSWORD 'pos_dev' CREATEDB;"
   & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -c "CREATE DATABASE pos OWNER pos;"
   & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -c "CREATE DATABASE pos_test OWNER pos;"
   ```
3. U korenu repozitorijuma, svaku komandu u svom redu (Windows PowerShell 5 ne podržava `&&`; može i `;`):
   ```powershell
   npm install
   Copy-Item apps/api/.env.example apps/api/.env
   npm run db:migrate
   npm run db:seed
   npm run dev:api
   ```
   U drugom terminalu `npm run dev:web` (KASA, http://localhost:5173), u trećem `npm run dev:admin` (ADMIN, http://localhost:5174).

`apps/api/.env` se učitava automatski (API, migracije i seed), bez obzira iz kog foldera se komanda pokreće. Ako migracija prijavi `Uzrok: connect ECONNREFUSED 127.0.0.1:5432`, PostgreSQL servis nije pokrenut (Services → postgresql-x64-16 → Start). Ako prijavi grešku lozinke, `DATABASE_URL` u `.env` ne odgovara korisniku iz koraka 2.

npm na novijim verzijama može upozoriti `allow-scripts` za `esbuild`. Ako `npm run dev:web` javi da esbuild nije instaliran: `npm approve-scripts esbuild`, pa ponovo `npm install`.

## Docker Compose (server u lokalu ili na udaljenom serveru)
```bash
cp .env.example .env              # postaviti POSTGRES_PASSWORD, JWT_SECRET, PIN_PEPPER
docker compose up -d --build
docker compose exec api node dist/db/migrate.js
# DEMO podaci samo za probu: docker compose exec api node dist/db/seed.js
```
KASA je na portu 8080, ADMIN na 8081 (obe preko nginx-a, /api se prosleđuje API servisu). Baza **nije** izložena van Docker mreže.
> Napomena: `docker-compose.yml` i Dockerfile-ovi su napisani, ali **nisu pokrenuti** u ovoj iteraciji (u razvojnom okruženju nije bio dostupan Docker daemon). Proveriti pri prvoj instalaciji.

## Windows (lokal)
Plan za instalaciju u objektu: PostgreSQL za Windows (EDB installer) + API kao Windows servis + statički build web-a koji servira API ili IIS/nginx. **Nije testirano na Windowsu** — instalacioni paket je deo faze 3 zajedno sa Print Bridge-om.

## Backup i vraćanje
```bash
# backup (kompresovani custom format)
pg_dump -h localhost -U pos -d pos -F c -f pos_$(date +%Y%m%d_%H%M).dump
# vraćanje u praznu bazu
createdb -h localhost -U pos pos_restore
pg_restore -h localhost -U pos -d pos_restore --no-owner pos_YYYYMMDD_HHMM.dump
```
Preporuka: dnevni automatski backup (cron / Windows Task Scheduler) + kopija van lokala; povremeno probno vraćanje. U Docker okruženju: `docker compose exec db pg_dump …`.

## Konfiguracija (`apps/api/.env`)
| Promenljiva | Opis |
|---|---|
| `DATABASE_URL` | PostgreSQL konekcija |
| `JWT_SECRET` | ≥ 32 nasumična znaka; promena odjavljuje sve korisnike |
| `PIN_PEPPER` | Tajna za HMAC PIN-ova; **promena poništava sve PIN-ove** |
| `PORT` | Podrazumevano 3000 |
| `CORS_ORIGIN` | Dozvoljeni origin-i, zarezom odvojeni |
| `PAYMENT_MODE` | Samo `TEST` je podržan; `LIVE` se namerno odbija pri startu |

Ako baza nije dostupna, API se ne pokreće i ispisuje jasnu poruku; `/api/v1/health` vraća 503 kada se veza izgubi.
