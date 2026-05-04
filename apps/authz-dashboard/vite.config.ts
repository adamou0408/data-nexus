import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port can be overridden via env var (PORT=XXXX npm run dev)
const DEV_PORT = parseInt(process.env.PORT || '13173', 10);
const API_PORT = parseInt(process.env.API_PORT || '13001', 10);
// In docker-compose.dev.yml the dashboard container reaches the api by
// service DNS, so we set API_PROXY_TARGET=http://authz-api-dev:13001 there.
// On host (default) we proxy to localhost:13001 as before.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET || `http://localhost:${API_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: DEV_PORT,
    allowedHosts: ['sliver-critter-unseemly.ngrok-free.dev'],
    proxy: {
      '/api': API_PROXY_TARGET,
    },
    // HMR over polling — bind-mounted source on Windows / Docker Desktop
    // misses native fs events without this.
    watch: {
      usePolling: process.env.CHOKIDAR_USEPOLLING === 'true',
      interval: parseInt(process.env.CHOKIDAR_INTERVAL || '400', 10),
    },
  },
});
