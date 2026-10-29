import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { apiError } from './api-error.js';

// 比較の所要時間から鍵を推測されないよう定数時間で比べる。長さの違いも漏らさないよう、
// 両方をハッシュして同じ長さにそろえてから比べる
function sameKey(token: string, key: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(token), digest(key));
}

function bearerAuth(envKey: string): MiddlewareHandler {
  return async (c, next) => {
    const key = process.env[envKey];
    const authHeader = c.req.header('Authorization');
    if (!authHeader) return c.body(null, 401);
    const tokens = authHeader.split(' ');
    if (tokens.length !== 2) return c.body(null, 400);
    const [bearer, token] = tokens;
    if (bearer !== 'Bearer') return c.body(null, 400);
    if (!key || !sameKey(token, key)) return c.body(null, 401);
    await next();
  };
}

export const apiKeyRequired = bearerAuth('API_KEY');

/**
 * `Origin` が信頼するオリジンの一覧にあるか（完全一致）。ヘッダが無い（undefined）・`null` は false。
 */
export function isTrustedOrigin(origin: string | undefined, trusted: readonly string[]): boolean {
  return origin !== undefined && trusted.includes(origin);
}

/**
 * 書き込み口の Origin の検査（prd/14 §5.8）。`Origin` が無いか、信頼するオリジンに無ければ 403。
 *
 * セッションは cookie なので、別のサイトのページからも cookie 付きのリクエストは飛ばせる（CSRF）。
 * `hono/csrf` は form として送れる Content-Type だけを見るので、JSON の POST には掛からない。
 * ブラウザは別オリジンへの POST / PUT に必ず `Origin` を付けるので、それを一覧と突き合わせる。
 *
 * - 🔒 **一覧は Better Auth の `trustedOrigins` と同じものを渡す**（`auth-config.ts`。二重管理にしない）
 * - ⚠ `Origin` を付けないクライアント（curl など）も 403 になる。ブラウザから叩く口にだけ付ける
 *   （worker・動画解析の取り込みは API_KEY の別系統で、cookie を使わない。`originRequiredForWrites` で外す）
 */
export function originRequired(trusted: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    if (!isTrustedOrigin(c.req.header('Origin'), trusted)) {
      return apiError(c, 403, 'forbidden', 'origin not allowed');
    }
    await next();
  };
}

/** 状態を変えないメソッド（Origin の検査を掛けない） */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Origin の検査を要るか（GET / HEAD / OPTIONS 以外で、外すパスの接頭辞に当たらない）。
 * `path` は basePath を含むリクエストのパス（`/api/...`）
 */
export function needsOriginCheck(
  method: string,
  path: string,
  exemptPrefixes: readonly string[],
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  return !exemptPrefixes.some((prefix) => path.startsWith(prefix));
}

/**
 * GET 以外のすべての口に掛ける Origin の検査（prd/14 §5.8・2026-10-30）。`app.use('*', …)` で一括に付ける。
 * `exemptPrefixes` に当たるパス（API_KEY の経路・Better Auth など cookie を使わない／自前で検査する口）は素通し
 */
export function originRequiredForWrites(
  trusted: readonly string[],
  exemptPrefixes: readonly string[],
): MiddlewareHandler {
  const check = originRequired(trusted);
  return async (c, next) => {
    if (!needsOriginCheck(c.req.method, c.req.path, exemptPrefixes)) return next();
    return check(c, next);
  };
}
