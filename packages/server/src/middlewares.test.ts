import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiKeyRequired } from './middlewares.js';

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
