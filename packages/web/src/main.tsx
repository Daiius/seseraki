import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { initDisplaySize } from './lib/displaySize';
import './app.css';

const router = createRouter({ routeTree });

// 🔒 **デプロイ前から開いていたタブを、再読み込みで新しい版へ載せ替える。** 画面ごとに
// チャンクを分けているので、古いファイルを消すホストでは、画面遷移の dynamic import が
// 消えたチャンクを取りに行って失敗する。Vite はその失敗を `vite:preloadError` で知らせる。
// ホスト側の設定には頼らず、ここだけで吸収する（どのホストに置いても同じ挙動にするため）。
// ⚠ 再読み込みしても直らない場合（取り直した index.html もまだ古い等）に無限ループしないよう、
// 短時間に 1 回までに抑える。記録できない環境では**再読み込みしない**（抑止が効かないため）。
// preventDefault はしない（すると import が undefined で解決し、呼び出し側が別の形で壊れる）。
const RELOAD_KEY = 'seseraki:chunk-reload-at';
const RELOAD_COOLDOWN_MS = 30_000;
window.addEventListener('vite:preloadError', () => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY));
    if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return;
  }
  window.location.reload();
});

// 🔒 **描画より前に**表示サイズを反映する（`/settings` を開かなくても効かせるため、
// かつ反映が遅れると盤が一瞬大きく描かれてから縮む＝チラつくため）。
initDisplaySize();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
