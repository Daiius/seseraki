import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { zValidator as zv } from '@hono/zod-validator';
import { z } from 'zod';
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { kifus, moveAnalyses, candidateMoves } from './db/schema.js';
import { apiKeyRequired, clientApiKeyRequired } from './middlewares.js';
import { swarsToKif, formatTitle, parsePlayedAt } from './swars/csa-to-kif.js';
import { fetchHistoryKeys, fetchGameData } from './swars/fetch.js';
import { parseKif } from './kif/parser.js';

export const app = new Hono();

const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use('*', logger());
if (corsOrigins.length > 0) {
  app.use('*', cors({ origin: corsOrigins, credentials: true }));
}

/** KIF テキストから USI 指し手列を抽出。パースエラー時は null */
function kifToUsiMoves(kifText: string): string[] | null {
  const parsed = parseKif(kifText);
  if (parsed.moves.length === 0) return null;
  return parsed.moves.map((m) => m.usi);
}

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
  .get(
    '/kifus',
    zv('query', z.object({ page: z.coerce.number().min(1).default(1) })),
    async (c) => {
      const { page } = c.req.valid('query');
      const limit = 50;
      const offset = (page - 1) * limit;

      const [{ total }] = await db
        .select({ total: count() })
        .from(kifus);

      const rows = await db
        .select({
          id: kifus.id,
          title: kifus.title,
          sente: kifus.sente,
          gote: kifus.gote,
          senteDan: kifus.senteDan,
          goteDan: kifus.goteDan,
          result: kifus.result,
          playedAt: kifus.playedAt,
          createdAt: kifus.createdAt,
          analyzedAt: kifus.analysisCompletedAt,
        })
        .from(kifus)
        .orderBy(desc(sql`coalesce(${kifus.playedAt}, ${kifus.createdAt})`))
        .limit(limit)
        .offset(offset);

      return c.json({
        kifus: rows.map(({ analyzedAt, ...r }) => ({ ...r, analyzed: analyzedAt !== null })),
        pagination: {
          page,
          totalPages: Math.ceil(total / limit),
          total,
        },
      });
    },
  )
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

      const candidates = moves.length
        ? await db
            .select()
            .from(candidateMoves)
            .where(
              inArray(
                candidateMoves.moveAnalysisId,
                moves.map((move) => move.id),
              ),
            )
            .orderBy(candidateMoves.moveAnalysisId, candidateMoves.rank)
        : [];

      const candidatesByMoveAnalysisId = new Map<number, typeof candidates>();
      for (const candidate of candidates) {
        const existing = candidatesByMoveAnalysisId.get(candidate.moveAnalysisId);
        if (existing) {
          existing.push(candidate);
        } else {
          candidatesByMoveAnalysisId.set(candidate.moveAnalysisId, [candidate]);
        }
      }

      const analysesWithCandidates = moves.map((move) => ({
        ...move,
        candidates: candidatesByMoveAnalysisId.get(move.id) ?? [],
      }));

      return c.json({ ...kifu, analyses: analysesWithCandidates });
    },
  )
  .post(
    '/kifus',
    zv('json', z.object({ title: z.string(), kifText: z.string() })),
    async (c) => {
      const { title, kifText } = c.req.valid('json');
      const usiMoves = kifToUsiMoves(kifText);
      const [result] = await db
        .insert(kifus)
        .values({ title, kifText, usiMoves })
        .$returningId();
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
    const [kifu] = await db
      .select({ id: kifus.id, title: kifus.title, kifText: kifus.kifText, usiMoves: kifus.usiMoves })
      .from(kifus)
      .where(and(isNull(kifus.analysisCompletedAt), isNotNull(kifus.usiMoves)))
      .orderBy(sql`coalesce(${kifus.playedAt}, ${kifus.createdAt}) asc`)
      .limit(1);
    return c.json(kifu ?? null);
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
            candidates: z.array(candidateMoveSchema),
          }),
        ),
      }),
    ),
    async (c) => {
      const { kifuId, analyses } = c.req.valid('json');
      await db.transaction(async (tx) => {
        await tx.delete(moveAnalyses).where(eq(moveAnalyses.kifuId, kifuId));

        for (const analysis of analyses) {
          const [inserted] = await tx
            .insert(moveAnalyses)
            .values({
              kifuId,
              moveNumber: analysis.moveNumber,
            })
            .$returningId();
          if (analysis.candidates.length > 0) {
            await tx.insert(candidateMoves).values(
              analysis.candidates.map((candidate) => ({
                moveAnalysisId: inserted.id,
                rank: candidate.rank,
                move: candidate.move,
                scoreType: candidate.scoreType,
                scoreValue: candidate.scoreValue,
                pv: candidate.pv ?? null,
                depth: candidate.depth,
              })),
            );
          }
        }
        await tx
          .update(kifus)
          .set({ analysisCompletedAt: new Date() })
          .where(eq(kifus.id, kifuId));
      });
      return c.json({ ok: true }, 201);
    },
  )
  // --- swars 棋譜取得 ---
  .post(
    '/swars/import',
    clientApiKeyRequired,
    zv(
      'json',
      z.object({
        userId: z.string(),
        gtype: z.enum(['', 'sb', 's1']).default(''),
        pages: z.number().min(1).max(10).default(1),
      }),
    ),
    async (c) => {
      const { userId, gtype, pages } = c.req.valid('json');
      const cookie = process.env.SWARS_SESSION_COOKIE;
      if (!cookie) {
        return c.json({ error: 'SWARS_SESSION_COOKIE not configured' }, 500);
      }

      const imported: { id: number; gameKey: string }[] = [];
      const skipped: string[] = [];
      const errors: { gameKey: string; error: string }[] = [];

      // 履歴ページから対局キーを収集
      const allKeys: string[] = [];
      for (let page = 1; page <= pages; page++) {
        const keys = await fetchHistoryKeys(userId, gtype, page, cookie);
        allKeys.push(...keys);
        if (keys.length === 0) break;
      }

      // 各対局を取得・変換・保存
      for (const gameKey of allKeys) {
        // 重複チェック
        const [existing] = await db
          .select({ id: kifus.id })
          .from(kifus)
          .where(eq(kifus.swarsGameKey, gameKey))
          .limit(1);
        if (existing) {
          skipped.push(gameKey);
          continue;
        }

        try {
          const gameData = await fetchGameData(gameKey);
          const kifText = swarsToKif(gameData);
          const usiMoves = kifToUsiMoves(kifText);
          const title = formatTitle(gameData);
          const playedAt = parsePlayedAt(gameKey);
          const [result] = await db
            .insert(kifus)
            .values({
              title,
              kifText,
              usiMoves,
              sente: gameData.sente,
              gote: gameData.gote,
              senteDan: gameData.sente_dan,
              goteDan: gameData.gote_dan,
              result: gameData.result,
              swarsGameKey: gameKey,
              playedAt,
            })
            .$returningId();
          imported.push({ id: result.id, gameKey });
        } catch (e) {
          errors.push({ gameKey, error: String(e) });
        }
      }

      return c.json({ imported, skipped, errors });
    },
  );

export type AppType = typeof route;
