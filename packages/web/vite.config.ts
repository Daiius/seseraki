import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';

// 同一オリジン配信。ブラウザは常に同一オリジンの /api を叩き、dev では Vite が
// server へ素通しで転送する（server は basePath('/api') なのでパスは書き換えない）。
// 本番はリバースプロキシが同じ規約（/api → server を素通し）で担う。
const apiTarget = process.env.DEV_API_TARGET ?? 'http://localhost:4000';

// リモート公開（Cloudflare Tunnel 等の前段プロキシ越し）でのみ必要な差分を env で切替。
// DEV_ALLOWED_HOST 未設定/localhost = ローカル dev（差分なし）。
const allowedHost = process.env.DEV_ALLOWED_HOST;
const isRemote = !!allowedHost && allowedHost !== 'localhost';

// メモ化は React Compiler に委ねる（AGENTS.md）。babel は react() の後に置き、
// JSX 変換後のコードへコンパイラを掛ける。
export default defineConfig({
  plugins: [
    TanStackRouterVite(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  server: {
    // 単体起動（pnpm dev:web）では loopback。compose は command の --host で 0.0.0.0 に、
    // remote は allowedHosts と併せて外向き公開する（下の isRemote 分岐）。
    host: isRemote,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, ws: true },
    },
    // リモートのみ: 未知 Host 拒否を回避する公開ホスト許可と、
    // HMR を Cloudflare 経由（wss://<host>:443）へ向ける設定を上乗せ。
    ...(isRemote
      ? {
          allowedHosts: [allowedHost],
          hmr: { clientPort: 443, protocol: 'wss' as const },
        }
      : {}),
  },
});
