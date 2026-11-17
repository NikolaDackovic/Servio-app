import { useEffect, useRef } from 'react';
import { api } from './api';
import { ErrorBox, Spinner, useLoad } from './ui';
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { renderLines } from '../../print-bridge/src/render';

type Raster = { width: number; height: number; data: string };

/** Crno-beli raster (logo, slika na kraju računa) kao na termalnom štampaču. */
function RasterImg({ r }: { r: Raster }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    c.width = r.width; c.height = r.height;
    const ctx = c.getContext('2d')!; const img = ctx.createImageData(r.width, r.height);
    const bytes = Uint8Array.from(atob(r.data), (ch) => ch.charCodeAt(0)); const row = r.width / 8;
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
      const on = (bytes[y * row + (x >> 3)] >> (7 - (x & 7))) & 1; const i = (y * r.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = on ? 0 : 255; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [r]);
  return <canvas ref={ref} className="slip2-img" />;
}

/**
 * Isečak računa tačno kao na štampaču: server daje sadržaj računa, a iscrtava ga isti kod kao Print Bridge
 * (raspored Poreske uprave, ćirilica, porezi, PFR podaci, QR, tekst i slika na kraju).
 */
export function ReceiptSlip({ orderId, token }: { orderId: string; token?: string }) {
  const r = useLoad(() => api<{ payload: any }>('GET', `/orders/${orderId}/receipt-preview`, undefined, token), [orderId, token]);
  if (r.loading && !r.data) return <Spinner />;
  if (r.error) return <ErrorBox error={r.error} />;
  return <SlipLines payload={r.data!.payload} />;
}

/** Isečak iz sadržaja računa (payload) - isti kod kao Print Bridge. */
export function SlipLines({ payload }: { payload: any }) {
  const lines = renderLines('RECEIPT', payload, 58) as { text: string; bold?: boolean; center?: boolean; raster?: Raster; qr?: string }[];
  return (
    <div className="slip2">
      {lines.map((l, i) => l.raster ? <RasterImg key={i} r={l.raster} />
        : l.qr ? <div key={i} className="slip2-qr"><QrSvg text={l.qr} size={120} /></div>
          : <div key={i} className={`${l.bold ? 'b' : ''} ${l.center ? 'c' : ''}`}>{l.text || ' '}</div>)}
    </div>
  );
}

/** QR kod kao SVG (fiskalni račun, QR stolova u ADMIN-u). */
export function QrSvg({ text, size = 180 }: { text: string; size?: number }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div className="qr-svg" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
