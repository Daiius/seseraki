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
import { db } from './db/index.js';
import { account, session, users, verification } from './db/schema.js';

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

export type SessionEnv = { Variables: { userId: string } };

/**
 * web 向けエンドポイントの認証（prd/07 §5）。Better Auth のセッション + **所有者ゲート**（§5.1）。
 * 未ログインは 401、所有者以外のセッションは 403。通したら `c.get('userId')` に載せる。
 */
export const sessionRequired = createMiddleware<SessionEnv>(async (c, next) => {
  const current = await auth.api.getSession({ headers: c.req.raw.headers });
  const userId = current?.user.id ?? null;
  const gate = ownerGate(userId);
  if (gate === 401) return c.body(null, 401);
  if (gate === 403) return c.body(null, 403);
  c.set('userId', userId!);
  await next();
});
