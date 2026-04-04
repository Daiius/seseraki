import { Hono } from 'hono';
import { zValidator as zv } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { kifus, moveAnalyses, candidateMoves } from './db/schema.js';
import { apiKeyRequired } from './middlewares.js';

export const app = new Hono();

const candidateMoveSchema = z.object({
  rank: z.number(),
  move: z.string(),
  scoreType: z.enum(['cp', 'mate']),
  scoreValue: z.number(),
  pv: z.array(z.string()).optional(),
  depth: z.number(),
});

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

      const moves = await db
        .select()
        .from(moveAnalyses)
        .where(eq(moveAnalyses.kifuId, id))
        .orderBy(moveAnalyses.moveNumber);

      const analysesWithCandidates = await Promise.all(
        moves.map(async (move) => {
          const candidates = await db
            .select()
            .from(candidateMoves)
            .where(eq(candidateMoves.moveAnalysisId, move.id))
            .orderBy(candidateMoves.rank);
          return { ...move, candidates };
        }),
      );

      return c.json({ ...kifu, analyses: analysesWithCandidates });
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
    const allKifus = await db.select().from(kifus);
    const unanalyzed = [];
    for (const kifu of allKifus) {
      const [row] = await db
        .select({ id: moveAnalyses.id })
        .from(moveAnalyses)
        .where(eq(moveAnalyses.kifuId, kifu.id))
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
        analyses: z.array(
          z.object({
            moveNumber: z.number(),
            movePlayed: z.string().optional(),
            candidates: z.array(candidateMoveSchema),
          }),
        ),
      }),
    ),
    async (c) => {
      const { kifuId, analyses } = c.req.valid('json');
      for (const analysis of analyses) {
        const [inserted] = await db
          .insert(moveAnalyses)
          .values({
            kifuId,
            moveNumber: analysis.moveNumber,
            movePlayed: analysis.movePlayed ?? null,
          })
          .$returningId();
        if (analysis.candidates.length > 0) {
          await db.insert(candidateMoves).values(
            analysis.candidates.map((c) => ({
              moveAnalysisId: inserted.id,
              rank: c.rank,
              move: c.move,
              scoreType: c.scoreType,
              scoreValue: c.scoreValue,
              pv: c.pv ?? null,
              depth: c.depth,
            })),
          );
        }
      }
      return c.json({ ok: true }, 201);
    },
  );

export type AppType = typeof route;
