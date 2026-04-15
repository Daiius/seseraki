import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';

export const SESSION_COOKIE_NAME = 'seseraki_session';
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 日

/** 長さが違っても timing-safe に比較（短い方に揃えた後、長さ不一致なら false） */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // 長さ比較自体は timing-safe でなくて良い（長さは秘密ではない）
    // ダミー比較で定数時間を保つ
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

function isSecureCookie(): boolean {
  return process.env.COOKIE_SECURE === 'true';
}

function getCookiePath(): string {
  return process.env.COOKIE_PATH ?? '/';
}

/** セッション cookie を発行。値は発行時刻 (ms) */
export async function issueSession(c: Context): Promise<void> {
  const issuedAt = Date.now().toString();
  await setSignedCookie(c, SESSION_COOKIE_NAME, issuedAt, getSessionSecret(), {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: 'Lax',
    path: getCookiePath(),
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

/** セッション cookie を破棄 */
export function revokeSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: getCookiePath(),
    secure: isSecureCookie(),
  });
}

/** cookie が有効なら true。署名不正・期限切れ・未設定は false */
export async function hasValidSession(c: Context): Promise<boolean> {
  const value = await getSignedCookie(c, getSessionSecret(), SESSION_COOKIE_NAME);
  if (!value) return false;
  const issuedAt = Number(value);
  if (!Number.isFinite(issuedAt)) return false;
  return Date.now() - issuedAt < SESSION_MAX_AGE_SEC * 1000;
}

/** ログイン済みでなければ 401 を返すミドルウェア */
export const sessionRequired: MiddlewareHandler = async (c, next) => {
  if (!(await hasValidSession(c))) return c.body(null, 401);
  await next();
};

/** ユーザー名とパスワードを env var の認証情報と照合 */
export function verifyCredentials(username: string, password: string): boolean {
  const expectedUsername = process.env.AUTH_USERNAME;
  const expectedPassword = process.env.AUTH_PASSWORD;
  if (!expectedUsername || !expectedPassword) return false;
  const userMatches = safeEqual(username, expectedUsername);
  const passwordMatches = safeEqual(password, expectedPassword);
  return userMatches && passwordMatches;
}
