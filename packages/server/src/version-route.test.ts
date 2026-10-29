/**
 * `GET /api/version`（prd/02 §5）: 認証なしで、イメージのビルド引数から入れた ENV を返す。
 *
 * `route.ts` は import した時点の env で版を読むので、env を差し替えてからモジュールを読み直す
 * （`auth-routes.test.ts` と同じ形）。DB には繋がない。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROD_ENV = {
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  BETTER_AUTH_URL: 'http://localhost:5173',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
};
const KEYS = [...Object.keys(PROD_ENV), 'GIT_COMMIT', 'BUILD_TIME', 'GIT_DIRTY'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(env: Record<string, string | undefined>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env))
    if (v !== undefined) process.env[k] = v;
}

async function getVersion(env: Record<string, string | undefined>) {
  setEnv(env);
  vi.resetModules();
  const { app } = await import('./route.js');
  return app.request('/api/version');
}

afterEach(() => setEnv(saved));

const SHA = 'aa0922b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7';

describe('GET /api/version', () => {
  it('ログインなしでビルド引数の値を返す', async () => {
    const res = await getVersion({
      ...PROD_ENV,
      GIT_COMMIT: SHA,
      BUILD_TIME: '2026-10-30T01:02:03Z',
      GIT_DIRTY: 'true',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      commit: SHA,
      builtAt: '2026-10-30T01:02:03.000Z',
      dirty: true,
    });
  });

  it('ビルド引数が無ければ unknown', async () => {
    const res = await getVersion(PROD_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      commit: 'unknown',
      builtAt: 'unknown',
      dirty: false,
    });
  });
});
