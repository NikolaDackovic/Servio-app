import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// U razvoju se /api prosleđuje na backend, pa frontend i API dele isti origin.
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
