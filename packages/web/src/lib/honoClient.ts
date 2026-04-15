import type { AppType } from 'server';
import { hc } from 'hono/client';

const baseUrl = import.meta.env.VITE_API_URL ?? '/api';

export const client = hc<AppType>(baseUrl, {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, credentials: 'include' }),
});
