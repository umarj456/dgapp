declare const process: { env: Record<string, string | undefined>; cwd: () => string };
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const file = loadEnv(mode, process.cwd(), '');
  const pick = (key: string, fallback: string) => process.env[key] || file[key] || fallback;
  const port = Number(pick('VITE_PORT', '5173'));
  const host = pick('VITE_HOST', '127.0.0.1');
  const proxyTarget = pick('VITE_PROXY_TARGET', 'http://127.0.0.1:8080');
  return {
    plugins: [react()],
    server: {
      host,
      port,
      strictPort: true,
      // Loopback, a private IP, or an SSH tunnel may send a non-localhost Host.
      // Keep the listen address on loopback or a private interface.
      allowedHosts: true,
      proxy: { '/v1': { target: proxyTarget, changeOrigin: true } },
    },
    preview: { host, port, strictPort: true, allowedHosts: true },
  };
});
