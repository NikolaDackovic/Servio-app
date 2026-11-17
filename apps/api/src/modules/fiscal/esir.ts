import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { FiscalRequest, FiscalResult, FiscalizationProvider } from './fiscal';

/**
 * Veza ka procesoru fiskalnih računa (PFR) po Tehničkom vodiču Poreske uprave (SUF, API v3):
 *  - LPFR: lokalni program/uređaj (npr. http://localhost:5555), otključava se PIN-om bezbednosnog elementa;
 *  - VPFR: virtuelni procesor (https), klijentski sertifikat (.pfx) + PAC u zaglavlju.
 * Tajni podaci (PIN, PAC, lozinka sertifikata) se čitaju iz podešavanja kase u trenutku slanja - ne upisuju se u fiskalni red.
 */
export interface EsirConnection {
  kind: 'LPFR' | 'VPFR';
  url: string;
  pin?: string;
  pac?: string;
  certPath?: string;
  certPassword?: string;
  /** broj ESIR-a (podešavanja lokala) - ide kao broj računa ESIR-a */
  esirNumber?: string;
}

/** Oznake poreskih stopa u PFR-u su ćirilične (Ђ, Е, А, Г, Ж); u bazi su latinične. */
const LABEL: Record<string, string> = { 'Đ': 'Ђ', 'E': 'Е', 'A': 'А', 'G': 'Г', 'Ž': 'Ж' };
export const pfrLabel = (l: string) => LABEL[l] ?? l;

/** "localhost:5555" -> "http://localhost:5555", bez završne kose crte */
export const normalizeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : `http://${u}`).replace(/\/+$/, '');

type Res = { status: number; body: any };

export class EsirProvider implements FiscalizationProvider {
  readonly isTest = false;
  constructor(private readonly c: EsirConnection, private readonly timeoutMs = 15000) {}
  get code() { return this.c.kind; }

  private call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> {
    const u = new URL(normalizeUrl(this.c.url) + path);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string | number> = {
      Accept: 'application/json', 'Accept-Language': 'sr-Cyrl-RS', RequestId: randomUUID().slice(0, 32),
    };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (this.c.kind === 'VPFR' && this.c.pac) headers.PAC = this.c.pac;
    const opts: https.RequestOptions = { method, headers, timeout: this.timeoutMs };
    if (u.protocol === 'https:' && this.c.certPath) {
      opts.pfx = fs.readFileSync(this.c.certPath);
      opts.passphrase = this.c.certPassword || undefined;
    }
    const lib = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const rq = lib.request(u, opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          let parsed: any = txt;
          try { parsed = txt ? JSON.parse(txt) : null; } catch { /* tekstualni odgovor */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      rq.on('timeout', () => rq.destroy(new Error(`${this.c.kind} ne odgovara (${this.timeoutMs / 1000}s)`)));
      rq.on('error', reject);
      if (data) rq.write(data);
      rq.end();
    });
  }

  /** LPFR: status bezbednosnog elementa; 1300 = kartica nije u čitaču, 1500 = traži PIN. */
  private async unlockLpfr(): Promise<string | null> {
    const st = await this.call('GET', '/api/v3/status');
    const gsc: string[] = Array.isArray(st.body?.gsc) ? st.body.gsc.map(String) : [];
    if (gsc.includes('1300')) return 'Bezbednosni element (kartica) nije u čitaču';
    if (gsc.includes('1500')) {
      if (!this.c.pin) return 'LPFR traži PIN - unesite PIN u ADMIN > Računari';
      const r = await this.call('POST', '/api/v3/pin', this.c.pin);
      const code = String(r.body ?? '').replace(/"/g, '');
      if (code !== '0100') return code === '2400' ? 'LPFR nije spreman (2400)' : `PIN nije prihvaćen (${code || r.status})`;
    }
    return null;
  }

  /** Provera veze bez izdavanja računa (ADMIN > Računari). */
  async check(): Promise<{ ok: boolean; message: string }> {
    try {
      const st = await this.call('GET', '/api/v3/status');
      if (st.status < 200 || st.status >= 300) return { ok: false, message: `Odgovor ${st.status}` };
      if (this.c.kind === 'LPFR') {
        const err = await this.unlockLpfr();
        if (err) return { ok: false, message: err };
      }
      const b = st.body ?? {};
      return { ok: true, message: `Povezano${b.uid ? ` - JID ${b.uid}` : ''}${b.sdcDateTime ? `, vreme PFR ${b.sdcDateTime}` : ''}` };
    } catch (e: any) {
      return { ok: false, message: `${e?.code ?? ''} ${e?.message ?? e}`.trim() };
    }
  }

  /** Telo zahteva po Tehničkom vodiču (InvoiceRequest). */
  static invoiceBody(req: FiscalRequest, esirNumber?: string) {
    return {
      dateAndTimeOfIssue: req.issuedAt,
      cashier: req.cashier || undefined,
      buyerId: req.buyerId || undefined,
      buyerCostCenterId: req.buyerCostCenterId || undefined,
      invoiceType: req.invoiceType === 'TRAINING' ? 'Training' : 'Normal',
      transactionType: req.transactionType === 'REFUND' ? 'Refund' : 'Sale',
      payment: req.payments.map((p) => ({ amount: Number(p.amount), paymentType: p.paymentType })),
      invoiceNumber: esirNumber ? `${esirNumber}/${req.orderNumber}${req.refundNumber ? `-R${req.refundNumber}` : ''}` : undefined,
      referentDocumentNumber: req.referentDocumentNumber || undefined,
      referentDocumentDT: req.referentDocumentDT || undefined,
      options: { omitQRCodeGen: '1', omitTextualRepresentation: '1' },
      items: req.items.map((i) => {
        const qty = Number(i.quantity), total = Number(i.totalAmount);
        // popust je već u ukupnom iznosu stavke; jedinična cena = iznos / količina
        return { name: i.name.slice(0, 2048), quantity: qty, unitPrice: qty ? Math.round((total / qty) * 100) / 100 : total, labels: i.labels.map(pfrLabel), totalAmount: total };
      }),
    };
  }

  async sign(req: FiscalRequest): Promise<FiscalResult> {
    try {
      if (this.c.kind === 'LPFR') {
        const err = await this.unlockLpfr();
        if (err) return { ok: false, retryable: true, error: err };
      } else if (!this.c.certPath || !this.c.pac) {
        return { ok: false, retryable: false, error: 'VPFR: nedostaje sertifikat ili PAC (ADMIN > Računari)' };
      }
      const r = await this.call('POST', '/api/v3/invoices', EsirProvider.invoiceBody(req, this.c.esirNumber));
      if (r.status >= 200 && r.status < 300 && r.body?.invoiceNumber) {
        const { verificationQRCode: _qr, journal: _j, ...raw } = r.body;
        return { ok: true, invoiceNumber: r.body.invoiceNumber, verificationUrl: r.body.verificationUrl ?? null, signedAt: r.body.sdcDateTime, raw };
      }
      const msg = typeof r.body === 'string' ? r.body : r.body?.message ?? JSON.stringify(r.body?.modelState ?? r.body);
      // 4xx = račun odbijen (podaci) - ponavljanje ne pomaže; 5xx/ostalo = privremeno
      return { ok: false, retryable: r.status >= 500 || r.status === 0, error: `${this.c.kind} ${r.status}: ${String(msg).slice(0, 500)}`, raw: typeof r.body === 'object' ? r.body : undefined };
    } catch (e: any) {
      return { ok: false, retryable: true, error: `${this.c.kind}: ${e?.code ?? ''} ${e?.message ?? e}`.trim() };
    }
  }
}
