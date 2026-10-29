/**
 * **全員ぶんを扱う経路**（API_KEY。ユーザーとして動かない）。prd/14 §4「RLS の形」。
 *
 * - worker の報告（`/worker/*`）: 解析すべき棋譜の取得・解析結果・失敗・進捗・評価ジョブ
 * - 動画解析の取り込み（`POST /video-analysis/kifus`）: 所有者専用の手元ツールから（prd/14 §4.1）
 *
 * 🔒 **ログインの経路（`route.ts`）と分けたモジュールに置く。** RLS を迂回する system ロールのプール
 * （`db/system.ts`）を使ってよいのはここ（と動画解析の取り込み・一括処理のエントリ）だけで、
 * `db-import-boundary.test.ts` が import を検査する。リクエスト用のプール（server ロール）とは接続の単位で分ける。
 */
import { Hono } from 'hono';
import { zv } from './zod-validator.js';
import { z } from 'zod';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { systemDb } from './db/system.js';
import { kifus, kifuAnalyses, users } from './db/schema.js';
import { apiKeyRequired } from './middlewares.js';
import { idParam, INT4_MAX } from './params.js';
import { ComposeVerificationError } from './kif/compose.js';
import { formatDiff, importVideoKifu, videoKifuInputSchema } from './video-analysis.js';
import { clearProgress, getClearToken, setProgress } from './analysis-progress.js';
import { isStageComplete } from './analysis-submit.js';
import { recordAnalysisFailure, submitAnalysisChunk } from './analysis-report.js';
import { hasContiguousRanks, runExtras } from './kifu-analysis-detail.js';
import { claimEvaluationJob, completeEvaluationJob } from './position-eval.js';

const candidateMoveSchema = z.object({
  rank: z.number(),
  move: z.string(),
  scoreType: z.enum(['cp', 'mate']),
  scoreValue: z.number(),
  pv: z.array(z.string()).optional(),
  depth: z.number(),
});

/**
 * 🔒 **手元 worker が扱うのは、解析の担当が `worker` のユーザーの棋譜だけ**（prd/14 §5.7）。
 * 取得（poll）と「quick 待ちの棋譜がある」の判定に付ける条件。`users` を join した問い合わせで使う。
 * 絞らないと、`browser` 担当の棋譜を手元 worker が解析し、`browser` 担当の未解析の棋譜が
 * 手元 worker の full を止め続ける。
 * ⚠ 報告（チャンク・失敗・進捗）は取得の後に担当が変わりうるので、受ける側でも今の担当を確かめる
 */
const ownerAssignedToWorker = eq(users.analysisAssignee, 'worker');
/** 棋譜とその所有者（担当を読むための join の条件） */
const kifuOwner = eq(users.id, kifus.ownerId);

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
        // 往復検証に落ちた棋譜は保存しない（prd/10 §4.2）。422 にするのは**合成・検証の失敗だけ**。
        // それ以外（DB の失敗など）は投げ直して 500 にする（内部のエラー文を応答に載せない）
        if (!(e instanceof ComposeVerificationError)) throw e;
        console.warn(`[VideoAnalysis] 取り込み中止 ${tag}: ${e.message}`);
        return c.json({ error: e.message }, 422);
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
  // 🔒 **解析の担当が `worker` のユーザーの棋譜だけ**（prd/14 §5.7）。
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
      const [pendingQuick] = await systemDb()
        .select(selection)
        .from(kifus)
        .innerJoin(users, kifuOwner)
        .where(
          and(
            ownerAssignedToWorker,
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
        : await systemDb()
            .select(selection)
            .from(kifus)
            .innerJoin(users, kifuOwner)
            .where(
              and(
                ownerAssignedToWorker,
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
      const [counts] = await systemDb()
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
    zv('param', idParam),
    zv('json', z.object({ error: z.string(), revision: z.number().int() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const { error, revision } = c.req.valid('json');
      // 同一世代 かつ **full が未完了** かつ 所有者の今の担当が `worker` のときだけ記録する
      // （棋譜の行ロックの下で。条件の理由は `recordAnalysisFailure`）。
      // ⚠ 記録しなかったときも 201（`applied: false`）。4xx にすると worker が恒久失敗として扱う
      const result = await systemDb().transaction((tx) =>
        recordAnalysisFailure(tx, { id }, { revision, error, assignee: 'worker', stage: 'full' }),
      );
      const applied = result?.applied ?? false;
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
        kifuId: z.number().int().positive().max(INT4_MAX),
        revision: z.number().int(),
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
      const [kifu] = await systemDb()
        .select({
          revision: kifus.analysisRevision,
          completedAt: kifus.analysisCompletedAt,
          analysisProfile: kifus.analysisProfile,
          error: kifus.analysisError,
          // 進捗の読み取りを棋譜の所有者に限るために持たせる（prd/14 §4.2）
          ownerId: kifus.ownerId,
          // web へは番号で返す（prd/14 §4.4。内部 ID を出さない）
          kifuNo: kifus.displayNo,
          // 担当が `worker` でなくなった棋譜の進捗は出さない（prd/14 §5.7 規則 2）
          assignee: users.analysisAssignee,
        })
        .from(kifus)
        .innerJoin(users, kifuOwner)
        .where(eq(kifus.id, kifuId));
      // 🔴 完了は**報告された段階**で読む（prd/05 §1.1b）。`analysisCompletedAt` は quick 完了で
      // 立つため、段階と無関係に見ると **full の進捗が最初から全部拒否される**。
      // quick 完了後の full 進捗は受理し、full 完了後の報告だけ拒否する
      const valid =
        kifu !== undefined &&
        kifu.revision === revision &&
        kifu.error === null &&
        kifu.assignee === 'worker' &&
        !isStageComplete(kifu, profile);
      const applied =
        valid &&
        setProgress(
          { kifuId, kifuNo: kifu.kifuNo, ownerId: kifu.ownerId, revision, profile, analyzed, total },
          token,
        );
      return c.json({ ok: true, applied });
    },
  )
  .post(
    '/worker/analyses',
    apiKeyRequired,
    zv(
      'json',
      z.object({
        kifuId: z.number().int().positive().max(INT4_MAX),
        revision: z.number().int(),
        /** 実行した段階（`GET /api/worker/kifus` で指示されたもの。prd/05 §1.1d） */
        profile: z.enum(['quick', 'full']),
        // 来歴（prd/03 §3）。**記録するだけ**で、上書き・再開の条件には使わない
        engineName: z.string().max(255).nullish(),
        movetimeMs: z.number().int().positive().nullish(),
        targetDepth: z.number().int().positive().nullish(),
        multiPv: z.number().int().positive().nullish(),
        // 来歴の任意の項目（prd/14 §5.9・prd/16 §3.1）。**古い worker は送らない**（その run は項目なしで保存する）
        runtime: z.enum(['native', 'wasm']).nullish(),
        engineBuild: z.string().max(128).nullish(),
        evalHash: z.string().max(128).nullish(),
        fvScale: z.number().int().positive().nullish(),
        threads: z.number().int().positive().nullish(),
        hashMb: z.number().int().positive().nullish(),
        book: z.boolean().nullish(),
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
        ...extras
      } = c.req.valid('json');
      // 🔴 候補手の rank は局面ごとに 1..n の連番であること（prd/16 §4.1）。保存形は rank を
      // 配列の位置から戻すので、欠番のまま受けると黙って書き換わる。DB を読む前に弾く
      if (!analyses.every((a) => hasContiguousRanks(a.candidates))) {
        return c.json({ error: 'candidate ranks not contiguous' } as const, 400);
      }
      // 書き込みの本体はブラウザ解析の受け口と共用（`analysis-report.ts`。prd/14 §5.8）。
      // 世代の照合・完了の確定・`fullCount` の規則を 2 本に分けない
      const outcome = await systemDb().transaction((tx) =>
        submitAnalysisChunk(tx, { id: kifuId }, {
          revision,
          // 🔒 所有者の今の担当が `worker` の棋譜だけを受ける（prd/14 §5.7 規則 2）
          assignee: 'worker',
          run: {
            profile,
            engineName: engineName ?? null,
            movetimeMs: movetimeMs ?? null,
            targetDepth: targetDepth ?? null,
            multiPv: multiPv ?? null,
            ...runExtras(extras),
          },
          analyses,
        }),
      );
      if (outcome.status === 'out-of-range') {
        return c.json({ error: 'moveNumber out of range' } as const, 400);
      }
      if (outcome.status === 'not-contiguous') {
        return c.json({ error: 'moveNumber not contiguous' } as const, 400);
      }
      // ⚠ 破棄（古い世代・担当違い・棋譜が無い）は 201 `applied: false`。**4xx にしない**
      // ——手元 worker は 4xx を恒久失敗として記録する（担当の切り替えのたびに失敗が残ってしまう）
      const applied = outcome.status === 'applied';
      const completed = outcome.status === 'applied' && outcome.completed;
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
    // ⚠ **DB の問い合わせを先に、claim は最後に**。claim の後に DB が落ちると、取り出したジョブが
    // 誰にも渡らないまま宙に浮く（結果もエラーも出ず、待つ側は期限切れまで待たされる）
    const [pending] = await systemDb()
      .select({ id: kifus.id })
      .from(kifus)
      .innerJoin(users, kifuOwner)
      .where(
        and(
          // 担当が `worker` のユーザーの棋譜だけ（`browser` 担当の未解析の棋譜で full を止めない）
          ownerAssignedToWorker,
          isNull(kifus.analysisCompletedAt),
          isNull(kifus.analysisError),
          isNotNull(kifus.usiMoves),
        ),
      )
      .limit(1);
    const job = claimEvaluationJob();
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
