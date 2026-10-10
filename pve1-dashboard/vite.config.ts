import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app lives in ./web and is served by the Fastify server in production.
// In development, Vite proxies /api and /setup to the backend on :8080.
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
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/setup': { target: 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
});
