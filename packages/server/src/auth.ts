/**
 * 人のログイン（Google。実装は Better Auth。prd/07）。
 *
 * 設定の中身は `auth-config.ts`（純粋な部分・テスト対象）。ここは組み立てとミドルウェアだけ。
 * worker・動画解析の取り込みは API_KEY の別系統（`middlewares.ts`）で、こことは交わらない。
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createMiddleware } from 'hono/factory';
import { authOptions, authSettings, ownerGate } from './auth-config.js';
import { db, type Tx } from './db/index.js';
import { account, session, users, verification } from './db/schema.js';
import { runAsUser } from './user-tx.js';

/** 起動時に 1 回だけ読む。development 以外で必須の値が無ければここで throw する（起動失敗） */
export const settings = authSettings(process.env);

/**
 * 🔒 **既存の `db` を渡す。別の接続を作らせない**（prd/07 §2.1）。接続の設定（server ロール）を
 * 1 か所に保つため。
 */
export const auth = betterAuth(
  authOptions(
    settings,
    drizzleAdapter(db, {
      provider: 'pg',
      // キーは Better Auth のモデル名（user は modelName: 'users'）
      schema: { users, session, account, verification },
    }),
  ),
);

/** セッションだけを見る経路（`/me`）の context */
export type SessionUserEnv = { Variables: { userId: string } };

/**
 * ログインの経路の context（prd/14 §4「RLS の形」）。
 * - `userId`: セッションから取ったユーザー ID（🔒 リクエスト本文・クエリ文字列から取らない）
 * - `tx`: そのユーザーとして開いたトランザクション。ハンドラとクエリ関数は**これを使う**（グローバルの `db` を使わない）
 * - `afterCommit`: コミットの後に回す処理（メモリ上の状態の後始末。コミット前に落とすと、
 *   まだ見えていない変更を前提に別の報告が古い状態を書き戻せる）
 */
export type SessionEnv = {
  Variables: {
    userId: string;
    tx: Tx;
    afterCommit: (fn: () => void) => void;
  };
};

/** Better Auth のセッション + **所有者ゲート**（prd/07 §5.1）。未ログインは null、所有者以外は 403 */
async function sessionUserId(headers: Headers): Promise<string | 401 | 403> {
  const current = await auth.api.getSession({ headers });
  const userId = current?.user.id ?? null;
  const gate = ownerGate(userId);
  if (gate === 401 || gate === 403) return gate;
  return userId!;
}

/**
 * セッションだけを見る（DB のトランザクションを開かない）。`/me` のようにユーザーの行に触れない口に使う。
 * 未ログインは 401、所有者以外のセッションは 403。
 */
export const sessionUser = createMiddleware<SessionUserEnv>(async (c, next) => {
  const userId = await sessionUserId(c.req.raw.headers);
  if (typeof userId === 'number') return c.body(null, userId);
  c.set('userId', userId);
  await next();
});

/** ハンドラが例外で終わったとき、応答（onError が作った 500）は残したままトランザクションだけを戻す */
class RollbackOnly extends Error {}

/**
 * web 向けエンドポイントの認証（prd/07 §5）と、**ユーザーとして DB に流すトランザクション**（prd/14 §4）。
 *
 * 1. セッション + 所有者ゲート（§5.1）。未ログインは 401、所有者以外のセッションは 403
 * 2. トランザクションを開いて `app.user_id` を設定し（`user-tx.ts`）、`c.get('tx')` に載せる
 * 3. ハンドラが例外で終わったら戻す。正常に返ったらコミットし、`afterCommit` の処理を回す
 *
 * ⚠ Hono はハンドラの例外を内側で 500 に変えて `c.error` に置く（`next()` は投げない）ので、
 *   `c.error` を見て戻す。4xx を返しただけ（例外なし）ならコミットする。
 */
export const sessionRequired = createMiddleware<SessionEnv>(async (c, next) => {
  const userId = await sessionUserId(c.req.raw.headers);
  if (typeof userId === 'number') return c.body(null, userId);
  c.set('userId', userId);
  const callbacks: (() => void)[] = [];
  try {
    await runAsUser(userId, async (tx) => {
      c.set('tx', tx);
      c.set('afterCommit', (fn) => {
        callbacks.push(fn);
      });
      await next();
      if (c.error) throw new RollbackOnly();
    });
  } catch (err) {
    if (err instanceof RollbackOnly) return;
    throw err;
  }
  for (const fn of callbacks) fn();
});
