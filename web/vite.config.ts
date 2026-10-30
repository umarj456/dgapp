declare const process: { env: Record<string, string | undefined> };
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8080' } },
});
