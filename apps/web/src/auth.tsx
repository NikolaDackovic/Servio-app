import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, Me, setUnauthorizedHandler, storage } from './api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  can: (p: string) => boolean;
  loginPin: (pin: string) => Promise<{ id: string; fullName: string; permissions: string[] }>;
  loginPassword: (email: string, password: string, deviceId?: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => { storage.token = null; setMe(null); try { sessionStorage.setItem('pos.manualLogin', '1'); } catch { /* */ } }, []);

  const refresh = useCallback(async () => {
    if (!storage.token) { setMe(null); setLoading(false); return; }
    try { setMe(await api<Me>('GET', '/auth/me')); } catch { storage.token = null; setMe(null); }
    setLoading(false);
  }, []);

  useEffect(() => { setUnauthorizedHandler(logout); refresh(); }, [logout, refresh]);

  const loginPin = async (pin: string) => {
    const deviceId = storage.deviceId;
    if (!deviceId) throw new Error('Uređaj nije registrovan kao kasa');
    const r = await api('POST', '/auth/pin', { deviceId, pin });
    storage.token = r.accessToken;
    await refresh();
    return r.user;
  };
  const loginPassword = async (email: string, password: string, deviceId?: string) => {
    const r = await api('POST', '/auth/login', { email, password, deviceId });
    storage.token = r.accessToken;
    await refresh();
  };
  const can = (p: string) => !!me?.user.permissions.includes(p);

  return <Ctx.Provider value={{ me, loading, can, loginPin, loginPassword, logout, refresh }}>{children}</Ctx.Provider>;
}
