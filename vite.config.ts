import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app lives in ./web and is served by the Fastify server in production.
// In development, Vite proxies /api and /setup to the backend
// (default http://127.0.0.1:8080; override with PVE1_DASH_API, and the dev port with VITE_PORT).
const api = process.env.PVE1_DASH_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    host: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/setup': { target: api, changeOrigin: false },
    },
  },
});
