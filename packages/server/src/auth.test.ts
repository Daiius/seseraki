import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  issueSession,
  sessionRequired,
  verifyCredentials,
  SESSION_COOKIE_NAME,
} from './auth.js';

describe('verifyCredentials', () => {
  beforeEach(() => {
    process.env.AUTH_USERNAME = 'daiji';
    process.env.AUTH_PASSWORD = 'secret';
  });

  it('正しい資格情報で true', () => {
    expect(verifyCredentials('daiji', 'secret')).toBe(true);
  });

  it('ユーザー名が違うと false', () => {
    expect(verifyCredentials('other', 'secret')).toBe(false);
  });

  it('パスワードが違うと false', () => {
    expect(verifyCredentials('daiji', 'wrong')).toBe(false);
  });

  it('長さが違うパスワードも false', () => {
    expect(verifyCredentials('daiji', 'secretx')).toBe(false);
  });

  it('env var 未設定で false', () => {
    delete process.env.AUTH_USERNAME;
    expect(verifyCredentials('daiji', 'secret')).toBe(false);
  });
});

describe('session cookie', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-secret-for-unit-tests';
    process.env.COOKIE_SECURE = 'false';
    process.env.COOKIE_PATH = '/';
  });

  function makeApp() {
    const app = new Hono();
    app.post('/login', async (c) => {
      await issueSession(c);
      return c.json({ ok: true });
    });
    app.get('/protected', sessionRequired, (c) => c.json({ ok: true }));
    return app;
  }

  it('発行した cookie で protected に通る', async () => {
    const app = makeApp();
    const loginRes = await app.request('/login', { method: 'POST' });
    const setCookie = loginRes.headers.get('set-cookie');
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
    const cookie = setCookie!.split(';')[0];
    const protectedRes = await app.request('/protected', {
      headers: { cookie },
    });
    expect(protectedRes.status).toBe(200);
  });

  it('cookie なしで protected は 401', async () => {
    const app = makeApp();
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
  });

  it('別 secret で検証すると 401', async () => {
    const app = makeApp();
    const loginRes = await app.request('/login', { method: 'POST' });
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0];

    process.env.SESSION_SECRET = 'different-secret';
    const app2 = makeApp();
    const res = await app2.request('/protected', { headers: { cookie } });
    expect(res.status).toBe(401);
  });
});
