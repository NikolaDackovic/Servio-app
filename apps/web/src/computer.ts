import { api } from './api';
import { useAuth } from './auth';
import { useLoad, useRefresh } from './ui';

export type Feature = 'quickSale' | 'receipts' | 'endOfDay' | 'shift' | 'priceList' | 'transfer' | 'storno' | 'cash' | 'card';
export interface ComputerSettings { hiddenGroups: string[]; hiddenFeatures: Feature[]; print?: { autoReceipt?: boolean } }
const NONE: ComputerSettings = { hiddenGroups: [], hiddenFeatures: [] };

/** Podešavanja ove kase iz ADMIN-a (Podešavanja → Računari); osvežava se dugmetom "Osveži". */
export function fetchComputer() {
  return api<{ settings: ComputerSettings }>('GET', '/computers/me').then((r) => r.settings).catch(() => NONE);
}

/** `on(f)` = funkcija (dugme) je uključena na ovoj kasi. */
export function useComputer() {
  const { me } = useAuth();
  const { key } = useRefresh();
  const r = useLoad(() => (me ? fetchComputer() : Promise.resolve(NONE)), [me?.user.userId, key]);
  const s = r.data ?? NONE;
  return { ...s, on: (f: Feature) => !s.hiddenFeatures.includes(f) };
}
