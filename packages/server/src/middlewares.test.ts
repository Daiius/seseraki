import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  apiKeyRequired,
  isTrustedOrigin,
  needsOriginCheck,
  originRequired,
  originRequiredForWrites,
} from './middlewares.js';

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

describe('needsOriginCheck・originRequiredForWrites', () => {
  const exempt = ['/api/auth/', '/api/worker/'];

  it('GET / HEAD / OPTIONS は検査しない', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(needsOriginCheck(m, '/api/kifus', exempt)).toBe(false);
    }
  });

  it('それ以外のメソッドは外す接頭辞に当たらなければ検査する', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(needsOriginCheck(m, '/api/kifus/1', exempt)).toBe(true);
      expect(needsOriginCheck(m, '/api/worker/analyses', exempt)).toBe(false);
      expect(needsOriginCheck(m, '/api/auth/sign-out', exempt)).toBe(false);
    }
    // 接頭辞は `/` まで含めて比べる（`/api/workers` のような別の口を外さない）
    expect(needsOriginCheck('POST', '/api/workers', exempt)).toBe(true);
  });

  const guarded = new Hono()
    .use('*', originRequiredForWrites(['https://app.example'], exempt))
    .get('/api/kifus', (c) => c.text('ok'))
    .post('/api/kifus', (c) => c.text('ok'))
    .post('/api/worker/analyses', (c) => c.text('ok'));

  it('書き込みは Origin が無ければ 403・GET と外した経路は通す', async () => {
    expect((await guarded.request('/api/kifus', { method: 'POST' })).status).toBe(403);
    expect(
      (await guarded.request('/api/kifus', { method: 'POST', headers: { Origin: 'https://app.example' } }))
        .status,
    ).toBe(200);
    expect((await guarded.request('/api/kifus')).status).toBe(200);
    expect((await guarded.request('/api/worker/analyses', { method: 'POST' })).status).toBe(200);
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
