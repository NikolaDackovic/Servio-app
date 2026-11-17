/**
 * Servio - instalirana kasa (Windows).
 *
 * Dva načina rada (bira se pri prvom pokretanju):
 *  - GLAVNA kasa: lokalna baza (ugrađeni PostgreSQL) → server (API + kasa, KDS i ADMIN) → prozor kase.
 *    ADMIN i KDS se otvaraju sa drugih uređaja na adresi ove kase (http://<IP>:<port>/admin i /kds).
 *  - DODATNA kasa (POS-PC2, POS-PC3…): bez baze; povezuje se na glavnu kasu po IP adresi u lokalu.
 *    Pri povezivanju se sama prijavljuje kao novi računar (ADMIN → Podešavanja → Računari).
 * Na oba računara radi i Print Bridge: štampa na štampače priključene na taj računar (USB/Windows)
 * i na mrežne štampače. Kasa se pali sa Windows-om.
 *
 * Podaci: %APPDATA%\POS Kasa (config.json, db\ baza na glavnoj kasi, logs\ zapisi).
 * Baza: PostgreSQL iz instalacije (initdb/pg_ctl), samo na 127.0.0.1, port iz config.json (podrazumevano 5433).
 */
import { app, BrowserWindow, dialog, Menu, shell, utilityProcess, UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from './database.js';

interface Config {
  mode?: 'main' | 'client';
  jwtSecret: string; pinPepper: string; dbPassword: string; port: number; pgPort: number;
  /** tajna za razgovor programa i servera na ovom računaru (registracija Print Bridge-a) */
  localToken: string;
  /** dodatna kasa: adresa glavne (http://192.168.1.10:3000) i ovaj računar u bazi */
  serverUrl?: string; deviceId?: string;
  /** Print Bridge ovog računara */
  bridgeKey?: string;
  /** kodna strana štampača: ascii (bez kvačica), cp852, cp1250 (latinica), cp1251 (ćirilica) */
  codepage?: string;
  /** dodatni folder za rezervne kopije (drugi disk, USB, mrežni folder) */
  backupDir?: string;
}

// Podaci uvek u %APPDATA%\POS Kasa (i posle preimenovanja programa u Servio - postojeća baza ostaje na istom mestu).
// Za probu/razvoj: drugi folder podataka (POS_DATA_DIR).
app.setPath('userData', process.env.POS_DATA_DIR ?? path.join(app.getPath('appData'), 'POS Kasa'));
const RES = app.isPackaged ? path.join(process.resourcesPath, 'app-resources') : path.join(__dirname, '..', 'resources');
const ICON = path.join(RES, 'branding', 'icon.ico');
const ADMIN_ICON = path.join(RES, 'branding', 'admin-icon.ico');
/** logo za ekrane programa (splash, izbor načina rada) - ugrađen kao data URI */
const LOGO = (() => { try { return `data:image/png;base64,${fs.readFileSync(path.join(RES, 'branding', 'servio-logo-dark.png')).toString('base64')}`; } catch { return ''; } })();
const DATA = app.getPath('userData');
const LOGS = path.join(DATA, 'logs');
const CONFIG_FILE = path.join(DATA, 'config.json');
fs.mkdirSync(LOGS, { recursive: true });
const logFile = fs.createWriteStream(path.join(LOGS, 'kasa.log'), { flags: 'a' });
const log = (msg: string) => logFile.write(`${new Date().toISOString()} ${msg.trimEnd()}\n`);

let win: BrowserWindow | null = null;
let server: UtilityProcess | null = null;
let bridge: UtilityProcess | null = null;
let db: Database | null = null;
let quitting = false;

/** Tajni ključevi se prave pri prvom pokretanju i nikad ne napuštaju ovaj računar. */
function loadConfig(): Config {
  if (fs.existsSync(CONFIG_FILE)) {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config;
    if (!c.localToken) { c.localToken = randomBytes(32).toString('hex'); saveConfig(c); }
    return c;
  }
  const cfg: Config = {
    jwtSecret: randomBytes(48).toString('hex'), pinPepper: randomBytes(32).toString('hex'), dbPassword: randomBytes(24).toString('hex'),
    localToken: randomBytes(32).toString('hex'), port: 3000, pgPort: 5433,
  };
  saveConfig(cfg);
  return cfg;
}
const saveConfig = (c: Config) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });

const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a!.address);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = any>(base: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${base}/api/v1${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { status: res.status, code: data?.error?.code });
  return data as T;
}

async function waitForServer(base: string, timeoutMs: number, onWait?: () => void) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try { await api(base, 'GET', '/health'); return; } catch { /* još se pokreće ili nije dostupan */ }
    if (Date.now() > until) throw new Error(`Server ${base} ne odgovara`);
    onWait?.();
    await sleep(1000);
  }
}

function startServer(cfg: Config) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: `postgresql://pos:${cfg.dbPassword}@127.0.0.1:${cfg.pgPort}/postgres`,
    JWT_SECRET: cfg.jwtSecret, PIN_PEPPER: cfg.pinPepper, PORT: String(cfg.port), LOCAL_TOKEN: cfg.localToken,
    CORS_ORIGIN: `http://localhost:${cfg.port}`,
    WEB_DIR: path.join(RES, 'web'), ADMIN_DIR: path.join(RES, 'admin'), MIGRATIONS_DIR: path.join(RES, 'server', 'migrations'),
    DISABLE_SWAGGER: '1', FISCAL_PROVIDER: 'TEST', NO_COLOR: '1', LOG_LEVEL: 'warn',
  };
  const p = utilityProcess.fork(path.join(RES, 'server', 'server.js'), [], { env, stdio: 'pipe', serviceName: 'POS server' });
  p.stdout?.on('data', (d) => log(`[server] ${d}`));
  p.stderr?.on('data', (d) => log(`[server] ${d}`));
  p.on('exit', (code) => {
    log(`[server] izašao (${code})`);
    if (!quitting) {
      dialog.showErrorBox('Servio', `Server kase je neočekivano stao (kod ${code}).\nZapis: ${path.join(LOGS, 'kasa.log')}\n\nKasa će se ponovo pokrenuti.`);
      app.relaunch(); app.exit(1);
    }
  });
  return p;
}

/** Print Bridge ovog računara; ako padne, ponovo se pokreće (štampa ne sme da stane zbog jedne greške). */
function startBridge(cfg: Config, apiBase: string) {
  if (!cfg.bridgeKey) return;
  const env = {
    ...process.env, NO_COLOR: '1', API_URL: `${apiBase}/api/v1`, BRIDGE_KEY: cfg.bridgeKey, CODEPAGE: cfg.codepage ?? 'cp852',
    SIMULATED_DIR: path.join(DATA, 'simulated-print'),
  };
  bridge = utilityProcess.fork(path.join(RES, 'bridge', 'bridge.js'), [], { env, stdio: 'pipe', serviceName: 'POS stampa' });
  bridge.stdout?.on('data', (d) => log(`[stampa] ${d}`));
  bridge.stderr?.on('data', (d) => log(`[stampa] ${d}`));
  bridge.on('exit', (code) => {
    log(`[stampa] izašao (${code})`);
    if (!quitting) setTimeout(() => startBridge(cfg, apiBase), 5000);
  });
}

const page = (body: string) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1b1e23;color:#eef1f5;font-family:Segoe UI,sans-serif}
.box{width:min(560px,92vw)}.brand{font-size:34px;font-weight:800;text-align:center}.brand span{color:#ee7a73}
.muted{opacity:.7;text-align:center;margin:8px 0 22px}.err{background:#5a1d1d;border:1px solid #b33;padding:10px 12px;border-radius:6px;margin-bottom:12px}
button{width:100%;min-height:64px;margin:6px 0;border:0;border-radius:8px;font:inherit;font-size:18px;font-weight:700;cursor:pointer}
.main{background:#2f7bc4;color:#fff}.alt{background:#2b3038;color:#eef1f5;border:1px solid #3d444f}
label{display:block;margin:10px 0 4px;font-size:14px;opacity:.85}input{width:100%;box-sizing:border-box;min-height:44px;padding:0 12px;border-radius:6px;border:1px solid #3d444f;background:#14171b;color:#fff;font-size:16px}
small{display:block;opacity:.6;margin-top:4px}</style></head><body><div class="box"><div class="brand">${LOGO ? `<img src="${LOGO}" alt="Servio" style="height:64px">` : 'Servio'}</div>${body}</div></body></html>`)}`;
const splash = (text: string) => page(`<div class="muted">${text}</div>`);

/** Prvo pokretanje programa: glavna (baza na ovom računaru) ili dodatna kasa (povezuje se na glavnu). */
function chooseMode(error = '', ip = '', user = 'ADMIN'): Promise<{ mode: 'main' } | { mode: 'client'; ip: string; user: string; password: string }> {
  return new Promise((resolve) => {
    const html = page(`<div class="muted">Prvo pokretanje na ovom računaru</div>
${error ? `<div class="err">${error.replace(/</g, '&lt;')}</div>` : ''}
<button class="main" onclick="location.href='https://pos.setup/main'">GLAVNA KASA<br><small>baza i server su na ovom računaru</small></button>
<form onsubmit="event.preventDefault();location.href='https://pos.setup/client?'+new URLSearchParams(new FormData(this))">
<div style="margin-top:22px;font-weight:700">DODATNA KASA (POS-PC2, POS-PC3…)</div>
<label>IP adresa glavne kase</label><input name="ip" value="${ip}" placeholder="npr. 192.168.1.10" required>
<small>Na glavnoj kasi: Ctrl+Shift+A prikazuje adresu.</small>
<label>Korisničko ime administratora</label><input name="user" value="${user}" required>
<label>Lozinka administratora</label><input name="password" type="password" placeholder="podrazumevano 0000" required>
<button class="alt" type="submit">POVEŽI SE NA GLAVNU KASU</button></form>`);
    const handler = (e: Electron.Event, url: string) => {
      if (!url.startsWith('https://pos.setup/')) return;
      e.preventDefault();
      win!.webContents.off('will-navigate', handler);
      const u = new URL(url);
      if (u.pathname === '/main') resolve({ mode: 'main' });
      else resolve({ mode: 'client', ip: (u.searchParams.get('ip') ?? '').trim(), user: (u.searchParams.get('user') ?? '').trim(), password: u.searchParams.get('password') ?? '' });
    };
    win!.webContents.on('will-navigate', handler);
    void win!.loadURL(html);
  });
}

/** Dodatna kasa: prijava administratorom na glavnoj, pa registracija ovog računara (kasa + Print Bridge). */
async function connectClient(cfg: Config, ip: string, user: string, password: string) {
  const host = ip.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const base = `http://${host.includes(':') ? host : `${host}:3000`}`;
  await win!.loadURL(splash(`Povezujem se na glavnu kasu (${base})…`));
  const login = await api<{ accessToken: string }>(base, 'POST', '/auth/login', { email: user, password });
  const auth = { Authorization: `Bearer ${login.accessToken}` };
  const name = os.hostname();
  let deviceId: string;
  try {
    deviceId = (await api<{ id: string }>(base, 'POST', '/computers', { name, kind: 'POS' }, auth)).id;
  } catch (e: any) {
    if (e.code !== 'DEVICE_NAME_TAKEN') throw e;
    deviceId = (await api<{ id: string; name: string }[]>(base, 'GET', '/computers', undefined, auth)).find((d) => d.name === name)!.id;
  }
  const bridgeName = `Štampa ${name}`;
  const existing = (await api<{ id: string; name: string; kind: string }[]>(base, 'GET', '/devices', undefined, auth)).find((d) => d.kind === 'BRIDGE' && d.name === bridgeName);
  const b = existing
    ? await api<{ apiKey: string }>(base, 'POST', `/print-bridges/${existing.id}/rotate-key`, {}, auth)
    : await api<{ apiKey: string }>(base, 'POST', '/print-bridges', { name: bridgeName }, auth);
  Object.assign(cfg, { mode: 'client', serverUrl: base, deviceId, bridgeKey: b.apiKey });
  saveConfig(cfg);
  log(`Dodatna kasa "${name}" povezana na ${base}`);
}

/** Glavna kasa: Print Bridge se registruje sam (posle prvog podešavanja firme), lokalnim tajnim tokenom. */
async function registerLocalBridge(cfg: Config, base: string) {
  for (;;) {
    try {
      const st = await api<{ needsSetup: boolean }>(base, 'GET', '/setup/status');
      if (!st.needsSetup) break;
    } catch { /* server se još pokreće */ }
    await sleep(5000);
  }
  const r = await api<{ key: string }>(base, 'POST', '/setup/local-bridge', { name: `Štampa ${os.hostname()} (glavna kasa)` }, { 'x-local-token': cfg.localToken });
  cfg.bridgeKey = r.key;
  saveConfig(cfg);
  log('Print Bridge glavne kase registrovan');
}

/**
 * Rezervna kopija baze glavne kase: kopija foldera baze DOK BAZA NE RADI (pri pokretanju programa, pre podizanja baze,
 * i pri urednom gašenju) - kopija je tada dosledna. Najviše jednom u 20 sati; čuva se poslednjih 7.
 * Povratak: zatvoriti kasu, zameniti folder db kopijom iz backup foldera, pokrenuti kasu.
 */
function backupDb(cfg: Config) {
  const dbDir = path.join(DATA, 'db');
  if (!fs.existsSync(path.join(dbDir, 'PG_VERSION'))) return;
  const marker = path.join(DATA, 'backup', '.poslednja');
  try { if (Date.now() - fs.statSync(marker).mtimeMs < 20 * 3600_000) return; } catch { /* prva kopija */ }
  const d = new Date(); const p2 = (n: number) => String(n).padStart(2, '0');
  const name = `baza-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}-${p2(d.getMinutes())}`; // lokalno vreme
  for (const root of [path.join(DATA, 'backup'), cfg.backupDir].filter((x): x is string => !!x)) {
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.cpSync(dbDir, path.join(root, name), { recursive: true });
      const old = fs.readdirSync(root).filter((n) => n.startsWith('baza-')).sort().reverse().slice(7);
      for (const o of old) fs.rmSync(path.join(root, o), { recursive: true, force: true });
      log(`Rezervna kopija baze: ${path.join(root, name)}`);
    } catch (e: any) { log(`Rezervna kopija u ${root} nije uspela: ${e?.message ?? e}`); }
  }
  fs.mkdirSync(path.join(DATA, 'backup'), { recursive: true });
  fs.writeFileSync(marker, name);
}

function lastBackup() {
  try { return fs.readFileSync(path.join(DATA, 'backup', '.poslednja'), 'utf8'); } catch { return 'još nema'; }
}

/** Adresa servera kojim ovaj računar radi (glavna kasa: lokalno; dodatna: glavna kasa u mreži). */
const serverBase = (cfg: Config) => (cfg.mode === 'client' ? cfg.serverUrl! : `http://localhost:${cfg.port}`);

/** ADMIN (backoffice) kao prozor programa na ovom računaru - radi lokalno, nezavisno od otvorene smene. */
let adminWin: BrowserWindow | null = null;
/** pokrenuto prečicom "Servio ADMIN": kasa i ADMIN su dva programa - prozor kase se ne prikazuje dok se ne pokrene "Servio" */
const ADMIN_ONLY = process.argv.includes('--admin');
let kasaShown = !ADMIN_ONLY;
function showKasa() {
  if (!win) return;
  if (!kasaShown) { kasaShown = true; win.show(); win.setFullScreen(true); }
  if (win.isMinimized()) win.restore();
  win.focus();
}

/** ADMIN → "Promeni server": dodatni računar se ponovo povezuje na glavnu kasu; na glavnoj kasi samo uputstvo. */
async function reconnect(cfg: Config) {
  const parent = adminWin && !adminWin.isDestroyed() ? adminWin : win!;
  if (cfg.mode === 'main') {
    void dialog.showMessageBox(parent, { title: 'Servio - server', type: 'info', message: 'Ovaj računar je glavna kasa (server sa bazom).',
      detail: `ADMIN na drugom računaru (kancelarija, kuća): instalirajte Servio tamo i izaberite "Povezivanje na glavnu kasu" - upišite IP adresu ovog računara (${lanAddresses().join(', ') || 'nije u mreži'}).\nOd kuće: preko VPN-a (npr. Tailscale) ili prosleđenog porta na ruteru (uputstvo: Instalacija i održavanje → ADMIN od kuće).` });
    return;
  }
  const r = await dialog.showMessageBox(parent, { title: 'Servio - promena servera', type: 'question', buttons: ['Poveži se ponovo', 'Odustani'], defaultId: 1, cancelId: 1,
    message: `Sada: ${cfg.serverUrl}`, detail: 'Program će se ponovo pokrenuti i pitati na koju glavnu kasu (IP adresa) da se poveže.' });
  if (r.response !== 0) return;
  delete cfg.mode; delete cfg.serverUrl; saveConfig(cfg);
  app.relaunch(); app.exit(0);
}

function openAdmin(cfg: Config, first?: string) {
  if (!cfg.mode) return;
  if (adminWin && !adminWin.isDestroyed()) { if (adminWin.isMinimized()) adminWin.restore(); adminWin.focus(); return; }
  adminWin = new BrowserWindow({
    width: 1400, height: 900, show: false, autoHideMenuBar: true, backgroundColor: '#0f1115', title: 'Servio ADMIN', icon: ADMIN_ICON,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  adminWin.once('ready-to-show', () => { adminWin?.maximize(); adminWin?.show(); });
  adminWin.webContents.setWindowOpenHandler(({ url }) => {
    // ADMIN → "Promeni server": dodatni računar se ponovo povezuje (bira glavnu kasu); glavna kasa samo objašnjava
    if (url.startsWith('servio://reconnect')) { void reconnect(cfg); return { action: 'deny' }; }
    void shell.openExternal(url); return { action: 'deny' };
  });
  adminWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F5') { adminWin?.reload(); e.preventDefault(); }
  });
  // samo ADMIN (kasa nije otvorena): zatvaranje ADMIN-a gasi program
  adminWin.on('closed', () => { adminWin = null; if (!kasaShown) app.quit(); });
  void adminWin.loadURL(first ?? `${serverBase(cfg)}/admin/`);
}

/** Ctrl+Shift+R na glavnoj kasi: vraća podrazumevane naloge (ADMIN/0000, KON01/11, KON02/22, tv/tv). */
async function resetLogins(cfg: Config) {
  if (cfg.mode !== 'main') {
    void dialog.showMessageBox(win!, { title: 'Servio', type: 'info', message: 'Nalozi se vraćaju na glavnoj kasi (računar sa bazom).' });
    return;
  }
  const r = await dialog.showMessageBox(win!, {
    title: 'Servio - podrazumevani nalozi', type: 'question', buttons: ['Vrati naloge', 'Odustani'], defaultId: 1, cancelId: 1,
    message: 'Vratiti podrazumevane naloge?',
    detail: 'ADMIN / 0000 (ADMIN i kasa), KON01 / 11, KON02 / 22, tv / tv (KDS).\nNalozi koji postoje dobijaju ove šifre; ostali korisnici se ne menjaju.',
  });
  if (r.response !== 0) return;
  try {
    const res = await api<{ done: string[] }>(`http://127.0.0.1:${cfg.port}`, 'POST', '/setup/reset-logins', {}, { 'x-local-token': cfg.localToken });
    log(`Podrazumevani nalozi vraćeni: ${res.done.join('; ')}`);
    void dialog.showMessageBox(win!, { title: 'Servio', type: 'info', message: 'Nalozi su vraćeni', detail: res.done.join('\n') });
  } catch (e: any) {
    void dialog.showMessageBox(win!, { title: 'Servio', type: 'error', message: 'Vraćanje naloga nije uspelo', detail: String(e?.message ?? e) });
  }
}

function showAddresses(cfg: Config) {
  const ips = lanAddresses();
  const base = cfg.mode === 'client' ? cfg.serverUrl : null;
  void dialog.showMessageBox(win!, {
    title: 'Servio - adrese', type: 'info',
    message: base ? `Dodatna kasa (${os.hostname()}), povezana na glavnu: ${base}` : ips.length ? 'Glavna kasa. Na drugim uređajima u lokalu (ista mreža):' : 'Računar nije povezan na mrežu lokala.',
    detail: base
      ? `ADMIN: ${base}/admin\nKDS:   ${base}/kds`
      : `${ips.map((ip) => `ADMIN: http://${ip}:${cfg.port}/admin\nKDS:   http://${ip}:${cfg.port}/kds\nDodatna kasa: IP ${ip}`).join('\n\n')}\n\nPoslednja rezervna kopija baze: ${lastBackup()}`,
  });
}

async function boot() {
  const cfg = loadConfig();
  win = new BrowserWindow({
    // POS_HIDDEN=1: provera bez prozora na ekranu (automatski testovi)
    fullscreen: process.env.POS_HIDDEN !== '1', autoHideMenuBar: true, backgroundColor: '#1b1e23', title: 'Servio', icon: ICON, show: process.env.POS_HIDDEN !== '1' && !ADMIN_ONLY,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Gašenje Windows-a: baza se gasi odmah i sinhrono (inače bi ostala nečisto ugašena)
  win.on('session-end', () => { quitting = true; try { server?.kill(); bridge?.kill(); } catch { /* */ } db?.stopSync(); });
  // ADMIN sa kase (dugme "ADMIN (backoffice)") = prozor programa; ostale spoljne veze u pregledaču
  win.webContents.setWindowOpenHandler(({ url }) => {
    // dugmad kase za prozor (kasa bez tastature): servio://fullscreen | minimize | quit
    if (url.startsWith('servio://')) {
      const cmd = url.slice('servio://'.length).replace(/\/+$/, '');
      if (cmd === 'fullscreen') win?.setFullScreen(!win.isFullScreen());
      else if (cmd === 'minimize') { if (win?.isFullScreen()) win.setFullScreen(false); win?.minimize(); }
      else if (cmd === 'quit') app.quit();
      return { action: 'deny' };
    }
    if (/\/admin(\/|$)/.test(new URL(url).pathname)) openAdmin(cfg);
    else void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Ctrl+Shift+A: adrese; Ctrl+Shift+D: ADMIN; Ctrl+Shift+R: podrazumevani nalozi; F11: ceo ekran
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win?.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    const k = input.key.toLowerCase();
    if (input.control && input.shift && k === 'a') showAddresses(cfg);
    if (input.control && input.shift && k === 'd') { openAdmin(cfg); e.preventDefault(); }
    if (input.control && input.shift && k === 'r') { void resetLogins(cfg); e.preventDefault(); }
  });

  try {
    // POS_MODE=main: bez pitanja (automatske provere)
    if (!cfg.mode && process.env.POS_MODE === 'main') { cfg.mode = 'main'; saveConfig(cfg); }
    // POS_CLIENT="ip|korisnik|lozinka": dodatna kasa bez pitanja (automatske provere)
    if (!cfg.mode && process.env.POS_CLIENT) { const [ip, user, password] = process.env.POS_CLIENT.split('|'); await connectClient(cfg, ip, user, password); }
    let error = '';
    // prvo pokretanje (izbor glavna/dodatna) mora da se vidi i kad je pokrenut ADMIN
    if (!cfg.mode && ADMIN_ONLY) showKasa();
    while (!cfg.mode) {
      const m = await chooseMode(error);
      if (m.mode === 'main') { cfg.mode = 'main'; saveConfig(cfg); break; }
      try { await connectClient(cfg, m.ip, m.user, m.password); } catch (e: any) { error = `Povezivanje nije uspelo: ${e?.message ?? e}`; log(error); }
    }

    // samo ADMIN: odmah prozor ADMIN-a sa porukom dok se baza i server podižu
    if (ADMIN_ONLY) openAdmin(cfg, splash('Pokrećem Servio ADMIN…'));
    if (cfg.mode === 'main') {
      await win.loadURL(splash('Pokrećem kasu…'));
      db = new Database(path.join(RES, 'pgsql', 'bin'), path.join(DATA, 'db'), cfg.pgPort, cfg.dbPassword, (m) => log(`[db] ${m}`));
      // baza miruje (nije ostala da radi posle pada): dosledna rezervna kopija pre pokretanja
      if (fs.existsSync(path.join(DATA, 'db', 'PG_VERSION')) && !(await db.isRunning().catch(() => true))) {
        await win.loadURL(splash('Rezervna kopija baze…'));
        backupDb(cfg);
        await win.loadURL(splash('Pokrećem kasu…'));
      }
      await db.start();
      server = startServer(cfg);
      const base = `http://127.0.0.1:${cfg.port}`;
      await waitForServer(base, 90_000);
      log(`Glavna kasa spremna; ADMIN/KDS: ${lanAddresses().map((ip) => `http://${ip}:${cfg.port}`).join(', ')}`);
      await win.loadURL(`http://localhost:${cfg.port}/`);
      if (cfg.bridgeKey) startBridge(cfg, base);
      else void registerLocalBridge(cfg, base).then(() => startBridge(cfg, base)).catch((e) => log(`[stampa] registracija: ${e?.message ?? e}`));
    } else {
      const base = cfg.serverUrl!;
      await win.loadURL(splash(`Povezujem se na glavnu kasu (${base})…`));
      // glavna kasa možda još nije upaljena - čeka se (bez pada), prikazuje se poruka
      await waitForServer(base, 24 * 3600_000, () => void win?.loadURL(splash(`Čekam glavnu kasu (${base})…<br>Proverite da li je upaljena i u istoj mreži.`)));
      await win.loadURL(`${base}/?device=${cfg.deviceId}`);
      startBridge(cfg, base);
    }
    // pokrenuto prečicom "Servio ADMIN" (--admin): posle podizanja servera otvara se i ADMIN
    if (ADMIN_ONLY) { if (adminWin && !adminWin.isDestroyed()) void adminWin.loadURL(`${serverBase(cfg)}/admin/`); else openAdmin(cfg); }
    // pokretanje sa Windows-om: prijava se obnavlja i kad se promeni putanja programa (nova instalacija, novo ime)
    const mark = path.join(DATA, '.autostart');
    if (app.isPackaged && (!fs.existsSync(mark) || fs.readFileSync(mark, 'utf8') !== process.execPath)) {
      app.setLoginItemSettings({ openAtLogin: true });
      fs.writeFileSync(mark, process.execPath);
    }
  } catch (e: any) {
    log(`GREŠKA: ${e?.stack ?? e}`);
    dialog.showErrorBox('Servio', `Kasa ne može da se pokrene:\n${e?.message ?? e}\n\nZapis: ${path.join(LOGS, 'kasa.log')}`);
    await shutdown();
    app.exit(1);
  }
}

async function shutdown() {
  quitting = true;
  try { bridge?.kill(); } catch { /* već ugašen */ }
  try { server?.kill(); } catch { /* već ugašen */ }
  try { await db?.stop(); } catch (e: any) { log(`[db] gašenje: ${e?.message ?? e}`); return; }
  // posle urednog gašenja baza miruje: dobar trenutak za rezervnu kopiju
  if (db) { try { backupDb(loadConfig()); } catch (e: any) { log(`Rezervna kopija: ${e?.message ?? e}`); } }
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // kasa je već pokrenuta - druga instanca samo fokusira prvu
} else {
  // druga instanca: prečica "Servio ADMIN" otvara ADMIN prozor, inače se fokusira kasa
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--admin')) { const c = loadConfig(); if (c.mode) { openAdmin(c); return; } }
    showKasa();
  });
  Menu.setApplicationMenu(null);
  app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());
  let done = false;
  app.on('before-quit', (e) => {
    if (done) return;
    e.preventDefault();
    void shutdown().finally(() => { done = true; app.quit(); });
  });
}
