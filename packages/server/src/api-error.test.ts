/**
 * エラー応答の形（`api-error.ts`）と、アプリ全体の `onError`（`route.ts`）。
 *
 * DB には繋がない。`user-tx.ts` の `runAsUser` を差し替えて、問い合わせると落ちる tx を渡す。
 */
import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { apiError, errorBody, errorCodeOf } from './api-error.js';

const events: string[] = [];

vi.mock('./user-tx.js', () => ({
  runAsUser: async (_userId: string, fn: (tx: unknown) => Promise<unknown>) => {
    try {
      // `select` などを持たない tx。クエリ関数に渡ると TypeError で落ちる（想定外の例外の代わり）
      const result = await fn({});
      events.push('commit');
      return result;
    } catch (err) {
      events.push('rollback');
      throw err;
    }
  },
}));

const ORIGIN = 'http://localhost:5173';
let app: Hono;

beforeAll(async () => {
  process.env.NODE_ENV = 'production';
  process.env.BETTER_AUTH_SECRET = 'x'.repeat(40);
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  const { auth } = await import('./auth.js');
  (auth.api as { getSession: unknown }).getSession = vi.fn().mockResolvedValue({ user: { id: '1' } });
  app = (await import('./route.js')).app as unknown as Hono;
});

describe('errorBody / apiError', () => {
  it('文と種類を返す。文を省けば種類の既定の文', () => {
    expect(errorBody('not_found', '出題が見つかりません')).toEqual({ error: '出題が見つかりません', code: 'not_found' });
    expect(errorBody('body_too_large')).toEqual({ error: 'body too large', code: 'body_too_large' });
  });

  it('足す欄（violations）は残し、error / code を上書きさせない', () => {
    expect(errorBody('bad_request', 'その手は指せません', { violations: [], error: 'x' })).toEqual({
      violations: [],
      error: 'その手は指せません',
      code: 'bad_request',
    });
  });

  it('apiError はその状態コードの JSON を返す', async () => {
    const res = await new Hono().get('/', (c) => apiError(c, 409, 'conflict', '今は無理')).request('/');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: '今は無理', code: 'conflict' });
  });

  it('errorCodeOf: 状態コードから種類', () => {
    expect(errorCodeOf(400)).toBe('bad_request');
    expect(errorCodeOf(404)).toBe('not_found');
    expect(errorCodeOf(413)).toBe('body_too_large');
    expect(errorCodeOf(418)).toBe('bad_request');
    expect(errorCodeOf(500)).toBe('internal');
  });
});

describe('app.onError', () => {
  it('想定外の例外は 500 の JSON。例外の文言を載せず、トランザクションは戻す', async () => {
    events.length = 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request('/api/kifus');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'サーバーで問題が起きました', code: 'internal' });
    expect(text).not.toMatch(/select|TypeError|undefined/);
    expect(events).toEqual(['rollback']);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('壊れた JSON の本文は 400 の JSON（HTTPException の状態コードのまま）', async () => {
    const res = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '入力を受け付けられません', code: 'bad_request' });
  });

  it('zod の検証失敗は従来の形のまま（互換）', async () => {
    const res = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ displayName: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.name).toBe('ZodError');
    expect(Array.isArray(body.error.issues)).toBe(true);
  });

  it('Origin の検査の 403 も同じ形', async () => {
    const res = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ displayName: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin not allowed', code: 'forbidden' });
  });
});
