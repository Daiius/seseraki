import type { MiddlewareHandler } from 'hono';

function bearerAuth(envKey: string): MiddlewareHandler {
  return async (c, next) => {
    const key = process.env[envKey];
    const authHeader = c.req.header('Authorization');
    if (!authHeader) return c.body(null, 401);
    const tokens = authHeader.split(' ');
    if (tokens.length !== 2) return c.body(null, 400);
    const [bearer, token] = tokens;
    if (bearer !== 'Bearer') return c.body(null, 400);
    if (token !== key) return c.body(null, 401);
    await next();
  };
}

export const apiKeyRequired = bearerAuth('API_KEY');
