import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Set by dev.py when the dev servers bind a non-default address
// (python dev.py --host <address>, see ../dev.py). The page and its API
// calls then share one origin: /api and /health are proxied to the
// backend running on this machine, so the UI also works when opened
// from another device. Without it, everything stays on localhost.
const devHost = process.env.REMORISE_DEV_HOST;
const apiTarget = `http://${devHost && devHost !== '0.0.0.0' ? devHost : '127.0.0.1'}:8000`;
const proxy = {
  '/api': { target: apiTarget },
  '/health': { target: apiTarget },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, ...(devHost ? { host: devHost } : {}), proxy },
  preview: { port: 4173, ...(devHost ? { host: devHost } : {}), proxy },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
