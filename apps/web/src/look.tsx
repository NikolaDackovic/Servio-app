import { useEffect, useState } from 'react';

/**
 * Izgled kase po računaru (F12): veličina, debljina i boja teksta na karticama artikala i grupa, boja grupe
 * kao pozadina kartice, tamna tema ekrana artikala. Čuva se u ovom računaru (localStorage).
 */
export interface Look { size: number; bold: boolean; color: string; catSize: number; tint: boolean; dark: boolean }
const DEF: Look = { size: 13, bold: false, color: '#1b1e23', catSize: 15, tint: false, dark: false };
const KEY = 'pos.look';

export const loadLook = (): Look => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEF; } };

export function applyLook(l: Look) {
  const r = document.documentElement;
  r.style.setProperty('--k-prod-size', `${l.size}px`);
  r.style.setProperty('--k-prod-weight', l.bold ? '800' : '400');
  r.style.setProperty('--k-prod-color', l.color);
  r.style.setProperty('--k-cat-size', `${l.catSize}px`);
  r.dataset.kTint = l.tint ? '1' : '';
  r.dataset.kDark = l.dark ? '1' : '';
}

export function useLook() {
  const [look, setLook] = useState<Look>(loadLook);
  useEffect(() => { applyLook(look); }, [look]);
  const save = (l: Look) => { setLook(l); try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* samo za ovu posetu */ } };
  return { look, save, reset: () => save(DEF) };
}

const COLORS = ['#1b1e23', '#000000', '#1d4ed8', '#b91c1c', '#15803d', '#6d28d9', '#ffffff'];

export function LookDialog({ look, onSave, onReset, onClose }: { look: Look; onSave: (l: Look) => void; onReset: () => void; onClose: () => void }) {
  const set = (p: Partial<Look>) => onSave({ ...look, ...p });
  const step = (k: 'size' | 'catSize', d: number) => set({ [k]: Math.min(28, Math.max(10, look[k] + d)) } as Partial<Look>);
  return (
    <div className="kp-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kp k-look" role="dialog" aria-label="Izgled kase">
        <div className="kp-title">Izgled kase (F12)</div>
        <div className="kp-hint">Važi za ovaj računar. Promene se vide odmah.</div>
        <div className="k-look-row"><span>Veličina teksta artikala</span>
          <span className="k-look-step"><button onClick={() => step('size', -1)}>A−</button><b>{look.size}</b><button onClick={() => step('size', 1)}>A+</button></span></div>
        <div className="k-look-row"><span>Veličina teksta grupa</span>
          <span className="k-look-step"><button onClick={() => step('catSize', -1)}>A−</button><b>{look.catSize}</b><button onClick={() => step('catSize', 1)}>A+</button></span></div>
        <div className="k-look-row"><span>Podebljan tekst artikala</span>
          <span className="seg"><button className={`seg-btn ${!look.bold ? 'on' : ''}`} onClick={() => set({ bold: false })}>Normalno</button><button className={`seg-btn ${look.bold ? 'on' : ''}`} onClick={() => set({ bold: true })}>Podebljano</button></span></div>
        <div className="k-look-row"><span>Boja teksta artikala</span>
          <span className="k-look-colors">{COLORS.map((c) => <button key={c} aria-label={c} className={look.color === c ? 'on' : ''} style={{ background: c }} onClick={() => set({ color: c })} />)}</span></div>
        <div className="k-look-row"><span>Kartice artikala u boji grupe</span>
          <span className="seg"><button className={`seg-btn ${!look.tint ? 'on' : ''}`} onClick={() => set({ tint: false })}>Bele</button><button className={`seg-btn ${look.tint ? 'on' : ''}`} onClick={() => set({ tint: true })}>U boji</button></span></div>
        <div className="k-look-row"><span>Tema ekrana artikala</span>
          <span className="seg"><button className={`seg-btn ${!look.dark ? 'on' : ''}`} onClick={() => set({ dark: false })}>Svetla</button><button className={`seg-btn ${look.dark ? 'on' : ''}`} onClick={() => set({ dark: true, color: look.color === '#1b1e23' ? '#ffffff' : look.color })}>Tamna</button></span></div>
        <div className="k-look-prev"><span className="k-prod" style={{ ['--bar' as any]: '#2F7BC4' }}><span className="k-prod-name">Espresso <span className="k-prod-price">(180,00)</span></span></span></div>
        <div className="kp-actions">
          <button type="button" className="kp-btn ok" onClick={onClose}>Gotovo</button>
          <button type="button" className="kp-btn cancel" onClick={onReset}>Podrazumevano</button>
        </div>
      </div>
    </div>
  );
}
