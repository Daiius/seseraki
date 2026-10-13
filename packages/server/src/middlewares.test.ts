import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiKeyRequired, isTrustedOrigin, originRequired } from './middlewares.js';

describe('isTrustedOrigin', () => {
  const trusted = ['https://app.example', 'http://localhost:5173'];

  it('一覧にあるオリジンだけ（完全一致）', () => {
    expect(isTrustedOrigin('https://app.example', trusted)).toBe(true);
    expect(isTrustedOrigin('http://localhost:5173', trusted)).toBe(true);
    expect(isTrustedOrigin('https://app.example.evil.test', trusted)).toBe(false);
    expect(isTrustedOrigin('http://app.example', trusted)).toBe(false);
    expect(isTrustedOrigin('https://app.example/', trusted)).toBe(false);
  });

  it('ヘッダが無い・null・空は通さない', () => {
    expect(isTrustedOrigin(undefined, trusted)).toBe(false);
    expect(isTrustedOrigin('null', trusted)).toBe(false);
    expect(isTrustedOrigin('', trusted)).toBe(false);
    expect(isTrustedOrigin('https://app.example', [])).toBe(false);
  });
});

describe('originRequired', () => {
  const guarded = new Hono().post('/', originRequired(['https://app.example']), (c) => c.text('ok'));
  const post = (origin?: string) =>
    guarded.request('/', { method: 'POST', headers: origin ? { Origin: origin } : {} });

  it('信頼するオリジンは通す', async () => {
    expect((await post('https://app.example')).status).toBe(200);
  });

  it('別のオリジン・Origin なしは 403（ハンドラに届かない）', async () => {
    expect((await post('https://evil.test')).status).toBe(403);
    expect((await post()).status).toBe(403);
  });
});

const app = new Hono().get('/', apiKeyRequired, (c) => c.text('ok'));
const request = (authorization?: string) =>
  app.request('/', authorization ? { headers: { Authorization: authorization } } : {});

describe('apiKeyRequired', () => {
  const saved = process.env.API_KEY;
  beforeEach(() => {
    process.env.API_KEY = 'secret-key';
  });
  afterEach(() => {
    process.env.API_KEY = saved;
  });

  it('一致する鍵は通す', async () => {
    expect((await request('Bearer secret-key')).status).toBe(200);
  });

  it('違う鍵・長さの違う鍵は 401', async () => {
    expect((await request('Bearer secret-kex')).status).toBe(401);
    expect((await request('Bearer secret')).status).toBe(401);
  });

  it('ヘッダが無ければ 401、形が違えば 400', async () => {
    expect((await request()).status).toBe(401);
    expect((await request('Basic secret-key')).status).toBe(400);
    expect((await request('Bearer a b')).status).toBe(400);
  });

  it('API_KEY が未設定なら何を送っても通さない', async () => {
    delete process.env.API_KEY;
    expect((await request('Bearer undefined')).status).toBe(401);
  });
});
