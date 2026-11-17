import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from '@shared/auth';
import { ToastProvider } from '@shared/ui';
import '@shared/styles.css';
import '@shared/kasa.css';
import './admin.css';
import './admin-theme.css';
import { AdminApp, applySavedTheme } from './AdminApp';

applySavedTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <AdminApp />
      </AuthProvider>
    </ToastProvider>
  </StrictMode>,
);
