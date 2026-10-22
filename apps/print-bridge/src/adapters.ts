import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

export interface PrinterCfg {
  id: string; name: string; connection: 'SIMULATED' | 'NETWORK_ESCPOS' | 'WINDOWS_RAW';
  host: string | null; port: number | null; windowsName: string | null; paperWidth: number; active: boolean;
}

/** Rezultat jednog pokušaja štampe. retryable=false → server ne pokušava ponovo (npr. pogrešna konfiguracija). */
export type PrintOutcome =
  | { status: 'PRINTED' | 'SIMULATED' }
  | { status: 'FAILED'; error: string; retryable: boolean };

/**
 * Mrežni termalni štampač (ESC/POS preko "RAW" TCP porta, obično 9100).
 * PRINTED znači da je štampač primio sve bajtove i uredno zatvorio vezu — ESC/POS nema standardnu
 * potvrdu "odštampano" (npr. nestanak papira se ovako ne vidi). To je ograničenje protokola, ne bridge-a.
 */
export function sendTcp(host: string, port: number, data: Buffer, timeoutMs = 7000): Promise<PrintOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (o: PrintOutcome) => { if (!done) { done = true; sock.destroy(); resolve(o); } };
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      sock.write(data, (err) => {
        if (err) return finish({ status: 'FAILED', error: `Greška pri slanju: ${err.message}`, retryable: true });
        sock.end();
      });
    });
    sock.on('close', (hadError) => { if (!hadError) finish({ status: 'PRINTED' }); });
    sock.on('timeout', () => finish({ status: 'FAILED', error: `Štampač ${host}:${port} ne odgovara (timeout ${timeoutMs} ms)`, retryable: true }));
    sock.on('error', (e: NodeJS.ErrnoException) => finish({ status: 'FAILED', error: `${e.code ?? 'ERR'} ${host}:${port} — ${e.message}`, retryable: true }));
  });
}

/** Simulacija: blok se upisuje u tekstualni fajl. Status je UVEK SIMULATED, nikad PRINTED. */
export async function writeSimulated(dir: string, printer: PrinterCfg, jobId: string, text: string): Promise<PrintOutcome> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const safe = printer.name.replace(/[^\p{L}\p{N}_-]+/gu, '_');
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${safe}_${jobId.slice(0, 8)}.txt`);
    await fs.writeFile(file, `=== SIMULACIJA ŠTAMPE — ${printer.name} ===\n${text}`, 'utf8');
    return { status: 'SIMULATED' };
  } catch (e: any) {
    return { status: 'FAILED', error: `Simulacija: ${e.message}`, retryable: true };
  }
}

/**
 * Windows štampač preko spoolera u RAW režimu (ESC/POS bajtovi idu direktno drajveru).
 * Koristi PowerShell + winspool.drv (OpenPrinter/StartDocPrinter/WritePrinter).
 * NAPOMENA: nije testirano na stvarnom Windows računaru u ovoj iteraciji.
 */
export async function sendWindowsRaw(printerName: string, data: Buffer): Promise<PrintOutcome> {
  if (process.platform !== 'win32') {
    return { status: 'FAILED', error: 'WINDOWS_RAW štampač je moguć samo kada Print Bridge radi na Windows-u', retryable: false };
  }
  const tmp = path.join(os.tmpdir(), `pos-print-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  await fs.writeFile(tmp, data);
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class RawPrn {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int StartDocPrinter(IntPtr h, int l, DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static void Send(string name, byte[] bytes) {
    IntPtr h; if (!OpenPrinter(name, out h, IntPtr.Zero)) throw new Exception("OpenPrinter: " + Marshal.GetLastWin32Error());
    try {
      var di = new DOCINFO { pDocName = "POS", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("StartDocPrinter: " + Marshal.GetLastWin32Error());
      StartPagePrinter(h); int w; bool ok = WritePrinter(h, bytes, bytes.Length, out w); EndPagePrinter(h); EndDocPrinter(h);
      if (!ok || w != bytes.Length) throw new Exception("WritePrinter: " + Marshal.GetLastWin32Error());
    } finally { ClosePrinter(h); }
  }
}
"@
[RawPrn]::Send($env:POS_PRINTER_NAME, [System.IO.File]::ReadAllBytes($env:POS_PRINT_FILE))
`;
  try {
    return await new Promise<PrintOutcome>((resolve) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, POS_PRINTER_NAME: printerName, POS_PRINT_FILE: tmp }, windowsHide: true,
      });
      let err = '';
      ps.stderr.on('data', (d) => { err += String(d); });
      const t = setTimeout(() => { ps.kill(); resolve({ status: 'FAILED', error: 'Windows spooler ne odgovara (timeout)', retryable: true }); }, 20000);
      ps.on('close', (code) => {
        clearTimeout(t);
        if (code === 0) resolve({ status: 'PRINTED' });
        else {
          const notFound = /OpenPrinter: 1801/.test(err);
          resolve({ status: 'FAILED', error: notFound ? `Windows štampač "${printerName}" ne postoji` : `Windows štampa: ${err.trim().slice(0, 300) || `kod ${code}`}`, retryable: !notFound });
        }
      });
    });
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}
