import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { zValidator as zv } from '@hono/zod-validator';
import { z } from 'zod';
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { kifus, moveAnalyses, candidateMoves } from './db/schema.js';
import { apiKeyRequired } from './middlewares.js';
import {
  hasValidSession,
  issueSession,
  revokeSession,
  sessionRequired,
  verifyCredentials,
} from './auth.js';
import { swarsToKif, formatTitle, parsePlayedAt } from './swars/csa-to-kif.js';
import { fetchHistoryKeys, fetchGameData } from './swars/fetch.js';
import { getJob, startJob } from './swars/job-store.js';
import { parseKif, type KifTimezone } from './kif/parser.js';

/** 投入時の TZ 指定。'auto' は KIF 署名から自動判定 */
export type SourceTzChoice = 'auto' | KifTimezone;

export const app = new Hono();

const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use('*', logger());
if (corsOrigins.length > 0) {
  app.use('*', cors({ origin: corsOrigins, credentials: true }));
}

interface KifIngestion {
  /** パースエラー・非平手・空のときは null（壊れた部分列を worker に渡さない） */
  usiMoves: string[] | null;
  meta: {
    sente: string | null;
    gote: string | null;
    senteDan: number | null;
    goteDan: number | null;
    result: string | null;
    playedAt: Date | null;
    sourceTz: string;
  };
}

/**
 * KIF テキストを USI 指し手列 + 対局メタへ変換する（投入・再解析で共用）。
 * @param tz 開始日時の解釈 TZ。'auto'（既定）は KIF 署名から自動判定。
 *   投入時にユーザーが選んだ値、再解析では保存済み sourceTz を渡す。
 */
function convertKif(kifText: string, tz: SourceTzChoice = 'auto'): KifIngestion {
  const parsed = parseKif(kifText, tz === 'auto' ? undefined : tz);
  const isHeihei = !parsed.header.handicap || parsed.header.handicap === '平手';
  const usiMoves =
    parsed.errors.length === 0 && isHeihei && parsed.moves.length > 0
      ? parsed.moves.map((m) => m.usi)
      : null;
  return {
    usiMoves,
    meta: {
      sente: parsed.header.sente,
      gote: parsed.header.gote,
      senteDan: parsed.header.senteDan,
      goteDan: parsed.header.goteDan,
      result: parsed.header.result,
      playedAt: parsed.header.playedAt,
      sourceTz: parsed.header.sourceTz,
    },
  };
}

/** タイトル未指定時に対局メタから自動生成する */
function autoTitle(meta: KifIngestion['meta']): string {
  if (meta.sente || meta.gote) {
    return `${meta.sente ?? '?'} vs ${meta.gote ?? '?'}`;
  }
  if (meta.playedAt) {
    return meta.playedAt.toISOString().slice(0, 10);
  }
  return '無題';
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
  // --- 認証 ---
  .get('/auth/me', async (c) => {
    if (!(await hasValidSession(c))) return c.body(null, 401);
    return c.json({ ok: true } as const);
  })
  .post(
    '/auth/login',
    zv('json', z.object({ username: z.string(), password: z.string() })),
    async (c) => {
      const { username, password } = c.req.valid('json');
      if (!verifyCredentials(username, password)) {
        return c.json({ error: 'invalid credentials' } as const, 401);
      }
      await issueSession(c);
      return c.json({ ok: true } as const);
    },
  )
  .post('/auth/logout', async (c) => {
    revokeSession(c);
    return c.json({ ok: true } as const);
  })
  // --- Web 向け（セッション認証） ---
  .get(
    '/kifus',
    sessionRequired,
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
          analysisError: kifus.analysisError,
          hasMemo: sql<boolean>`${kifus.memo} IS NOT NULL`,
        })
        .from(kifus)
        .orderBy(desc(sql`coalesce(${kifus.playedAt}, ${kifus.createdAt})`))
        .limit(limit)
        .offset(offset);

      return c.json({
        kifus: rows.map(({ analyzedAt, analysisError, hasMemo, ...r }) => ({
          ...r,
          analyzed: analyzedAt !== null,
          failed: analysisError !== null,
          hasMemo: Boolean(hasMemo),
        })),
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
    sessionRequired,
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
    sessionRequired,
    zv(
      'json',
      z.object({
        title: z.string().optional(),
        kifText: z.string(),
        // 開始日時の解釈 TZ。省略/auto は KIF 署名から判定（既定 JST）
        sourceTz: z.enum(['auto', 'JST', 'UTC']).optional(),
      }),
    ),
    async (c) => {
      const { title, kifText, sourceTz } = c.req.valid('json');
      const { usiMoves, meta } = convertKif(kifText, sourceTz ?? 'auto');
      const finalTitle = title?.trim() || autoTitle(meta);
      const [result] = await db
        .insert(kifus)
        .values({
          title: finalTitle,
          kifText,
          usiMoves,
          sente: meta.sente,
          gote: meta.gote,
          senteDan: meta.senteDan,
          goteDan: meta.goteDan,
          result: meta.result,
          playedAt: meta.playedAt,
          sourceTz: meta.sourceTz,
        })
        .$returningId();
      return c.json({ id: result.id }, 201);
    },
  )
  .post(
    '/kifus/:id/reanalyze',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const [kifu] = await db
        .select({ kifText: kifus.kifText, sourceTz: kifus.sourceTz })
        .from(kifus)
        .where(eq(kifus.id, id));
      if (!kifu) return c.json({ error: 'not found' }, 404);

      // kifText を再変換（パーサ修正・メタ抽出を既存棋譜へ反映）し、
      // 解析状態をリセットして worker に拾い直させる。title/memo は温存。
      // TZ は投入時のユーザー選択（保存済み sourceTz）を維持する。未設定（旧データ）は
      // 署名から自動判定にフォールバック。
      const tz = (kifu.sourceTz as SourceTzChoice | null) ?? 'auto';
      const { usiMoves, meta } = convertKif(kifu.kifText, tz);
      await db.transaction(async (tx) => {
        // 先に kifus を UPDATE して行ロックを取り、analysisRevision を +1（実行中の旧解析の
        // submit/error 報告は世代不一致で弾かれる）。/worker/analyses も kifus を先ロックするため
        // moveAnalyses との取得順が揃いデッドロックしない。
        await tx
          .update(kifus)
          .set({
            usiMoves,
            sente: meta.sente,
            gote: meta.gote,
            senteDan: meta.senteDan,
            goteDan: meta.goteDan,
            result: meta.result,
            playedAt: meta.playedAt,
            sourceTz: meta.sourceTz,
            analysisError: null,
            analysisCompletedAt: null,
            analysisRevision: sql`${kifus.analysisRevision} + 1`,
          })
          .where(eq(kifus.id, id));
        // 旧解析結果を削除（未解析状態で旧結果が残らないように）。candidateMoves は CASCADE
        await tx.delete(moveAnalyses).where(eq(moveAnalyses.kifuId, id));
      });
      return c.json({ ok: true }, 201);
    },
  )
  .delete(
    '/kifus/:id',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    async (c) => {
      const { id } = c.req.valid('param');
      await db.delete(kifus).where(eq(kifus.id, id));
      return c.json({ ok: true });
    },
  )
  .patch(
    '/kifus/:id',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    zv('json', z.object({ memo: z.string().nullable() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const { memo } = c.req.valid('json');
      const normalized = memo && memo.length > 0 ? memo : null;
      await db.update(kifus).set({ memo: normalized }).where(eq(kifus.id, id));
      return c.json({ ok: true });
    },
  )
  // --- Worker 向け（API_KEY 必須） ---
  .get('/worker/kifus', apiKeyRequired, async (c) => {
    const [kifu] = await db
      .select({
        id: kifus.id,
        title: kifus.title,
        kifText: kifus.kifText,
        usiMoves: kifus.usiMoves,
        analysisRevision: kifus.analysisRevision,
      })
      .from(kifus)
      .where(
        and(
          isNull(kifus.analysisCompletedAt),
          isNull(kifus.analysisError),
          isNotNull(kifus.usiMoves),
        ),
      )
      .orderBy(sql`coalesce(${kifus.playedAt}, ${kifus.createdAt}) asc`)
      .limit(1);
    return c.json(kifu ?? null);
  })
  .post(
    '/worker/kifus/:id/error',
    apiKeyRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    zv('json', z.object({ error: z.string(), revision: z.number() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const { error, revision } = c.req.valid('json');
      // 同一世代 かつ 未完了 のときだけ記録（compare-and-set・単文で原子的）。
      // completed 済みには error を立てない → completedAt と analysisError は排他になる。
      const result = await db
        .update(kifus)
        .set({ analysisError: error })
        .where(
          and(
            eq(kifus.id, id),
            eq(kifus.analysisRevision, revision),
            isNull(kifus.analysisCompletedAt),
          ),
        );
      const applied = result[0].affectedRows > 0;
      return c.json({ ok: true, applied }, 201);
    },
  )
  .post(
    '/worker/analyses',
    apiKeyRequired,
    zv(
      'json',
      z.object({
        kifuId: z.number(),
        revision: z.number(),
        analyses: z.array(
          z.object({
            moveNumber: z.number(),
            candidates: z.array(candidateMoveSchema),
          }),
        ),
      }),
    ),
    async (c) => {
      const { kifuId, revision, analyses } = c.req.valid('json');
      let applied = false;
      await db.transaction(async (tx) => {
        // 取得時と同一世代のときだけ適用（reanalyze 後に届いた旧解析は破棄）。
        // FOR UPDATE で kifus 行をロックし reanalyze と直列化する（確認〜completed 更新の間に
        // 世代が進むのを防ぐ）。reanalyze も kifus を先にロックするためデッドロックしない。
        const [current] = await tx
          .select({
            revision: kifus.analysisRevision,
            error: kifus.analysisError,
          })
          .from(kifus)
          .where(eq(kifus.id, kifuId))
          .for('update');
        // 同一世代 かつ 失敗記録なし のときだけ適用。既に error が立っていれば結果は保存しない
        // → completedAt と analysisError は排他になる（行ロック下で error 報告と直列化）。
        if (!current || current.revision !== revision || current.error !== null)
          return;
        applied = true;

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
      return c.json({ ok: true, applied }, 201);
    },
  )
  // --- swars 棋譜取得 ---
  .post(
    '/swars/import',
    sessionRequired,
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

      const state = startJob(async () => {
        const imported: { id: number; gameKey: string }[] = [];
        const skipped: string[] = [];
        const errors: { gameKey: string; error: string }[] = [];

        const allKeys: string[] = [];
        for (let page = 1; page <= pages; page++) {
          const keys = await fetchHistoryKeys(userId, gtype, page, cookie);
          allKeys.push(...keys);
          if (keys.length === 0) break;
        }

        for (const gameKey of allKeys) {
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
            const { usiMoves } = convertKif(kifText);
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
                sourceTz: 'JST',
              })
              .$returningId();
            imported.push({ id: result.id, gameKey });
          } catch (e) {
            errors.push({ gameKey, error: String(e) });
          }
        }

        return { imported, skipped, errors };
      });

      return c.json(state, 202);
    },
  )
  .get('/swars/import/status', sessionRequired, (c) => {
    return c.json(getJob());
  });

export type AppType = typeof route;
