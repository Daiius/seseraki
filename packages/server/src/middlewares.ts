import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

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
