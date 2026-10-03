/**
 * 🔒 **dev ログインの抜け道が手元の development 以外で出ないこと**をアプリ全体で固定する（prd/07 §6.1）。
 * remote dev（development だが公開オリジン）も閉じる側に入る。
 *
 * `route.ts` は import した時点の `NODE_ENV` でルートを組むので、env を差し替えてから
 * モジュールを読み直す。DB には繋がない（ここで叩く経路は DB に届く前に止まる）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROD_ENV = {
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  BETTER_AUTH_URL: 'http://localhost:5173',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
};
const KEYS = ['NODE_ENV', 'AUTH_ALLOW_SIGNUP', ...Object.keys(PROD_ENV)];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(env: Record<string, string | undefined>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env))
    if (v !== undefined) process.env[k] = v;
}

async function loadApp(env: Record<string, string | undefined>) {
  setEnv(env);
  vi.resetModules();
  return (await import('./route.js')).app;
}

afterEach(() => setEnv(saved));

const ORIGIN = 'http://localhost:5173';
const REMOTE_ORIGIN = 'https://dev.example.test';
// Better Auth のレート制限（email 系は 10 秒に 3 回）の記録は読み直しをまたいで残るので、送信元を毎回変える
let clientSeq = 0;
const jsonPost = (body: unknown, origin = ORIGIN) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin,
    'x-forwarded-for': `192.0.2.${++clientSeq}`,
  },
  body: JSON.stringify(body),
});
const hasDevLogin = (app: Awaited<ReturnType<typeof loadApp>>) =>
  app.routes.some((r) => r.path.startsWith('/api/dev'));

const CLOSED = [
  ...['production', undefined, 'test'].map((nodeEnv) => ({
    label: `NODE_ENV=${nodeEnv ?? '未設定'}`,
    env: { ...PROD_ENV, NODE_ENV: nodeEnv },
    origin: ORIGIN,
  })),
  // 🔒 remote dev: 同じ compose（development）を公開オリジンで使う
  {
    label: 'NODE_ENV=development・公開オリジン（remote dev）',
    env: {
      ...PROD_ENV,
      BETTER_AUTH_URL: REMOTE_ORIGIN,
      NODE_ENV: 'development',
    },
    origin: REMOTE_ORIGIN,
  },
];

for (const { label, env: closedEnv, origin } of CLOSED) {
  describe(label, () => {
    it('/api/dev/login は 404（ルート自体が登録されていない）', async () => {
      const app = await loadApp(closedEnv);
      expect(hasDevLogin(app)).toBe(false);
      expect(
        (await app.request('/api/dev/login', { method: 'POST' })).status,
      ).toBe(404);
      expect(
        (await app.request('/api/dev/login?as=alice', { method: 'POST' }))
          .status,
      ).toBe(404);
    }, 20_000);

    it('email+password のエンドポイントは使えない', async () => {
      const app = await loadApp({ ...closedEnv, AUTH_ALLOW_SIGNUP: 'true' });
      const body = {
        email: 'dev@example.invalid',
        password: 'password-1234',
        name: 'x',
      };
      const up = await app.request(
        '/api/auth/sign-up/email',
        jsonPost(body, origin),
      );
      expect(up.status).toBe(400);
      expect(await up.text()).toMatch(/not enabled/i);
      const signIn = await app.request(
        '/api/auth/sign-in/email',
        jsonPost(body, origin),
      );
      expect(signIn.status).toBe(400);
      expect(await signIn.text()).toMatch(/not enabled/i);
    }, 20_000);

    it('BETTER_AUTH_SECRET が無ければ起動しない（固定値へ逃がさない）', async () => {
      const { BETTER_AUTH_SECRET: _, ...rest } = closedEnv;
      await expect(loadApp(rest)).rejects.toThrow('BETTER_AUTH_SECRET');
    }, 20_000);
  });
}

describe('NODE_ENV=development', () => {
  it('/api/dev/login を登録する', async () => {
    const app = await loadApp({ NODE_ENV: 'development' });
    expect(hasDevLogin(app)).toBe(true);
  }, 20_000);

  it('?as= は名前の形を検査する（DB に届く前に 400）', async () => {
    const app = await loadApp({ NODE_ENV: 'development' });
    const res = await app.request('/api/dev/login?as=Alice%40x', {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  }, 20_000);
});

describe('web 向けのエンドポイント', () => {
  it('未ログインは 401（/api/me と既存のエンドポイント）', async () => {
    const app = await loadApp({ ...PROD_ENV, NODE_ENV: 'production' });
    expect((await app.request('/api/me')).status).toBe(401);
    expect((await app.request('/api/kifus')).status).toBe(401);
  }, 20_000);

  it('旧ログインのエンドポイントは無い（prd/07 §8）', async () => {
    const app = await loadApp({ ...PROD_ENV, NODE_ENV: 'production' });
    const paths = app.routes.map((r) => r.path);
    expect(paths).not.toContain('/api/auth/login');
    expect(paths).not.toContain('/api/auth/me');
    expect(paths).not.toContain('/api/auth/logout');
  }, 20_000);
});
