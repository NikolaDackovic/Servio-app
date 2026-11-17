/**
 * Lokalna baza kase: PostgreSQL iz instalacije (resources/pgsql), podaci u folderu kase.
 * Koriste se initdb i pg_ctl (pg_ctl na Windows-u sam spušta administratorska prava - postgres.exe
 * ne sme da radi kao administrator). Baza sluša samo na 127.0.0.1; spolja se pristupa preko servera kase.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class Database {
  constructor(
    private readonly binDir: string,
    private readonly dataDir: string,
    readonly port: number,
    private readonly password: string,
    private readonly log: (m: string) => void,
  ) {}

  /**
   * Pokreće alat i čeka da ON izađe ('exit', ne 'close'): postgres koji pg_ctl start pokrene nasleđuje
   * izlazne kanale, pa bi čekanje na njihovo zatvaranje trajalo do isteka vremena. Izlaz baze ide u postgres.log.
   */
  private run(tool: string, args: string[], okCodes = [0]) {
    return new Promise<{ code: number; out: string }>((resolve, reject) => {
      const p = spawn(path.join(this.binDir, `${tool}.exe`), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { p.kill(); reject(new Error(`${tool}: isteklo vreme`)); }, 120_000);
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('exit', (code) => {
        clearTimeout(timer);
        // kanali se ne čekaju; ono što je stiglo do izlaza ide u zapis
        setTimeout(() => {
          const text = out.trim();
          if (text) this.log(`${tool}: ${text}`);
          const c = code ?? -1;
          if (okCodes.includes(c)) resolve({ code: c, out: text }); else reject(new Error(`${tool} nije uspeo (${c}): ${text}`));
        }, 50);
        p.stdout.destroy(); p.stderr.destroy();
      });
    });
  }

  /** Prvi put pravi bazu (initdb), zatim je pokreće ako već ne radi (npr. posle pada aplikacije). */
  async start() {
    if (!fs.existsSync(path.join(this.dataDir, 'PG_VERSION'))) {
      this.log('Prvo pokretanje: pravim bazu…');
      fs.mkdirSync(this.dataDir, { recursive: true });
      const pw = path.join(os.tmpdir(), `pos-pw-${process.pid}.txt`);
      fs.writeFileSync(pw, this.password, { mode: 0o600 });
      try {
        await this.run('initdb', ['-D', this.dataDir, '-U', 'pos', `--pwfile=${pw}`, '-E', 'UTF8', '--locale=C', '--auth=scram-sha-256']);
      } finally { fs.rmSync(pw, { force: true }); }
    }
    const status = await this.run('pg_ctl', ['status', '-D', this.dataDir], [0, 3]);
    if (status.code === 0) { this.log('Baza već radi.'); return; }
    await this.run('pg_ctl', [
      'start', '-D', this.dataDir, '-w', '-t', '90', '-l', path.join(this.dataDir, '..', 'logs', 'postgres.log'),
      '-o', `-p ${this.port} -c listen_addresses=127.0.0.1`,
    ]);
  }

  /** Da li baza ovog foldera trenutno radi (npr. ostala posle pada programa). */
  async isRunning() {
    return (await this.run('pg_ctl', ['status', '-D', this.dataDir], [0, 3, 4])).code === 0;
  }

  async stop() {
    await this.run('pg_ctl', ['stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '30'], [0, 1, 3]);
  }

  /** Gašenje Windows-a: nema vremena za asinhrono čekanje - brzo i sinhrono. */
  stopSync() {
    try {
      execFileSync(path.join(this.binDir, 'pg_ctl.exe'), ['stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '15'], { windowsHide: true, stdio: 'ignore', timeout: 20_000 });
    } catch { /* već ugašena */ }
  }
}
