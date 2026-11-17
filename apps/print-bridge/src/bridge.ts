import { PrintOutcome, PrinterCfg, sendTcp, sendWindowsRaw, writeSimulated } from './adapters';
import { Codepage, linesToEscPos, linesToText, renderLines } from './render';

export interface BridgeConfig {
  apiUrl: string;
  key: string;
  pollMs: number;
  codepage: Codepage;
  codepageNumber: number | null;
  simulatedDir: string;
  log?: (msg: string) => void;
}

interface Job { id: string; kind: string; attempts: number; payload: any; printer: PrinterCfg }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * Glavna petlja: preuzmi zadatke (atomski na serveru) → odštampaj → javi rezultat.
 * Ako server nije dostupan, petlja čeka sa rastućim razmakom; zadaci ostaju na serveru (ništa se ne gubi).
 * Ako bridge padne usred štampe, server posle isteka zakupa vraća zadatak u red.
 */
export class PrintBridge {
  private stopped = false;
  private backoffMs = 0;
  private timer: NodeJS.Timeout | null = null;
  readonly stats = { printed: 0, simulated: 0, failed: 0, apiErrors: 0 };

  constructor(private readonly cfg: BridgeConfig) {}

  private log(m: string) { (this.cfg.log ?? ((x) => console.log(`[${new Date().toISOString()}] ${x}`)))(m); }

  async call(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-key': this.cfg.key },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? `HTTP ${res.status}`);
    return json;
  }

  async hello() {
    const r = await this.call('/bridge/hello', {});
    this.log(`Povezan kao "${r.bridge.name}". Štampači: ${r.printers.map((p: PrinterCfg) => `${p.name} [${p.connection}]`).join(', ') || 'nema'}`);
    return r;
  }

  async printOne(job: Job): Promise<PrintOutcome> {
    const p = job.printer;
    if (!p.active) return { status: 'FAILED', error: `Štampač "${p.name}" je isključen u podešavanjima`, retryable: false };
    const lines = renderLines(job.kind, job.payload, p.paperWidth);
    if (p.connection === 'SIMULATED') return writeSimulated(this.cfg.simulatedDir, p, job.id, linesToText(lines, p.paperWidth));
    const bytes = linesToEscPos(lines, { codepage: this.cfg.codepage, codepageNumber: this.cfg.codepageNumber });
    if (p.connection === 'NETWORK_ESCPOS') {
      if (!p.host || !p.port) return { status: 'FAILED', error: 'Nedostaje IP adresa ili port štampača', retryable: false };
      return sendTcp(p.host, p.port, bytes);
    }
    if (p.connection === 'WINDOWS_RAW') {
      if (!p.windowsName) return { status: 'FAILED', error: 'Nedostaje naziv Windows štampača', retryable: false };
      return sendWindowsRaw(p.windowsName, bytes);
    }
    return { status: 'FAILED', error: `Nepodržan tip veze: ${p.connection}`, retryable: false };
  }

  /** Jedan krug: vraća broj obrađenih zadataka. */
  async tick(): Promise<number> {
    const { jobs } = await this.call('/bridge/jobs/claim', { limit: 5 }) as { jobs: Job[] };
    for (const job of jobs) {
      let out: PrintOutcome;
      try { out = await this.printOne(job); } catch (e: any) { out = { status: 'FAILED', error: String(e?.message ?? e), retryable: true }; }
      if (out.status === 'PRINTED') this.stats.printed++;
      else if (out.status === 'SIMULATED') this.stats.simulated++;
      else this.stats.failed++;
      this.log(`${job.kind} ${job.id.slice(0, 8)} → ${job.printer.name}: ${out.status}${out.status === 'FAILED' ? ` (${out.error})` : ''}`);
      try {
        await this.call(`/bridge/jobs/${job.id}/result`, out.status === 'FAILED'
          ? { status: 'FAILED', error: out.error.slice(0, 500), retryable: out.retryable } : { status: out.status });
      } catch (e: any) {
        // Rezultat nije zabeležen: server će posle isteka zakupa ponovo dati zadatak (moguća dupla štampa
        // je manje zlo od izgubljenog bloka - ESC/POS ne omogućava proveru šta je već odštampano).
        this.log(`Rezultat za ${job.id.slice(0, 8)} nije poslat: ${e.message}`);
      }
    }
    return jobs.length;
  }

  start() {
    const loop = async () => {
      if (this.stopped) return;
      let delay = this.cfg.pollMs;
      try {
        const n = await this.tick();
        this.backoffMs = 0;
        if (n > 0) delay = 50; // ima još posla - odmah sledeći krug
      } catch (e: any) {
        this.stats.apiErrors++;
        if (e instanceof ApiError && e.status === 401) {
          this.log('Ključ nije prihvaćen (401). Proverite BRIDGE_KEY ili izdajte novi u ADMIN → Štampa. Pokušavam ponovo za 60 s.');
          delay = 60000;
        } else {
          this.backoffMs = Math.min(30000, this.backoffMs ? this.backoffMs * 2 : 1000);
          delay = this.backoffMs;
          this.log(`Server nije dostupan (${e.message}). Novi pokušaj za ${delay} ms.`);
        }
      }
      if (!this.stopped) this.timer = setTimeout(loop, delay);
    };
    void loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
