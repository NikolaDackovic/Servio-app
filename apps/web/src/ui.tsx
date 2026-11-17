import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export function Spinner({ label = 'Učitavanje…' }: { label?: string }) {
  return <div className="state"><span className="spinner" aria-hidden /> {label}</div>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error as ApiError;
  return (
    <div className="state error" role="alert">
      <strong>{e?.message ?? 'Greška'}</strong>
      {e?.code && <span className="muted"> ({e.code}{e.requestId ? ` · ${e.requestId.slice(0, 8)}` : ''})</span>}
      {onRetry && <button className="btn ghost sm" onClick={onRetry}>Pokušaj ponovo</button>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state empty">{children}</div>;
}

/** Globalno "Osveži" na kasi: komponente koje ga koriste ponovo učitavaju podatke (npr. nove artikle iz ADMIN-a). */
const RefreshCtx = createContext<{ key: number; bump: () => void }>({ key: 0, bump: () => {} });
export const useRefresh = () => useContext(RefreshCtx);
export function RefreshProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState(0);
  const bump = useCallback(() => setKey((k) => k + 1), []);
  return <RefreshCtx.Provider value={{ key, bump }}>{children}</RefreshCtx.Provider>;
}

/** Učitavanje podataka sa stvarnim loading / error / data stanjima. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true); setError(undefined);
    try { setData(await fn()); } catch (e) { setError(e); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

/** info = važno obaveštenje koje kasa uvek prikazuje (npr. nova QR porudžbina) */
type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

/** `quietOk`: bez zelenih obaveštenja o uspehu (kasa); greške se uvek prikazuju. */
export function ToastProvider({ children, quietOk = false }: { children: ReactNode; quietOk?: boolean }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    if (quietOk && kind === 'ok') return;
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'err' ? 6000 : kind === 'info' ? 8000 : 2500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function Modal({ title, onClose, children, wide, full }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; full?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''} ${full ? 'full' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Zatvori">✕</button></header>
        {children}
      </div>
    </div>
  );
}

/** Numerička tastatura za touch unos iznosa / PIN-a. */
/** `pin`: šifra - nule na početku se čuvaju (0000), za iznose se vodeća nula zamenjuje (0 → 5). */
export function Keypad({ value, onChange, decimal = true, maxLen = 12, disabled = false, pin = false }: { value: string; onChange: (v: string) => void; decimal?: boolean; maxLen?: number; disabled?: boolean; pin?: boolean }) {
  const press = (k: string) => {
    if (k === '⌫') return onChange(value.slice(0, -1));
    if (k === 'C') return onChange('');
    if (k === ',') {
      if (!decimal || value.includes('.')) return;
      return onChange((value || '0') + '.');
    }
    if (value.length >= maxLen) return;
    const dot = value.indexOf('.');
    if (dot >= 0 && value.length - dot > 2) return;
    onChange(value === '0' && !pin ? k : value + k);
  };
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', decimal ? ',' : 'C', '0', '⌫'];
  return (
    <div className="keypad">
      {keys.map((k) => <button key={k} type="button" className="key" disabled={disabled} onClick={() => press(k)}>{k}</button>)}
    </div>
  );
}

/**
 * Mala iskačuća numerička tastatura (ne preko celog ekrana): iznos, količina ili PIN.
 * `secret` prikazuje tačkice umesto cifara (PIN). Enter potvrđuje, Esc zatvara; radi i sa fizičkom tastaturom.
 */
export function KeypadDialog({ title, hint, decimal = false, secret = false, money = false, minLen = 1, busy = false, error, confirmLabel = 'Potvrdi', noCancel = false, onConfirm, onClose, children }: {
  title: string; hint?: ReactNode; decimal?: boolean; secret?: boolean; money?: boolean; minLen?: number; busy?: boolean; error?: unknown;
  confirmLabel?: string; noCancel?: boolean; onConfirm: (value: string) => void; onClose: () => void; children?: ReactNode;
}) {
  const [v, setV] = useState('');
  const ok = v.length >= minLen && !busy;
  // šifra može i karticom (čitač kartica) - samo u dijalozima za PIN
  useCardReader((code) => { setV(''); if (!busy) onConfirm(code); }, secret);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') { e.preventDefault(); if (!noCancel) onClose(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (ok) onConfirm(v); }
      else if (e.key === 'Backspace') { e.preventDefault(); setV((x) => x.slice(0, -1)); }
      else if (/^\d$/.test(e.key)) setV((x) => (x.length >= 12 ? x : x === '0' && !secret ? e.key : x + e.key));
      else if ((e.key === ',' || e.key === '.') && decimal) setV((x) => (x.includes('.') ? x : (x || '0') + '.'));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  const shown = secret ? '•'.repeat(v.length) : money && v ? Number(v).toLocaleString('sr-Latn-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.replace('.', ',');
  return (
    <div className="kp-back" onMouseDown={(e) => !noCancel && e.target === e.currentTarget && onClose()}>
      <div className="kp" role="dialog" aria-modal="true" aria-label={title}>
        <div className="kp-title">{title}</div>
        {hint && <div className="kp-hint">{hint}</div>}
        {children}
        <div className="kp-display" aria-live="polite">{shown || <span className="kp-ph">{secret ? 'PIN' : '0'}</span>}</div>
        {error !== undefined && error !== null && <ErrorBox error={error} />}
        <Keypad value={v} onChange={setV} decimal={decimal} maxLen={12} disabled={busy} pin={secret} />
        <div className={`kp-actions ${noCancel ? 'single' : ''}`}>
          <button type="button" className="kp-btn ok" disabled={!ok} onClick={() => onConfirm(v)}>{busy ? '…' : confirmLabel}</button>
          {!noCancel && <button type="button" className="kp-btn cancel" onClick={onClose}>Odustani</button>}
        </div>
      </div>
    </div>
  );
}

/** Uzak ekran (telefon, tablet uspravno): kasa prelazi na raspored za jednu ruku. */
export function useNarrow(maxWidth = 900) {
  const q = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const h = () => setNarrow(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, [q]);
  return narrow;
}

/**
 * Čitač kartica (RFID/magnetni) radi kao tastatura: za tren "otkuca" broj kartice i Enter.
 * Brzo otkucan niz (≥ 6 znakova, razmak između tastera < 50 ms) pre Enter-a = kartica; ručno kucanje je sporije.
 * Hvata se u capture fazi i ne prosleđuje Enter dalje, pa se kartica ne tumači kao PIN.
 */
export function useCardReader(onCard: (code: string) => void, enabled = true) {
  const ref = useRef(onCard);
  ref.current = onCard;
  useEffect(() => {
    if (!enabled) return;
    let buf = ''; let first = 0; let last = 0;
    const h = (e: KeyboardEvent) => {
      const now = performance.now();
      if (e.key === 'Enter') {
        const fast = buf.length >= 6 && (last - first) / (buf.length - 1) < 50 && now - last < 100;
        const code = buf; buf = '';
        if (fast) { e.preventDefault(); e.stopImmediatePropagation(); ref.current(code); }
        return;
      }
      if (e.key.length !== 1 || !/[0-9A-Za-z]/.test(e.key)) { buf = ''; return; }
      if (!buf || now - last > 80) { buf = ''; first = now; }
      buf += e.key; last = now;
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [enabled]);
}
