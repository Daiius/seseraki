import type { AppType } from 'server';
import { hc } from 'hono/client';

const baseUrl = import.meta.env.VITE_API_URL ?? '/api';

// Hono RPC の型推論が遠いモジュールを参照しがちなため、一度型だけ取り出して付け直す
type Client = ReturnType<typeof hc<AppType>>;

export const client: Client = hc<AppType>(baseUrl, {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, credentials: 'include' }),
});
