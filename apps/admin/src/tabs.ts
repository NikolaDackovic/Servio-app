import { createContext, useContext } from 'react';

/** Tab u kome je stranica otvorena: zatvaranje sopstvenog taba (dugme Zatvori) i otvaranje novog (npr. dokument iz pregleda). */
export interface TabApi {
  close: () => void;
  open: (view: string, title?: string) => void;
  /** Promena naslova sopstvenog taba (npr. "Ulazna faktura" → "UF-12"). */
  retitle: (title: string, view?: string) => void;
}
export const TabCtx = createContext<TabApi>({ close: () => undefined, open: () => undefined, retitle: () => undefined });
export const useTab = () => useContext(TabCtx);
