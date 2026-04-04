import type { MiddlewareHandler } from 'hono';

const apiKey = process.env.API_KEY;

export const apiKeyRequired: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader) return c.body(null, 401);
  const tokens = authHeader.split(' ');
  if (tokens.length !== 2) return c.body(null, 400);
  const [bearer, token] = tokens;
  if (bearer !== 'Bearer') return c.body(null, 400);
  if (token !== apiKey) return c.body(null, 401);
  await next();
};
