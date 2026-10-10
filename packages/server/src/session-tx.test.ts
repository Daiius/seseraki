/**
 * `sessionRequired` がリクエストごとに「そのユーザーとして」トランザクションを開くこと（prd/14 §4「RLS の形」）。
 *
 * DB には繋がない。`user-tx.ts` の `runAsUser` を差し替えて、誰として開いたか・コミットしたか・戻したかを記録する。
 */
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const events: string[] = [];

vi.mock('./user-tx.js', () => ({
  runAsUser: async (userId: string, fn: (tx: unknown) => Promise<unknown>) => {
    events.push(`begin ${userId}`);
    try {
      const result = await fn({ fake: 'tx' });
      events.push('commit');
      return result;
    } catch (err) {
      events.push('rollback');
      throw err;
    }
  },
}));

let app: Hono;
let getSession: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = 'x'.repeat(40);
  process.env.BETTER_AUTH_URL = 'http://localhost:5173';
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  const { auth, sessionRequired } = await import('./auth.js');
  getSession = vi.fn();
  (auth.api as { getSession: unknown }).getSession = getSession;
  app = new Hono()
    .get('/ok', sessionRequired, (c) => {
      events.push(`handler ${c.get('userId')} ${JSON.stringify(c.get('tx'))}`);
      c.get('afterCommit')(() => events.push('after-commit'));
      return c.json({ ok: true });
    })
    .get('/not-found', sessionRequired, (c) => c.json({ error: 'not found' }, 404))
    .get('/throws', sessionRequired, (c) => {
      c.get('afterCommit')(() => events.push('after-commit'));
      throw new Error('boom');
    });
});

beforeEach(() => {
  events.length = 0;
  getSession.mockReset();
});

describe('sessionRequired のトランザクション', () => {
  it('セッションのユーザーとして開き、ハンドラに tx を渡し、コミットの後に afterCommit を回す', async () => {
    getSession.mockResolvedValue({ user: { id: '1' } });
    const res = await app.request('/ok?userId=evil');
    expect(res.status).toBe(200);
    // 🔒 user id はセッションから（クエリ文字列の値は使わない）
    expect(events).toEqual(['begin 1', 'handler 1 {"fake":"tx"}', 'commit', 'after-commit']);
  });

  it('4xx を返しただけならコミットする', async () => {
    getSession.mockResolvedValue({ user: { id: '1' } });
    expect((await app.request('/not-found')).status).toBe(404);
    expect(events).toEqual(['begin 1', 'commit']);
  });

  it('ハンドラが例外で終わったら戻し、afterCommit は回さない（応答は 500 のまま）', async () => {
    getSession.mockResolvedValue({ user: { id: '1' } });
    expect((await app.request('/throws')).status).toBe(500);
    expect(events).toEqual(['begin 1', 'rollback']);
  });

  it('未ログインは 401 でトランザクションを開かない', async () => {
    getSession.mockResolvedValue(null);
    expect((await app.request('/ok')).status).toBe(401);
    expect(events).toEqual([]);
  });

  it('所有者以外のセッションは 403 でトランザクションを開かない（所有者ゲートは PR4 まで残す）', async () => {
    getSession.mockResolvedValue({ user: { id: 'someone' } });
    expect((await app.request('/ok')).status).toBe(403);
    expect(events).toEqual([]);
  });
});
