import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// ADMIN (backoffice) — posebna aplikacija i poseban port; deli API i zajedničke komponente sa kasom.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, '../web/src') } },
  server: { host: true, port: 5174, strictPort: true, proxy: { '/api': { target: 'http://localhost:3000', ws: true } }, fs: { allow: ['..'] } },
  preview: { port: 4174 },
});
