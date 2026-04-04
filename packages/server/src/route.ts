import { Hono } from 'hono';
import { zValidator as zv } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { kifus, analyses } from './db/schema.js';
import { apiKeyRequired } from './middlewares.js';

export const app = new Hono();

const route = app
  // --- Web 向け（認証なし） ---
  .get('/kifus', async (c) => {
    const rows = await db
      .select({
        id: kifus.id,
        title: kifus.title,
        createdAt: kifus.createdAt,
      })
      .from(kifus)
      .orderBy(kifus.createdAt);
    return c.json(rows);
  })
  .get(
    '/kifus/:id',
    zv('param', z.object({ id: z.coerce.number() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const [kifu] = await db.select().from(kifus).where(eq(kifus.id, id));
      if (!kifu) return c.json({ error: 'not found' }, 404);
      const rows = await db
        .select()
        .from(analyses)
        .where(eq(analyses.kifuId, id))
        .orderBy(analyses.moveNumber);
      return c.json({ ...kifu, analyses: rows });
    },
  )
  .post(
    '/kifus',
    zv('json', z.object({ title: z.string(), kifText: z.string() })),
    async (c) => {
      const data = c.req.valid('json');
      const [result] = await db.insert(kifus).values(data).$returningId();
      return c.json({ id: result.id }, 201);
    },
  )
  .delete(
    '/kifus/:id',
    zv('param', z.object({ id: z.coerce.number() })),
    async (c) => {
      const { id } = c.req.valid('param');
      await db.delete(kifus).where(eq(kifus.id, id));
      return c.json({ ok: true });
    },
  )
  // --- Worker 向け（API_KEY 必須） ---
  .get('/worker/kifus', apiKeyRequired, async (c) => {
    // 未解析の棋譜を取得（analysesが0件の棋譜）
    const allKifus = await db.select().from(kifus);
    const unanalyzed = [];
    for (const kifu of allKifus) {
      const [row] = await db
        .select({ id: analyses.id })
        .from(analyses)
        .where(eq(analyses.kifuId, kifu.id))
        .limit(1);
      if (!row) unanalyzed.push(kifu);
    }
    return c.json(unanalyzed);
  })
  .post(
    '/worker/analyses',
    apiKeyRequired,
    zv(
      'json',
      z.object({
        kifuId: z.number(),
        results: z.array(
          z.object({
            moveNumber: z.number(),
            score: z.number(),
            bestMove: z.string(),
            pv: z.string().optional(),
          }),
        ),
      }),
    ),
    async (c) => {
      const { kifuId, results } = c.req.valid('json');
      if (results.length > 0) {
        await db
          .insert(analyses)
          .values(results.map((r) => ({ ...r, kifuId })));
      }
      return c.json({ ok: true }, 201);
    },
  );

export type AppType = typeof route;
