import type { AppType } from 'server';
import { hc } from 'hono/client';

// server は basePath('/api') でルートを定義しており、RPC 型のパスは `/api/...` を含む。
// よってクライアントのベースは「オリジン根」でよい（未設定なら同一オリジン）。
// dev は Vite proxy、本番はリバースプロキシが `/api` を書き換えず素通しで server へ渡す。
// 呼び出しは `client.api.kifus` のように basePath を明示する（実 URL /api/... を素直に映す）。
const baseUrl = import.meta.env.VITE_API_URL ?? '';

// Hono RPC の型推論が遠いモジュールを参照しがちなため、一度型だけ取り出して付け直す
type Client = ReturnType<typeof hc<AppType>>;

export const client: Client = hc<AppType>(baseUrl, {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, credentials: 'include' }),
});
