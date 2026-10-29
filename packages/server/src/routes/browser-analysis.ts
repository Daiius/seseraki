/**
 * ブラウザ解析の受け口（prd/14 §5.8）。担当が `browser` のユーザーのブラウザが、自分の棋譜を解析して報告する。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  browserAnalysisChunkSchema,
  browserAnalysisErrorSchema,
  browserAnalysisStartSchema,
} from 'shared';
import { zv } from '../zod-validator.js';
import { sessionRequired } from '../auth.js';
import {
  browserClaimedProfile,
  pendingBrowserKifuNos,
  recordAnalysisFailure,
  startBrowserAnalysis,
  submitAnalysisChunk,
} from '../analysis-report.js';
import { kifuNoParam, smallBody } from './common.js';

export const browserAnalysisRoutes = new Hono()
  // --- ブラウザ解析の受け口（prd/14 §5.8）---
  // 担当が `browser` のユーザーのブラウザが、自分の棋譜を解析して報告する。手元 worker の
  // 取得・チャンクの報告・失敗の報告（`worker-routes.ts`）に対応する 3 つで、書き込みの本体は共用
  // （`analysis-report.ts`）。🔒 RLS の下の tx で書き、棋譜は番号で指す（他人の番号は 404）。
  //
  // 開始: 世代・段（quick → full）・その段の再開位置・指し手列・その段の設定を返す。進行中の段の解析が
  // 別のエンジン（ビルド・評価関数）のものなら、ここで行を消して世代を進める（prd/14 §5.9）。
  // `complete` は full の完了で返す。担当が `browser` でなければ 409
  .post(
    '/kifus/:no/analysis/start',
    smallBody,
    sessionRequired,
    zv('param', kifuNoParam),
    zv('json', browserAnalysisStartSchema),
    async (c) => {
      const { no } = c.req.valid('param');
      const started = await startBrowserAnalysis(c.get('tx'), c.get('userId'), no, c.req.valid('json'));
      if (started === null) return c.json({ error: 'not found' } as const, 404);
      if (started.status === 'wrong-assignee') {
        return c.json({ error: '解析の担当がブラウザではありません' } as const, 409);
      }
      return c.json(started);
    },
  )
  // チャンクの報告。実行環境（wasm）・MultiPV（1）・定跡（なし）は **server が固定する**。
  // 🔒 **段（quick / full）は server が棋譜の状態から決める**（prd/14 §5.8。本文の `profile` は任意の申告で、
  // 状態と違えば破棄）。破棄（古い世代・担当違い・段違い・完了済み・別のエンジン）は 201 `applied: false`
  // ——ブラウザは開始からやり直す。
  // 応答の `completed` は **full まで揃ったか**（解析全体の完了）。quick の完了では false を返し、
  // ブラウザは開始からやり直して full を受け取る（1 段のままの web も quick → full と続けて回る）。
  // 届いた段の完了は `stageCompleted`、受けた段は `profile`
  .post(
    '/kifus/:no/analysis/chunks',
    smallBody,
    sessionRequired,
    zv('param', kifuNoParam),
    zv('json', browserAnalysisChunkSchema),
    async (c) => {
      const { no } = c.req.valid('param');
      const { revision, profile, analyses, engineName, movetimeMs, engineBuild, evalHash, fvScale, threads, hashMb } =
        c.req.valid('json');
      const outcome = await submitAnalysisChunk(c.get('tx'), { ownerId: c.get('userId'), no }, {
        revision,
        assignee: 'browser',
        run: {
          profile: 'by-state',
          engineName: engineName ?? null,
          movetimeMs,
          targetDepth: null,
          multiPv: 1,
          runtime: 'wasm',
          engineBuild,
          evalHash,
          fvScale,
          threads,
          hashMb,
          book: false,
        },
        // 段の申告は再送しても変わらない値から（本文の `profile`、無ければ `movetimeMs`）。状態と違えば破棄
        claimedProfile: browserClaimedProfile({ profile, movetimeMs }),
        // 開始の口を通さずに別のエンジンの結果を重ねさせない（同じ段の行とだけ照合する。prd/14 §5.9）
        sameEngine: { engineBuild, evalHash },
        analyses,
      });
      switch (outcome.status) {
        case 'not-found':
          return c.json({ error: 'not found' } as const, 404);
        case 'out-of-range':
          return c.json({ error: 'moveNumber out of range' } as const, 400);
        case 'not-contiguous':
          return c.json({ error: 'moveNumber not contiguous' } as const, 400);
        case 'ignored':
          return c.json(
            { ok: true, applied: false, completed: false, stageCompleted: false, profile: null } as const,
            201,
          );
        case 'applied':
          return c.json(
            {
              ok: true,
              applied: true,
              completed: outcome.fullCompleted,
              stageCompleted: outcome.completed,
              profile: outcome.profile,
            } as const,
            201,
          );
      }
    },
  )
  // 失敗の報告（`analysisError`。prd/05 §1.1a）。進行中の段の失敗として、同じ世代で full が未完了のときだけ記録する
  // （手元 worker と同じ）
  .post(
    '/kifus/:no/analysis/error',
    smallBody,
    sessionRequired,
    zv('param', kifuNoParam),
    zv('json', browserAnalysisErrorSchema),
    async (c) => {
      const { no } = c.req.valid('param');
      const { revision, error } = c.req.valid('json');
      const result = await recordAnalysisFailure(c.get('tx'), { ownerId: c.get('userId'), no }, {
        revision,
        error,
        assignee: 'browser',
        stage: 'full',
      });
      if (result === null) return c.json({ error: 'not found' } as const, 404);
      return c.json({ ok: true, applied: result.applied } as const, 201);
    },
  )
  // バックグラウンド解析（prd/14 §5.10「使用中は常に」）が次に解析する棋譜の番号。
  // full まで完了していない棋譜で、quick が未完了のものが先・その中はそれぞれ新しい順。担当が `browser` でなければ空
  .get(
    '/analysis/pending',
    sessionRequired,
    zv('query', z.object({ limit: z.coerce.number<number>().int().min(1).max(50).default(20) })),
    async (c) =>
      c.json({
        kifuNos: await pendingBrowserKifuNos(c.get('tx'), c.get('userId'), c.req.valid('query').limit),
      }),
  );
