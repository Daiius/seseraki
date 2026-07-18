import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';

// 同一オリジン配信。ブラウザは常に同一オリジンの /api を叩き、dev では Vite が
// server へ素通しで転送する（server は basePath('/api') なのでパスは書き換えない）。
// 本番はリバースプロキシが同じ規約（/api → server を素通し）で担う。
const apiTarget = process.env.DEV_API_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [TanStackRouterVite(), react(), tailwindcss()],
  server: {
    host: !!process.env.VITE_API_URL,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
});
