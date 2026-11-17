import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './auth';
import { RefreshProvider, ToastProvider } from './ui';
import { GuestMenu } from './pages/GuestMenu';
import './styles.css';
import './kasa.css';
import './kds.css';
import './guest.css';

// /m/<kod> = meni za gosta (QR kod na stolu) - bez prijave i bez kase
const guest = /^\/m\/([0-9a-z]{8,24})\/?$/.exec(location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {guest ? <GuestMenu token={guest[1]} /> : (
      <ToastProvider quietOk>
        <AuthProvider>
          <RefreshProvider>
            <App />
          </RefreshProvider>
        </AuthProvider>
      </ToastProvider>
    )}
  </StrictMode>,
);
