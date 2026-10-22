import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
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

type Toast = { id: number; kind: 'ok' | 'err'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'err' ? 6000 : 2500);
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

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Zatvori">✕</button></header>
        {children}
      </div>
    </div>
  );
}

/** Numerička tastatura za touch unos iznosa / PIN-a. */
export function Keypad({ value, onChange, decimal = true, maxLen = 12, disabled = false }: { value: string; onChange: (v: string) => void; decimal?: boolean; maxLen?: number; disabled?: boolean }) {
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
    onChange(value === '0' ? k : value + k);
  };
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', decimal ? ',' : 'C', '0', '⌫'];
  return (
    <div className="keypad">
      {keys.map((k) => <button key={k} type="button" className="key" disabled={disabled} onClick={() => press(k)}>{k}</button>)}
    </div>
  );
}
