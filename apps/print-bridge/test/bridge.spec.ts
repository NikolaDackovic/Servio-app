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
    expect(text).toContain('NARUDŽBINA – Kuhinja');
    expect(text).toContain('Sto 3 (Pera)');
    expect(text).toContain('Tura 2');
    expect(text).toContain('2 x Pljeskavica');
    expect(text).toContain('>> bez luka');
    expect(text).toContain('0,5 x Šopska salata');
  });

  it('storno blok je jasno označen', () => {
    const text = linesToText(renderLines('VOID_TICKET', { ...ticket, title: 'STORNO', batch: null, reason: 'Gost odustao' }, 58), 58);
    expect(text).toContain('*** STORNO — NE PRIPREMATI ***');
    expect(text).toContain('Razlog: Gost odustao');
  });

  it('račun koji nije fiskalni to piše na vrhu i na dnu', () => {
    const text = linesToText(renderLines('RECEIPT', {
      title: 'RAČUN', location: 'Demo', orderNumber: 5, table: null, waiter: 'Ana', createdAt: ticket.createdAt,
      lines: [{ qty: '1.000', name: 'Espresso', unitPrice: '180.00', total: '180.00', taxLabel: 'Đ' }],
      subtotal: '180.00', discount: '0.00', total: '180.00', payments: [{ method: 'CASH', amount: '180.00', change: '20.00' }],
      fiscal: { status: 'SIGNED', invoiceNumber: 'TEST-20261022-ABCDEF12-5', isTest: true },
      notFiscalNotice: 'TEST — OVO NIJE FISKALNI RAČUN', copy: true,
    }, 80), 80);
    expect(text.match(/TEST — OVO NIJE FISKALNI RAČUN/g)).toHaveLength(2);
    expect(text).toContain('RAČUN — KOPIJA');
    expect(text).toContain('Kusur');
    expect(text).toContain('Broj: TEST-20261022-ABCDEF12-5');
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
    const r = await writeSimulated(dir, { id: 'p', name: 'Šank – simulacija', connection: 'SIMULATED', host: null, port: null, windowsName: null, paperWidth: 80, active: true }, '12345678-aaaa', 'tekst');
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
