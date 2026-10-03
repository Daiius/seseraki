/**
 * dev ログインの抜け道（prd/07 §6.1）。**`NODE_ENV=development` のときだけ登録する**
 * （`route.ts` が `settings.isDev` を見て載せる。それ以外ではルート自体が無く 404）。
 *
 * 固定の dev ユーザーで `signUpEmail`（既にあれば握りつぶす）→ `signInEmail` して、
 * **Better Auth の本物のセッション cookie** を返す。以後の経路（`sessionRequired`・失効）は本番と同じ。
 * 目的は Playwright の E2E を Google なしで通すこと。
 *
 * - 既定は**所有者**（"1"）。初回に移行手順（prd/07 §4）と同じ付け替えを `credential` で行う
 *   ——本番で一度しか流さない付け替えのコードが、dev のたびに通る
 * - `?as=<名前>` で**所有者ではない別の dev ユーザー**として入る（所有者ゲートの 403 を確かめる経路）
 */
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { auth as Auth } from './auth.js';
import { db } from './db/index.js';
import { account, users } from './db/schema.js';
import { linkOwnerAccount } from './owner-account.js';
import { OWNER_USER_ID } from './users.js';

/** dev ユーザーの共通パスワード（development でしか email+password が有効にならない） */
export const DEV_PASSWORD = 'seseraki-dev-password';
/** 所有者に付け替える dev ユーザーのメール（予約ドメイン） */
export const DEV_OWNER_EMAIL = 'dev@example.invalid';
/** `?as=` の名前（小文字英数と - _ のみ。メールに埋めるので絞る） */
export const DEV_AS_PATTERN = /^[a-z0-9_-]{1,32}$/;

export function devUserEmail(as: string): string {
  return `dev+${as}@example.invalid`;
}

async function trySignUp(
  auth: typeof Auth,
  email: string,
  name: string,
): Promise<void> {
  try {
    await auth.api.signUpEmail({
      body: { email, password: DEV_PASSWORD, name },
    });
  } catch {
    // 既にいる。サインインへ進む
  }
}

/** 所有者として入るためのメールを決める（必要なら付け替える） */
async function ownerEmail(auth: typeof Auth): Promise<string> {
  const linked = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, OWNER_USER_ID),
        eq(account.providerId, 'credential'),
      ),
    );
  if (linked.length === 0) {
    // "1" にまだ credential の account が無い → dev ユーザーを作り、移行手順と同じ関数で付け替える
    await trySignUp(auth, DEV_OWNER_EMAIL, 'Dev Owner');
    const result = await linkOwnerAccount(db, {
      provider: 'credential',
      apply: true,
      email: DEV_OWNER_EMAIL,
    });
    if (!result.applied) {
      throw new Error(
        `dev ユーザーを所有者へ付け替えられない: ${result.decision.kind}`,
      );
    }
  }
  // 🔴 固定の dev メールではなく **"1" の現在のメール**で入る。移行の練習（prd/07 §6.3）で
  // "1" のメールが Google のものに書き換わった後に、別の dev ユーザーが作られて所有者でなくなるのを防ぐ
  const [owner] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, OWNER_USER_ID));
  if (!owner) throw new Error('所有者の行が無い。マイグレーションを先に流す');
  return owner.email;
}

/** `/dev` 配下のルート。`route.ts` が development のときだけ `app.route('/dev', …)` で載せる */
export function devLoginRoutes(auth: typeof Auth): Hono {
  const app = new Hono();
  app.post('/login', async (c) => {
    const as = c.req.query('as');
    let email: string;
    if (as === undefined) {
      email = await ownerEmail(auth);
    } else {
      if (!DEV_AS_PATTERN.test(as)) {
        return c.json({ error: 'as は小文字英数と - _ の 32 文字まで' }, 400);
      }
      email = devUserEmail(as);
      await trySignUp(auth, email, `Dev ${as}`);
    }
    return auth.api.signInEmail({
      body: { email, password: DEV_PASSWORD },
      asResponse: true,
    });
  });
  return app;
}
