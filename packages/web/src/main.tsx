import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { initDisplaySize } from './lib/displaySize';
import './app.css';

const router = createRouter({ routeTree });

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
