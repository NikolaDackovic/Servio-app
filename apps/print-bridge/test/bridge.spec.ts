import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { encodeText, linesToEscPos, linesToText, renderLines } from '../src/render';
import { sendTcp, sendWindowsRaw, writeSimulated } from '../src/adapters';
import { PrintBridge } from '../src/bridge';

/** Lažni mrežni štampač: prihvata TCP vezu i pamti primljene bajtove. */
function fakePrinter(): Promise<{ port: number; received: Buffer[]; close: () => Promise<void> }> {
  const received: Buffer[] = [];
  const srv = net.createServer((s) => {
    const chunks: Buffer[] = [];
    s.on('data', (d) => chunks.push(Buffer.from(d)));
    s.on('end', () => { received.push(Buffer.concat(chunks)); s.end(); });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({
    port: (srv.address() as AddressInfo).port, received, close: () => new Promise((r) => srv.close(() => r())),
  })));
}

const ticket = {
  title: 'NARUDŽBINA', station: 'Kuhinja', orderNumber: 17, table: 'Sto 3', tab: 'Pera', waiter: 'Marko Konobar',
  batch: 2, createdAt: '2026-10-22T18:30:00.000Z',
  lines: [{ qty: '2.000', name: 'Pljeskavica', note: 'bez luka' }, { qty: '0.500', name: 'Šopska salata', note: null }],
};

describe('Prikaz i ESC/POS', () => {
  it('kuhinjski blok sadrži sto, turu, količine i napomene', () => {
    const text = linesToText(renderLines('ORDER_TICKET', ticket, 80), 80);
    expect(text).toContain('NARUDŽBINA - Kuhinja');
    expect(text).toContain('Sto 3 (Pera)');
    expect(text).toContain('Tura 2');
    expect(text).toContain('2 x Pljeskavica');
    expect(text).toContain('>> bez luka');
    expect(text).toContain('0,5 x Šopska salata');
  });

  it('storno blok je jasno označen', () => {
    const text = linesToText(renderLines('VOID_TICKET', { ...ticket, title: 'STORNO', batch: null, reason: 'Gost odustao' }, 58), 58);
    expect(text).toContain('*** STORNO - NE PRIPREMATI ***');
    expect(text).toContain('Razlog: Gost odustao');
  });

  it('račun u rasporedu Poreske uprave; nefiskalni to piše; ćirilica (CP1251) ili latinica; QR', () => {
    const payload = {
      orderNumber: 5, table: 'Sto 3', waiter: 'Ana', createdAt: ticket.createdAt,
      lines: [{ qty: '1.000', name: 'Espresso', unitPrice: '180.00', total: '180.00', taxLabel: 'Ђ' }],
      total: '180.00', payments: [{ method: 'CASH', amount: '200.00', change: '20.00' }],
      fiscalLayout: {
        isFiscal: false, pib: '110108701', company: 'Demo d.o.o.', store: 'Demo lokal', address: 'Mokroluška 24', city: 'Grocka',
        cashier: 'Ana', esir: '284/3', transaction: 'ОБУКА ПРОДАЈА', pfrNumber: 'TEST-20261022-ABCDEF12-5', counter: '5/5ОП',
        taxes: [{ label: 'Ђ', name: 'О-ПДВ', rate: '20.00', tax: '30.00' }], taxTotal: '30.00', qr: 'https://suf.purs.gov.rs/v/?vl=TEST',
      },
    };
    const lines = renderLines('RECEIPT', payload, 80);
    const text = linesToText(lines, 80);
    expect(text.split('\n')[0]).toMatch(/^=+ ОВО НИЈЕ ФИСКАЛНИ РАЧУН =+$/);
    for (const s of ['110108701', 'Касир:', 'ЕСИР број:', 'ОБУКА ПРОДАЈА', 'Espresso (Ђ)', 'Укупан износ:', 'Готовина:', 'Повраћај:', 'О-ПДВ', '20,00%', 'Укупан износ пореза:', 'ПФР број рачуна:', 'Бројач рачуна:', 'КРАЈ ФИСКАЛНОГ РАЧУНА']) {
      expect(text).toContain(s);
    }
    expect(text).toContain('[QR: https://suf.purs.gov.rs/v/?vl=TEST]');
    // štampač sa ćirilicom: CP1251 bajtovi; bez ćirilice: latinica, nikad upitnici
    expect([...encodeText('Ђурђевак Џ', 'cp1251')]).toEqual([0x80, 0xf3, 0xf0, 0x90, 0xe5, 0xe2, 0xe0, 0xea, 0x20, 0x8f]);
    expect(encodeText('ФИСКАЛНИ РАЧУН Љубав', 'ascii').toString('latin1')).toBe('FISKALNI RACUN Ljubav');
    expect([...encodeText('Ч', 'cp852')]).toEqual([0xac]);
    const esc = linesToEscPos(lines, { codepage: 'cp1251' });
    expect(esc.includes(Buffer.from([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30]))).toBe(true); // štampa QR
    expect(esc.includes(Buffer.from('https://suf.purs.gov.rs/v/?vl=TEST'))).toBe(true);
  });

  it('kraj računa: tekst pa slika (raster), posle QR koda', () => {
    const img = { width: 8, height: 1, data: 'gA==' };
    const lines = renderLines('RECEIPT', {
      orderNumber: 6, createdAt: ticket.createdAt, lines: [], total: '0.00', payments: [], footer: 'Srećni praznici', footerImage: img,
      fiscalLayout: { isFiscal: false, transaction: 'ОБУКА ПРОДАЈА', qr: 'https://suf.purs.gov.rs/v/?vl=TEST' },
    }, 80);
    const qr = lines.findIndex((l) => l.qr), txt = lines.findIndex((l) => l.text === 'Srećni praznici'), pic = lines.findIndex((l) => l.raster === img);
    expect(qr).toBeGreaterThan(-1);
    expect(txt).toBeGreaterThan(qr);
    expect(pic).toBe(txt + 1);
    expect(linesToEscPos(lines, { codepage: 'cp1251' }).includes(Buffer.from([0x1d, 0x76, 0x30]))).toBe(true);
  });

  it('reprezentacija kao kratak isečak: sto, konobar, stavke i Za naplatu; ili fiskalni sa natpisom na dnu', () => {
    const base = { orderNumber: 9, table: 'Sto 4', waiter: 'Marko', createdAt: ticket.createdAt, total: '2060.00', discount: '0.00',
      lines: [{ qty: '2.000', name: 'Coca Cola', unitPrice: '250.00', total: '500.00', discount: '0.00', taxLabel: 'Ђ' }], payments: [{ method: 'REPRESENTATION', amount: '2060.00', change: '0.00', note: 'Čast kuće' }] };
    const slip = linesToText(renderLines('RECEIPT', { ...base, repStyle: 'SLIP' }, 80), 80);
    expect(slip).toMatch(/REPREZENTACIJA/);
    expect(slip).toMatch(/2x Coca Cola\s+500,00/);
    expect(slip).toMatch(/Za naplatu =\s+2\.060,00 RSD/);
    expect(slip).not.toMatch(/ПФР/);
    const fis = linesToText(renderLines('RECEIPT', { ...base, repStyle: 'FISCAL', fiscalLayout: { isFiscal: true, transaction: 'ПРОМЕТ ПРОДАЈА', representationNote: 'ОВО ЈЕ ФИСКАЛНИ РАЧУН - РЕПРЕЗЕНТАЦИЈА' } }, 80), 80);
    expect(fis).toMatch(/ПФР/);
    expect(fis.trimEnd().split('\n').slice(-3).join(' ')).toMatch(/РЕПРЕЗЕНТАЦИЈА/);
  });

  it('reprezentacija (na kuću): regularan račun po PU, plaćanje Друго безготовинско', () => {
    const text = linesToText(renderLines('RECEIPT', {
      orderNumber: 9, waiter: 'Ana', createdAt: ticket.createdAt, total: '180.00',
      payments: [{ method: 'REPRESENTATION', amount: '180.00', note: 'Čast kuće' }],
      lines: [{ qty: '1', name: 'Espresso', unitPrice: '180.00', total: '180.00', taxLabel: 'Ђ' }],
      fiscalLayout: { isFiscal: false, representation: false, transaction: 'ОБУКА ПРОДАЈА', pfrNumber: 'TEST-1', taxes: [{ label: 'Ђ', name: 'О-ПДВ', rate: '20.00', tax: '30.00' }], taxTotal: '30.00' },
    }, 80), 80);
    expect(text).toContain('ОБУКА ПРОДАЈА');
    expect(text).toContain('Друго безготовинско:');
    expect(text).not.toContain('РЕПРЕЗЕНТАЦИЈА');
  });

  it('refundacija: referentni broj, povraćaj i potpis kupca', () => {
    const text = linesToText(renderLines('RECEIPT', {
      orderNumber: 7, waiter: 'Ana', createdAt: ticket.createdAt, total: '384.00', payments: [{ method: 'CASH', amount: '384.00' }],
      lines: [{ qty: '1', name: 'Espresso', unitPrice: '132.00', total: '132.00', taxLabel: 'А' }],
      fiscalLayout: { isFiscal: true, transaction: 'КОПИЈА РЕФУНДАЦИЈА', refund: true, refNumber: 'NNYUAVE6-NNYUAVE6-269', refTime: ticket.createdAt, signature: true },
    }, 80), 80);
    expect(text.split('\n')[0]).toMatch(/ФИСКАЛНИ РАЧУН/);
    expect(text).toContain('Реф. број:');
    expect(text).toContain('Повраћај:');
    expect(text).toMatch(/Потпис купца: _+/);
  });

  it('dug PFR broj računa ne izlazi iz reda (58 mm): ide u novi red', () => {
    const lines = renderLines('RECEIPT', { orderNumber: 1, createdAt: ticket.createdAt, lines: [], total: '0.00', payments: [], fiscalLayout: { isFiscal: true, transaction: 'ПРОМЕТ ПРОДАЈА', pfrNumber: 'TEST-20261103-F18A453E-12' } }, 58);
    const text = linesToText(lines, 58);
    expect(text.split('\n').every((l) => l.length <= 32)).toBe(true);
    expect(text).toMatch(/ПФР број рачуна:\n\s*TEST-20261103-F18A453E-12/);
  });

  it('kraj dana - prodaja: ukupno, pa Šank, crta, pa Kuhinja na jednom isečku', () => {
    const text = linesToText(renderLines('SHIFT_REPORT', { mode: 'SALES', title: 'PRODAJA - KRAJ DANA', location: 'Lokal', waiter: 'Smena Petak', createdAt: ticket.createdAt,
      total: { quantity: '5.000', amount: '1200.00' },
      stations: [{ name: 'Šank', quantity: '3.000', amount: '600.00', items: [{ name: 'Espresso', quantity: '3.000', gross: '600.00' }] },
        { name: 'Kuhinja', quantity: '2.000', amount: '600.00', items: [{ name: 'Pljeskavica', quantity: '2.000', gross: '600.00' }] }] }, 80), 80);
    const i = (re: RegExp) => text.search(re);
    expect(i(/UKUPNO PRODATO\s+5 kom/)).toBeGreaterThan(-1);
    expect(i(/ŠANK/)).toBeGreaterThan(i(/UKUPNO PRODATO/));
    expect(i(/KUHINJA/)).toBeGreaterThan(i(/3 x Espresso/));
    expect(text).toMatch(/2 x Pljeskavica\s+600,00/);
  });

  it('kodiranje srpskih slova: ascii transliteracija, CP852 i CP1250', () => {
    expect(encodeText('Đorđe Šuškić Žežej Čačak', 'ascii').toString('latin1')).toBe('Djordje Suskic Zezej Cacak');
    expect([...encodeText('ČčĆćĐđŠšŽž', 'cp852')]).toEqual([0xac, 0x9f, 0x8f, 0x86, 0xd1, 0xd0, 0xe6, 0xe7, 0xa6, 0xa7]);
    expect([...encodeText('ČčĆćĐđŠšŽž', 'cp1250')]).toEqual([0xc8, 0xe8, 0xc6, 0xe6, 0xd0, 0xf0, 0x8a, 0x9a, 0x8e, 0x9e]);
    expect(encodeText('€', 'ascii').toString('latin1')).toBe('?');
  });

  it('ESC/POS: inicijalizacija, kodna strana, sečenje', () => {
    const b = linesToEscPos([{ text: 'A', bold: true }], { codepage: 'cp852' });
    expect([...b.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 18]);
    expect([...b.subarray(b.length - 4)]).toEqual([0x1d, 0x56, 0x42, 0x03]);
    const ascii = linesToEscPos([{ text: 'A' }], { codepage: 'ascii' });
    expect(ascii.includes(Buffer.from([0x1b, 0x74]))).toBe(false); // bez promene kodne strane
  });
});

describe('Adapteri', () => {
  it('TCP: štampač prima tačno poslate bajtove → PRINTED', async () => {
    const p = await fakePrinter();
    const data = linesToEscPos(renderLines('ORDER_TICKET', ticket, 80), { codepage: 'cp852' });
    const r = await sendTcp('127.0.0.1', p.port, data);
    expect(r).toEqual({ status: 'PRINTED' });
    await new Promise((res) => setTimeout(res, 50));
    expect(Buffer.compare(p.received[0], data)).toBe(0);
    await p.close();
  });

  it('TCP: štampač nedostupan → FAILED sa razlogom, ponovljivo', async () => {
    const p = await fakePrinter();
    await p.close(); // port više ne sluša
    const r = await sendTcp('127.0.0.1', p.port, Buffer.from('x'));
    expect(r).toMatchObject({ status: 'FAILED', retryable: true });
    if (r.status === 'FAILED') expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it('TCP: štampač prihvati vezu ali ne odgovara → timeout', async () => {
    const hang = net.createServer(() => undefined); // nikad ne zatvara
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const port = (hang.address() as AddressInfo).port;
    // pošaljemo malo podataka; server ne zatvara → čekamo timeout
    const r = await sendTcp('127.0.0.1', port, Buffer.alloc(10), 300);
    expect(r).toMatchObject({ status: 'FAILED', retryable: true });
    hang.close();
  });

  it('simulacija upisuje fajl i vraća SIMULATED (nikad PRINTED)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
    const r = await writeSimulated(dir, { id: 'p', name: 'Šank - simulacija', connection: 'SIMULATED', host: null, port: null, windowsName: null, paperWidth: 80, active: true }, '12345678-aaaa', 'tekst');
    expect(r).toEqual({ status: 'SIMULATED' });
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).toContain('SIMULACIJA ŠTAMPE');
  });

  it('Windows RAW van Windows-a → trajna greška sa objašnjenjem', async () => {
    if (process.platform === 'win32') return;
    const r = await sendWindowsRaw('EPSON TM-T20', Buffer.from('x'));
    expect(r).toMatchObject({ status: 'FAILED', retryable: false });
  });
});

describe('Petlja bridge-a (lažni server)', () => {
  it('preuzima, štampa na TCP štampač, javlja rezultat; nedostupan štampač → FAILED retryable', async () => {
    const printer = await fakePrinter();
    const results: any[] = [];
    let served = false;
    const api = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        expect(req.headers['x-bridge-key']).toBe('pb_test');
        res.setHeader('content-type', 'application/json');
        if (req.url === '/bridge/jobs/claim') {
          const jobs = served ? [] : [
            { id: 'job-1-aaaaaaaa', kind: 'ORDER_TICKET', attempts: 1, payload: ticket,
              printer: { id: 'p1', name: 'Kuhinja', connection: 'NETWORK_ESCPOS', host: '127.0.0.1', port: printer.port, windowsName: null, paperWidth: 80, active: true } },
            { id: 'job-2-bbbbbbbb', kind: 'ORDER_TICKET', attempts: 1, payload: ticket,
              printer: { id: 'p2', name: 'Šank', connection: 'NETWORK_ESCPOS', host: '127.0.0.1', port: 1, windowsName: null, paperWidth: 80, active: true } },
          ];
          served = true;
          return res.end(JSON.stringify({ jobs }));
        }
        const m = /^\/bridge\/jobs\/(.+)\/result$/.exec(req.url ?? '');
        if (m) { results.push({ id: m[1], ...JSON.parse(body) }); return res.end(JSON.stringify({ ok: true })); }
        res.statusCode = 404; res.end('{}');
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    const b = new PrintBridge({
      apiUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, key: 'pb_test', pollMs: 50,
      codepage: 'ascii', codepageNumber: null, simulatedDir: os.tmpdir(), log: () => undefined,
    });
    expect(await b.tick()).toBe(2);
    expect(await b.tick()).toBe(0);
    expect(results[0]).toEqual({ id: 'job-1-aaaaaaaa', status: 'PRINTED' });
    expect(results[1]).toMatchObject({ id: 'job-2-bbbbbbbb', status: 'FAILED', retryable: true });
    await new Promise((res) => setTimeout(res, 50));
    expect(printer.received[0].toString('latin1')).toContain('Pljeskavica');
    await printer.close();
    api.close();
  });

  it('server nedostupan → petlja ne pada, povećava razmak', async () => {
    const logs: string[] = [];
    const b = new PrintBridge({
      apiUrl: 'http://127.0.0.1:1', key: 'pb_test', pollMs: 20, codepage: 'ascii', codepageNumber: null,
      simulatedDir: os.tmpdir(), log: (m) => logs.push(m),
    });
    b.start();
    await new Promise((r) => setTimeout(r, 1500));
    b.stop();
    expect(b.stats.apiErrors).toBeGreaterThanOrEqual(1);
    expect(logs.some((l) => /Server nije dostupan/.test(l))).toBe(true);
  });
});
