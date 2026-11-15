import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run build` writes web/dist, which the backend serves.
// `npm run dev:web` serves the page with hot reload and forwards API calls to a running backend.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:4517',
      '/ws': { target: 'ws://127.0.0.1:4517', ws: true },
    },
  },
});
