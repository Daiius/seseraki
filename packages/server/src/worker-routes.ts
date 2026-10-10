/**
 * **全員ぶんを扱う経路**（API_KEY。ユーザーとして動かない）。prd/14 §4「RLS の形」。
 *
 * - worker の報告（`/worker/*`）: 解析すべき棋譜の取得・解析結果・失敗・進捗・評価ジョブ
 * - 動画解析の取り込み（`POST /video-analysis/kifus`）: 所有者専用の手元ツールから（prd/14 §4.1）
 *
 * 🔒 **ログインの経路（`route.ts`）と分けたモジュールに置く。** グローバルの `db` を使ってよいのは
 * ここ（と一括処理のエントリ）だけで、`db-import-boundary.test.ts` が import を検査する。
 * 2b（RLS）で、ここは BYPASSRLS のロールの別プールに移す（リクエスト用のプールと接続の単位で分ける）。
 */
import { Hono } from 'hono';
import { zValidator as zv } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { kifus, kifuAnalyses } from './db/schema.js';
import { apiKeyRequired } from './middlewares.js';
import { formatDiff, importVideoKifu, videoKifuInputSchema } from './video-analysis.js';
import { clearProgress, getClearToken, setProgress } from './analysis-progress.js';
import {
  isAnalysisComplete,
  isChunkAcceptable,
  isChunkInRange,
  isStageComplete,
  nextKifuProfile,
} from './analysis-submit.js';
import { hasContiguousRanks, mergeChunk } from './kifu-analysis-detail.js';
import { loadAnalysis, saveAnalysis } from './kifu-analysis-store.js';
import { claimEvaluationJob, completeEvaluationJob } from './position-eval.js';
import { drillConfigFromEnv, syncDrills } from './drills.js';

const candidateMoveSchema = z.object({
  rank: z.number(),
  move: z.string(),
  scoreType: z.enum(['cp', 'mate']),
  scoreValue: z.number(),
  pv: z.array(z.string()).optional(),
  depth: z.number(),
});

export const workerRoutes = new Hono()
  // 復元側（実験パッケージ）から叩く。session ではなく API_KEY で通す：
  // 呼ぶのはブラウザではなく CLI で、worker と同じ立場にある
  .post(
    '/video-analysis/kifus',
    apiKeyRequired,
    zv('json', videoKifuInputSchema),
    async (c) => {
      const input = c.req.valid('json');
      const tag = `${input.videoId}#${input.gameIndex}`;
      let result: Awaited<ReturnType<typeof importVideoKifu>>;
      try {
        result = await importVideoKifu(input);
      } catch (e) {
        // 往復検証に落ちた棋譜は保存しない（prd/10 §4.2）
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`[VideoAnalysis] 取り込み中止 ${tag}: ${reason}`);
        return c.json({ error: reason }, 422);
      }
      if (result.created) {
        console.log(
          `[VideoAnalysis] 新規 ${tag} kifu=${result.kifuId} ${input.usi.length} 手`,
        );
      } else if (result.changed) {
        // 🔒 上書きで何が変わったかは、ここでしか残らない（prd/10 §4.3）
        console.log(
          `[VideoAnalysis] 上書き ${tag} kifu=${result.kifuId} 差分 ${result.diff.length} 件: ${formatDiff(result.diff)}`,
        );
        // 解析をやり直させたので、旧解析の進捗表示を落とす（reanalyze と同じ）
        clearProgress(result.kifuId);
      } else {
        console.log(`[VideoAnalysis] 変化なし ${tag} kifu=${result.kifuId}`);
      }
      return c.json(result, result.created ? 201 : 200);
    },
  )
  // --- Worker 向け（API_KEY 必須） ---
  // 解析すべき棋譜を 1 件返す（2 段階解析。prd/05 §1.1d）。
  // 優先順位は **quick 未完 → quick 完了・full 未完**で、いずれも
  // `coalesce(playedAt, createdAt)` 昇順の最古 1 件（失敗棋譜は除外）。
  //
  // worker は**自分が quick の設定を持つか**を `?quick=1` で伝える。持たない worker には
  // quick 未完の棋譜を `full` として渡す（後方互換。`ENGINE_QUICK_*` 未設定なら 1 段階のまま）。
  .get(
    '/worker/kifus',
    apiKeyRequired,
    zv(
      'query',
      z.object({
        // クエリはそのまま `?quick=1` と読める形にしておく（ヘッダだと RPC の型に出ない）
        quick: z
          .enum(['0', '1'])
          .default('0')
          .transform((v) => v === '1'),
      }),
    ),
    async (c) => {
      const { quick: quickCapable } = c.req.valid('query');
      const selection = {
        id: kifus.id,
        title: kifus.title,
        kifText: kifus.kifText,
        usiMoves: kifus.usiMoves,
        analysisRevision: kifus.analysisRevision,
      };
      const oldestFirst = sql`coalesce(${kifus.playedAt}, ${kifus.createdAt}) asc`;

      // (1) quick 未完（まだ 1 度も全局面が揃っていない）
      const [pendingQuick] = await db
        .select(selection)
        .from(kifus)
        .where(
          and(
            isNull(kifus.analysisCompletedAt),
            isNull(kifus.analysisError),
            isNotNull(kifus.usiMoves),
          ),
        )
        .orderBy(oldestFirst)
        .limit(1);

      // (2) quick 完了・full 未完
      const [pendingFull] = pendingQuick
        ? []
        : await db
            .select(selection)
            .from(kifus)
            .where(
              and(
                eq(kifus.analysisProfile, 'quick'),
                isNull(kifus.analysisError),
                isNotNull(kifus.usiMoves),
              ),
            )
            .orderBy(oldestFirst)
            .limit(1);

      const kifu = pendingQuick ?? pendingFull;
      if (!kifu) return c.json(null);
      // quick を持たない worker には (1) も full として渡す（1 段階運用）
      // ⚠ 型注釈は**リテラル union をそのまま書く**（`AnalysisProfile` の別名を使うと、
      // Hono RPC の応答型が worker 側から名前で参照できず TS2742 になる）
      const profile: 'quick' | 'full' =
        pendingQuick && quickCapable ? 'quick' : 'full';

      // 既に入っている局面数を返し、worker はその続き（moveNumber = analyzedCount）から解析する
      // （チャンク submit の中断からの再開。prd/05 §1.1c）。チャンク submit の失敗は解析ごと中断する
      // ため moveNumber に穴が空かず、**件数がそのまま再開位置**になる。
      // ⚠ **段階ごとに数える**（prd/05 §1.1d）: quick は `detail` の長さ、full は `fullCount`
      // （full は 0 から順に上書きするので、常に先頭からの連続区間になる。prd/16 §4.2）
      const [counts] = await db
        .select({
          quick: sql<number>`jsonb_array_length(${kifuAnalyses.detail})`.mapWith(Number),
          full: kifuAnalyses.fullCount,
        })
        .from(kifuAnalyses)
        .where(eq(kifuAnalyses.kifuId, kifu.id));
      const analyzedCount = counts ? counts[profile] : 0;
      return c.json({ ...kifu, analyzedCount, profile });
    },
  )
  .post(
    '/worker/kifus/:id/error',
    apiKeyRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    zv('json', z.object({ error: z.string(), revision: z.number() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const { error, revision } = c.req.valid('json');
      // 同一世代 かつ **進行中だった段階が未完了** のときだけ記録（compare-and-set・単文で原子的）。
      //
      // 🔴 **`analysisCompletedAt IS NULL` では読まない**（改定・2026-09-05。prd/03 §2）。
      // それは quick 完了で立つので、条件に使うと **quick 完了後の full の失敗を記録できない**
      // （失敗した棋譜が永久に poll され続ける）。代わりに「最も高い段階＝full がまだ完了していない」
      // ことを見る——失敗しうるのは進行中の段階だけで、full 完了済みの棋譜はそもそも poll に出ない。
      // 帰結として **`analysisCompletedAt` と `analysisError` の排他は緩む**（quick 完了 + full 失敗で
      // 両方が非 null）。UI は quick の結果を見せたまま「詳細解析に失敗」を示す（prd/05 §2.5）。
      const result = await db
        .update(kifus)
        .set({ analysisError: error })
        .where(
          and(
            eq(kifus.id, id),
            eq(kifus.analysisRevision, revision),
            or(
              isNull(kifus.analysisProfile),
              ne(kifus.analysisProfile, 'full'),
            ),
          ),
        );
      const applied = (result.rowCount ?? 0) > 0;
      if (applied) clearProgress(id);
      return c.json({ ok: true, applied }, 201);
    },
  )
  .post(
    '/worker/analyses/progress',
    apiKeyRequired,
    zv(
      'json',
      z.object({
        kifuId: z.number(),
        revision: z.number(),
        profile: z.enum(['quick', 'full']),
        analyzed: z.number().min(0),
        total: z.number().min(1),
      }),
    ),
    async (c) => {
      const { kifuId, revision, profile, analyzed, total } = c.req.valid('json');
      // 進捗は表示専用でメモリにしか残らないため、トランザクションも行ロックも張らない。
      // ただし submit / error 報告と同じ世代照合はする（reanalyze 後に届いた旧解析の進捗を出さない）。
      // 完了・失敗済みも弾く＝ submit と進捗報告が前後しても「終わったのに解析中」が残らない。
      //
      // ⚠ DB を読む `await` の間に submit / error / reanalyze / 削除が完了しうる。その場合は
      // 古い判定のまま書き込むと「終わったのに解析中」が復活するため、読む前に clear トークンを
      // 取り、記録時に一致を確かめる（compare-and-set。`analysis-progress.ts`）。
      const token = getClearToken();
      const [kifu] = await db
        .select({
          revision: kifus.analysisRevision,
          completedAt: kifus.analysisCompletedAt,
          analysisProfile: kifus.analysisProfile,
          error: kifus.analysisError,
          // 進捗の読み取りを棋譜の所有者に限るために持たせる（prd/14 §4.2）
          ownerId: kifus.ownerId,
        })
        .from(kifus)
        .where(eq(kifus.id, kifuId));
      // 🔴 完了は**報告された段階**で読む（prd/05 §1.1b）。`analysisCompletedAt` は quick 完了で
      // 立つため、段階と無関係に見ると **full の進捗が最初から全部拒否される**。
      // quick 完了後の full 進捗は受理し、full 完了後の報告だけ拒否する
      const valid =
        kifu !== undefined &&
        kifu.revision === revision &&
        kifu.error === null &&
        !isStageComplete(kifu, profile);
      const applied =
        valid &&
        setProgress({ kifuId, ownerId: kifu.ownerId, revision, profile, analyzed, total }, token);
      return c.json({ ok: true, applied });
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
        /** 実行した段階（`GET /api/worker/kifus` で指示されたもの。prd/05 §1.1d） */
        profile: z.enum(['quick', 'full']),
        // 来歴（prd/03 §3）。**記録するだけ**で、上書き・再開の条件には使わない
        engineName: z.string().max(255).nullish(),
        movetimeMs: z.number().int().positive().nullish(),
        targetDepth: z.number().int().positive().nullish(),
        multiPv: z.number().int().positive().nullish(),
        analyses: z.array(
          z.object({
            // 上限（棋譜の手数）は usiMoves を読んでからでないと判定できないのでハンドラ内で見る
            moveNumber: z.number().int().min(0),
            candidates: z.array(candidateMoveSchema),
          }),
        ),
      }),
    ),
    async (c) => {
      const {
        kifuId,
        revision,
        profile,
        engineName,
        movetimeMs,
        targetDepth,
        multiPv,
        analyses,
      } = c.req.valid('json');
      // 🔴 候補手の rank は局面ごとに 1..n の連番であること（prd/16 §4.1）。保存形は rank を
      // 配列の位置から戻すので、欠番のまま受けると黙って書き換わる。DB を読む前に弾く
      if (!analyses.every((a) => hasContiguousRanks(a.candidates))) {
        return c.json({ error: 'candidate ranks not contiguous' } as const, 400);
      }
      let applied = false;
      let completed = false;
      // 棋譜の手数を超える moveNumber が入ると、必要な局面が欠けたまま件数だけが達して
      // 完了扱いになりうる（完了すると poll 対象から外れ、自動再開でも直らない）
      let outOfRange = false;
      // 局面が連続していない・受理条件の先頭を越えた（prd/16 §4.2）
      let notContiguous = false;
      await db.transaction(async (tx) => {
        // 取得時と同一世代のときだけ適用（reanalyze 後に届いた旧解析のチャンクは破棄）。
        // FOR UPDATE で kifus 行をロックし reanalyze と直列化する（確認〜completed 更新の間に
        // 世代が進むのを防ぐ）。reanalyze も kifus を先にロックするためデッドロックしない。
        const [current] = await tx
          .select({
            revision: kifus.analysisRevision,
            error: kifus.analysisError,
            completedAt: kifus.analysisCompletedAt,
            analysisProfile: kifus.analysisProfile,
            usiMoves: kifus.usiMoves,
            ownerId: kifus.ownerId,
            // 今回の run の時刻（prd/16 §3.1）。トランザクションの時刻なので 1 回の submit の中で揃う。
            // ⚠ `sql` 断片の日時はオフセット付きの文字列で返る（列の変換を通らない）
            now: sql<string>`now()`.mapWith((v: string) => new Date(v).toISOString()),
          })
          .from(kifus)
          .where(eq(kifus.id, kifuId))
          .for('update');
        // 同一世代 かつ 失敗記録なし かつ **その段階が未完了** のときだけ適用。既に error が
        // 立っていれば結果は保存しない（行ロック下で error 報告と直列化する）。
        // 完了済みも弾く＝完了後の解析結果は不変（遅れて届いたチャンクで部分的に上書きされない）。
        // ⚠ **完了の判定は段階ごと**（prd/05 §1.1d）——full 完了済みへのチャンクは破棄し、
        // quick 完了済みの棋譜への full チャンクは受理する。`analysisCompletedAt` と
        // `analysisError` の排他は**意図して緩めた**（quick 完了 + full 失敗で両方が非 null）
        if (!isChunkAcceptable(current, revision, profile)) return;
        // 有効範囲（0..usiMoves.length）を保証してはじめて「件数 = 揃った局面数」が成り立つ
        // （UNIQUE(kifuId, moveNumber) が値の重複を防ぐため）。範囲外は書かずに 400 で返す
        if (!isChunkInRange(analyses, current.usiMoves)) {
          outOfRange = true;
          return;
        }
        // チャンクは**重ねる**（DELETE しない）。前世代の全消去は `reanalyze` の DELETE が
        // 唯一の経路になる（prd/03 §3・prd/16 §4.3）。重なり・段階の後退防止・full の連続性は
        // `mergeChunk` が決める（prd/16 §4）
        const stored = await loadAnalysis(tx, kifuId, { forUpdate: true });
        const merged = mergeChunk(stored, analyses, {
          profile,
          engineName: engineName ?? null,
          movetimeMs: movetimeMs ?? null,
          targetDepth: targetDepth ?? null,
          multiPv: multiPv ?? null,
          at: current.now,
        });
        if (!merged.ok) {
          notContiguous = true;
          return;
        }
        applied = true;
        if (merged.wrote) await saveAnalysis(tx, { id: kifuId, ownerId: current.ownerId }, merged.next);

        // 完了は **server が局面数で判定**する（worker の申告に依らない。prd/05 §1.1c）。
        // ⚠ **段階ごとに数える**（prd/05 §1.1d）: quick = `detail` の長さ / full = `fullCount`
        const quickDone = isAnalysisComplete(merged.next.detail.length, current.usiMoves);
        const fullDone = isAnalysisComplete(merged.next.fullCount, current.usiMoves);
        // 進捗表示を落とすのは**報告された段階**が終わったとき（full 進行中に quick の
        // 完了で落とすと、まだ動いている解析の表示が消える）
        completed = profile === 'full' ? fullDone : quickDone;
        const profileAfter = nextKifuProfile(current.analysisProfile, {
          quick: quickDone,
          full: fullDone,
        });
        // 🔴 **full が揃った時点で出題を生成する**（prd/13 §8）。quick では作らない
        // ——出題の答えが探索の浅さで揺れると問題として成立しない（prd/13 §2）。
        // upsert なので、既に解いた問題の履歴は再生成でも消えない（prd/13 §6.1）
        if (fullDone) await syncDrills(tx, kifuId, drillConfigFromEnv());
        if (profileAfter !== current.analysisProfile) {
          await tx
            .update(kifus)
            .set({
              analysisProfile: profileAfter,
              // `analysisCompletedAt` は「**初めて**全局面が揃った時刻」（prd/05 §1.1d）。
              // 既に立っていれば触らない（full 完了で上書きしない）
              ...(current.completedAt === null && (quickDone || fullDone)
                ? { analysisCompletedAt: new Date() }
                : {}),
            })
            .where(eq(kifus.id, kifuId));
        }
      });
      if (outOfRange) {
        return c.json({ error: 'moveNumber out of range' } as const, 400);
      }
      if (notContiguous) {
        return c.json({ error: 'moveNumber not contiguous' } as const, 400);
      }
      // 完了したときだけ「解析中」を落とす。途中のチャンクで落とすと、進捗表示が次の報告まで
      // 消えてしまう（旧世代の破棄されたチャンクでも触らない）
      if (completed) clearProgress(kifuId);
      return c.json({ ok: true, applied, completed }, 201);
    },
  )
  // 検討局面の評価ジョブ（prd/12 §2.1）。worker は棋譜解析の**局面境界**でここを叩き、
  // 待っているジョブがあれば先に処理する。無ければ null（inbound の口は増やさない）
  // 🔴 応答に「**quick 待ちの棋譜がある**」印を相乗りさせる（prd/05 §1.1d / prd/12 §2.1）。
  // worker は局面境界でここを既に叩いているので、**full の解析を中断して quick を先に処理する**
  // 判断を**通信を増やさずに**下せる。判定は軽い EXISTS 1 本（`analysisCompletedAt` に INDEX）
  .get('/worker/position-jobs', apiKeyRequired, async (c) => {
    const job = claimEvaluationJob();
    const [pending] = await db
      .select({ id: kifus.id })
      .from(kifus)
      .where(
        and(
          isNull(kifus.analysisCompletedAt),
          isNull(kifus.analysisError),
          isNotNull(kifus.usiMoves),
        ),
      )
      .limit(1);
    return c.json({ job, quickPending: pending !== undefined });
  })
  // 評価結果の報告。**失敗も完了**として扱う（結果もエラーも出ないまま宙に浮かせない。
  // prd/12 §2.4）。報告された結果は jobId で取りに来られるよう保持される。
  // 🔒 ここは棋譜の `analysisError` / `analysisRevision` に触れない——interactive な
  // ジョブには対応する棋譜も世代も無い（prd/12 §2.5）
  .post(
    '/worker/position-jobs/:id/result',
    apiKeyRequired,
    zv('param', z.object({ id: z.string() })),
    zv(
      'json',
      z.union([
        z.object({
          candidates: z.array(candidateMoveSchema),
          /** 名指し評価を符号反転のフォールバックで求めたか（prd/12 §2.2） */
          fallback: z.boolean().default(false),
        }),
        z.object({ error: z.string().min(1).max(500) }),
      ]),
    ),
    (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const applied = completeEvaluationJob(
        id,
        'error' in body
          ? { error: body.error }
          : {
              candidates: body.candidates.map((candidate) => ({
                ...candidate,
                pv: candidate.pv ?? [],
              })),
              fallback: body.fallback,
            },
      );
      // applied=false は期限切れで既に落ちたジョブ（worker 側は次へ進んでよい）
      return c.json({ ok: true, applied } as const, 201);
    },
  );
