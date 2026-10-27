import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { zv } from './zod-validator.js';

const app = new Hono().post('/', zv('json', z.object({ n: z.number().int().min(1) })), (c) =>
  c.json({ n: c.req.valid('json').n }),
);

const post = (body: unknown) =>
  app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('zv', () => {
  it('検証に通れば値を渡す', async () => {
    const res = await post({ n: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 3 });
  });

  it('失敗の 400 は zod 3 のときと同じ形（issues の配列と name）', async () => {
    const res = await post({ n: 0 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      success: boolean;
      error: { name: string; issues: { path: unknown[]; code: string }[] };
    };
    expect(body.success).toBe(false);
    expect(body.error.name).toBe('ZodError');
    expect(body.error.issues).toHaveLength(1);
    expect(body.error.issues[0]).toMatchObject({ path: ['n'], code: 'too_small' });
  });
});
