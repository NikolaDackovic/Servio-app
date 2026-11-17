// Slike ekrana za uputstvo u ADMIN-u (apps/admin/public/help/*.jpg), iz pravog programa preko headless Edge/Chrome (CDP).
// 1) build kase i ADMIN-a, 2) demo server (apps/api: npx ts-node --transpile-only scripts/demo-server.ts), 3) node scripts/help-shots.mjs
// Opciono: BROWSER=putanja do chrome/msedge, BASE=http://127.0.0.1:3100
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const BROWSER = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = new URL('../apps/admin/public/help/', import.meta.url); mkdirSync(OUT, { recursive: true });
const W = 1280, H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idem = () => `shot-${Math.random().toString(36).slice(2)}`;
const call = async (method, path, body, token) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null;
};

// ---------- demo stanje: dan, smena, zauzeti stolovi, porudžbine u kuhinji, naplaćeni računi
const admin = (await call('POST', '/auth/login', { email: 'admin@demo.local', password: 'Demo123!' })).accessToken;
const devices = await call('GET', '/computers', null, admin);
const pos = devices.find((d) => d.kind === 'POS'), kds = devices.find((d) => d.kind === 'KDS');
const mgr = (await call('POST', '/auth/pin', { deviceId: pos.id, pin: '9999' })).accessToken;
const waiter = (await call('POST', '/auth/pin', { deviceId: pos.id, pin: '1111' })).accessToken;
await call('POST', '/business-days/open', {}, mgr).catch(() => undefined);
await call('POST', '/shifts/open', { openingCash: '5000.00' }, mgr).catch(() => undefined);
const tables = await call('GET', '/tables', null, mgr);
const prods = (await call('GET', '/products?pageSize=100', null, mgr)).data.filter((p) => p.isSellable !== false);
const by = (code) => prods.find((p) => p.code === code)?.id ?? prods[0].id;
const order = async (table, codes, { pay, rep } = {}) => {
  const o = await call('POST', '/orders', { tableId: table?.id, idempotencyKey: idem() }, waiter);
  for (const c of codes) await call('POST', `/orders/${o.id}/items`, { productId: by(c) }, waiter);
  await call('POST', `/orders/${o.id}/send`, {}, waiter).catch(() => undefined);
  if (pay) await call('POST', `/orders/${o.id}/settle`, { parts: [{ method: pay, ...(rep ? { note: rep } : {}) }], idempotencyKey: idem() }, mgr);
  return o;
};
const sala = tables.filter((t) => !t.isRoom);
await order(sala[0], ['K001', 'K002', 'S001']);
await order(sala[3], ['H001', 'H002', 'P001', 'P001']);
await order(sala[5], ['K003', 'H003']);
await order(sala[1], ['K001', 'S002'], { pay: 'CASH' });
await order(sala[2], ['P002', 'H001'], { pay: 'CARD' });
await order(sala[4], ['K002', 'K001'], { pay: 'REPRESENTATION', rep: 'Čast kuće' });

// ---------- browser
const port = 9339;
const br = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'help-shots-'))}`,
  '--disable-gpu', '--no-first-run', `--window-size=${W},${H}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const text = () => ev('document.body.innerText');
const wait = async (re, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (re.test((await text()) ?? '')) return; throw new Error(`nema ${re}`); };
const click = async (re, sel = 'button', { last = false } = {}) => {
  let ok = false;
  for (const end = Date.now() + 8000; !ok && Date.now() < end; ok || await sleep(300)) ok = await ev(`(() => {
    const re = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)});
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((b) => b.offsetParent && !b.disabled && re.test(b.innerText.replace(/\\s+/g, ' ').trim()));
    const el = ${last} ? els[els.length - 1] : els[0]; if (!el) return false; el.click(); return true; })()`);
  if (!ok) throw new Error(`nema dugmeta ${re}`);
  await sleep(800);
};
const fill = async (target, value) => {
  const ok = await ev(`(() => {
    const t = ${JSON.stringify(target)}; let el;
    if (t.startsWith('css:')) el = [...document.querySelectorAll(t.slice(4))].filter((x) => x.offsetParent).pop();
    else { const re = new RegExp(t, 'i'); el = [...document.querySelectorAll('label')].filter((l) => l.offsetParent && re.test(l.innerText)).pop()?.querySelector('input,select,textarea'); }
    if (!el) return false; el.focus();
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
  if (!ok) throw new Error(`nema polja ${target}`);
  await sleep(500);
};
const enter = async () => {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: String.fromCharCode(13) } : {}) });
  await sleep(900);
};
const pin = async (p) => { for (const d of p) await click(new RegExp(`^${d}$`), 'button', { last: true }); await click(/^POTVRDI$/); };
const shot = async (name) => {
  await sleep(700);
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
  writeFileSync(new URL(name, OUT), Buffer.from(r.result.data, 'base64')); console.log('  ✓', name);
};
const nav = async (url, re) => { await send('Page.navigate', { url }); await sleep(800); if (re) await wait(re); await sleep(600); };
const done = [], failed = [];
const step = async (name, fn) => { try { await fn(); done.push(name); } catch (e) { failed.push(`${name}: ${e.message}`); console.log('  ✗', name, e.message); } };

try {
  let targets = [];
  for (let t = 0; t < 40 && !targets.length; t++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { /* */ } await sleep(250); }
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true }); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  // ---- KASA
  await nav(BASE);
  await ev(`localStorage.setItem('pos.token', ${JSON.stringify(mgr)}); localStorage.setItem('pos.deviceId', ${JSON.stringify(pos.id)}); true`);
  const openTable = async (name) => {
    await nav(BASE, /Novi račun/);
    await click(new RegExp(`(^|\\s)${name}(\\s|$)`));
    await wait(/šifra konobara|NAPLATA/); if (/šifra konobara/.test(await text())) await pin('9999');
    await wait(/NAPLATA/);
  };
  const label = (t) => (/^\d+$/.test(t.name.replace(/\D/g, '')) ? t.name.replace(/\D/g, '').padStart(3, '0') : t.name);
  await step('kasa-stolovi', async () => { await nav(BASE, /Novi račun/); await shot('kasa-stolovi.jpg'); });
  await step('kasa-porudzbina', async () => { await openTable(label(sala[3])); await shot('kasa-porudzbina.jpg'); });
  await step('kasa-dodaci', async () => {
    await ev(`[...document.querySelectorAll('button.k-prod')].find((b) => /Espresso/.test(b.innerText))?.click()`); await wait(/BEZ IZMENA/i);
    await click(/Bez šećera/i, 'button'); await shot('kasa-dodaci.jpg'); await click(/^BEZ IZMENA$/i);
  });
  await step('kasa-prebacivanje', async () => { await openTable(label(sala[3])); await click(/^PREBACIVANJE$/); await click(/^IZABERI SVE$/i); await shot('kasa-prebacivanje.jpg'); });
  await step('kasa-naplata', async () => { await openTable(label(sala[5])); await click(/^NAPLATA$/); await wait(/KUPAC/); await shot('kasa-naplata.jpg'); });
  await step('kasa-reprezentacija', async () => { await click(/REPREZENTACIJA/i, 'button.k-co-method'); await wait(/ČAST KUĆE|Čast kuće/); await shot('kasa-reprezentacija.jpg'); });
  await step('kasa-pregled', async () => {
    await nav(BASE, /Novi račun/); await click(/Pregled računa/); await pin('9999'); await wait(/PRESEK STANJA/);
    await ev(`[...document.querySelectorAll('button.kx-row')].find((r) => /NAPLAĆEN/i.test(r.innerText))?.click()`); await shot('kasa-pregled.jpg');
  });
  await step('kasa-povracaj', async () => {
    await ev(`[...document.querySelectorAll('button.kx-row')].filter((r) => /NAPLAĆEN/i.test(r.innerText)).slice(-1)[0]?.click()`); await sleep(800);
    await click(/^POVRAĆAJ$/i); await click(/^IZABERI SVE$/i); await shot('kasa-povracaj.jpg');
  });

  // ---- KDS
  await step('kds', async () => {
    const k = (await call('POST', '/auth/pin', { deviceId: kds.id, pin: '3333' })).accessToken;
    await nav(`${BASE}/kds`);
    await ev(`localStorage.setItem('pos.kds.token', ${JSON.stringify(k)}); localStorage.setItem('pos.kds.deviceId', ${JSON.stringify(kds.id)}); true`);
    await nav(`${BASE}/kds`); await sleep(2500); await shot('kds.jpg');
  });

  // ---- ADMIN
  await nav(`${BASE}/admin/`);
  await ev(`sessionStorage.setItem('pos.admin.token', ${JSON.stringify(admin)}); true`);
  const ADMIN_READY = /Pregled proizvoda/i;
  const page = async (q, re) => { await nav(`${BASE}/admin/`, ADMIN_READY); await ev(`document.querySelector('button[aria-label="Pretraga"]').click()`); await sleep(600); await fill('css:.cmdk input', q); await click(/./, '.cmdk li button'); if (re) await wait(re); await sleep(800); };
  await step('admin-prijava', async () => {
    await ev(`sessionStorage.removeItem('pos.admin.token'); true`); await nav(`${BASE}/admin/`, /Unesite šifru/i); await shot('admin-prijava.jpg');
    await ev(`sessionStorage.setItem('pos.admin.token', ${JSON.stringify(admin)}); true`);
  });
  await step('admin-tabovi', async () => {
    await nav(`${BASE}/admin/`, ADMIN_READY);
    await click(/^Smena/i); await click(/^Specifikacija pazara$/i, '.adm-sub');
    await click(/^Smena/i); await click(/^Pretraga računa$/i, '.adm-sub'); await sleep(1500);
    await ev(`[...document.querySelectorAll('.adm-tabpage:not([hidden]) .dt-table tbody tr')].find((r) => /Kartica|Gotovina/.test(r.innerText))?.click()`); await sleep(1200);
    await shot('admin-pocetna.jpg');
  });
  await step('admin-pretraga', async () => { await ev(`document.querySelector('button[aria-label="Pretraga"]').click()`); await sleep(600); await fill('css:.cmdk input', 'faktura'); await shot('admin-pretraga.jpg'); });
  await step('admin-proizvodi', async () => { await page('Pregled proizvoda', /Grupna izmena/i); await shot('admin-proizvodi.jpg'); });
  await step('admin-novi-artikal', async () => { await click(/^Dodaj$/i); await fill('^Naziv', 'Limunada 0,3'); await fill('Prodajna cena', '290'); await shot('admin-novi-artikal.jpg'); await click(/^Odustani$/i, 'button', { last: true }); });
  await step('admin-grupna', async () => { await click(/^Grupna izmena$/i); await fill('Za koliko', '10'); await shot('admin-grupna.jpg'); await click(/^Zatvori$/i, 'button', { last: true }); });
  await step('admin-dokument', async () => {
    await page('Ulazna faktura', /Interni broj/i);
    const partners = await call('GET', '/partners', null, admin);
    if (partners[0]) await fill('^Dobavljač', partners[0].id);
    await fill('^Broj dok', '2026-0147');
    for (const [i, q, qty, price] of [[0, 'Kisela', '24', '72'], [1, 'Coca', '24', '96']]) {
      await fill('css:.adm-tabpage:not([hidden]) .doc-pick .picker input', q); await sleep(900);
      await enter(); await sleep(1200);
      await wait(/Kalkulator jedinične cene/i); await fill('css:[aria-label="Pakovanja"]', '1'); await fill('css:[aria-label="Komada u pakovanju"]', qty); await fill('css:[aria-label="Jedinična cena sa PDV"]', price);
      if (i === 1) await shot('admin-stavka.jpg');
      await enter();
    }
    await sleep(500);
    await shot('admin-dokument.jpg');
  });
  await step('admin-narudzbina', async () => { await page('Predlog narudžbine', /Naručiti|Ništa ne treba/); await shot('admin-narudzbina.jpg'); });
  await step('admin-stolovi', async () => { await page('Mapa stolova', /./); await sleep(1500); await shot('admin-stolovi.jpg'); });
  await step('admin-qr', async () => { await click(/^QR kodovi$/i); await wait(/Skenirajte i naručite/); await sleep(800); await shot('admin-qr.jpg'); });

  // ---- QR meni na telefonu gosta: izbor artikla, korpa, slanje (i provera da je stiglo na sto)
  await step('qr-meni', async () => {
    const free = (await call('GET', '/tables', null, admin)).find((t) => !t.openOrders.length && !t.isRoom);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await nav(`${BASE}/m/${free.qrToken}`, /Sve/);
    await ev(`[...document.querySelectorAll('.gm-item')].find((b) => /Espresso/.test(b.innerText))?.click()`); await wait(/Dodaj ·/);
    await ev(`[...document.querySelectorAll('.gm-opts button')][0]?.click()`); await click(/^Dodaj ·/);
    await ev(`[...document.querySelectorAll('.gm-item')].find((b) => /Coca/.test(b.innerText))?.click()`); await wait(/Dodaj ·/); await click(/^Dodaj ·/);
    await shot('qr-meni.jpg');
    await ev(`document.querySelector('.gm-cartbar')?.click()`); await wait(/Pošalji porudžbinu/); await shot('qr-korpa.jpg');
    await click(/^Pošalji porudžbinu$/); await wait(/Porudžbina je poslata/); await shot('qr-poslato.jpg');
    const t = (await call('GET', '/tables', null, admin)).find((x) => x.id === free.id);
    if (!t.openOrders.length || !t.openOrders[0].qrGuest) throw new Error('QR porudžbina nije stigla na sto');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  });
} finally {
  try { ws?.close(); } catch { /* */ } br.kill();
  console.log(`\nSlike: ${done.length} urađeno${failed.length ? `, ${failed.length} nije:\n  ${failed.join('\n  ')}` : ''}`);
}
