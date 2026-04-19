import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port can be overridden via env var (PORT=XXXX npm run dev)
const DEV_PORT = parseInt(process.env.PORT || '13173', 10);
const API_PORT = parseInt(process.env.API_PORT || '13001', 10);

export default defineConfig({
  plugins: [react()],
  server: {
    port: DEV_PORT,
    allowedHosts: ['sliver-critter-unseemly.ngrok-free.dev'],
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
    },
  },
});
