/**
 * 出題（prd/13）: 次の 1 問・在庫・一覧・名指しの 1 問・解答履歴・除外・諦め・解答。
 *
 * 🔴 **答えを含む列は出題時に返さない**（prd/13 §7）。問題は棋譜の番号・手数・種類の組で指す（prd/14 §4.4）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { drillNamedEvaluationSchema } from 'shared';
import { zv } from '../zod-validator.js';
import { apiError, NOT_FOUND } from '../api-error.js';
import { sessionRequired } from '../auth.js';
import { analysisAssigneeOf } from '../analysis-report.js';
import { isGiveUpLine } from '../drill-answer.js';
import { drillReveal, gradeAnswer } from '../drill-answer-flow.js';
import { forgetLine, recallLine } from '../drill-lines.js';
import { resolveWithEngine } from '../drill-engine.js';
import {
  drillCounts,
  listDrillAttemptsOf,
  listDrills,
  loadDrill,
  loadDrillQuestion,
  pickNextDrill,
  recordAttempt,
  unexcludeDrill,
} from '../drill-query.js';
import { drillListQuerySchema, drillNextQuerySchema } from '../drill-list-query.js';
import { drillRefParam, smallBody } from './common.js';

export const drillRoutes = new Hono()
  // 🔴 **答えを含む列は返さない**（`answerMove` / `candidates` / `playedMove`）。
  // 渡した時点で答えが見えているのと同じで、専用ページにした意味が消える（prd/13 §7）。
  // 棋譜名・対局者も伏せる——解答後に `POST /drills/:kifuNo/:moveNumber/:kind/answer` が返す。
  // ⚠ 問題を指す組（棋譜の番号・手数・種類。prd/14 §4.4）は返す——URL に載せて同じ問題へ戻るため
  // 入口（`mode`）ごとに選ぶ（prd/13 §6.4）。`since`（この回の開始時刻）以降に記録した問題は選ばない（§7.6）。
  // 在庫が尽きたら `drill: null`。`now` は server の時刻で、web はこの回の最初の値を `since` に使う
  .get('/drills/next', sessionRequired, zv('query', drillNextQuerySchema), async (c) => {
    const now = new Date().toISOString();
    const drill = await pickNextDrill(c.get('tx'), c.get('userId'), c.req.valid('query'));
    return c.json({ drill, now });
  })
  // ホームの数（入口ごとの在庫。prd/13 §7.5）。🔒 正答率は返さない（§10）
  .get('/drills/counts', sessionRequired, async (c) =>
    c.json(await drillCounts(c.get('tx'), c.get('userId'))),
  )
  // 問題の一覧（prd/13 §7.7）。🔴 **答えを含む列は返さない**（`/drills/next` と同じ規則）
  .get('/drills', sessionRequired, zv('query', drillListQuerySchema), async (c) =>
    c.json(await listDrills(c.get('tx'), c.get('userId'), c.req.valid('query'))),
  )
  // 一覧から名指しで開いた 1 問（prd/13 §5.4）。返す形は `/drills/next` と同じ。
  // 問題は（棋譜の番号・手数・種類）で指す（prd/14 §4.4）
  .get(
    '/drills/:kifuNo/:moveNumber/:kind',
    sessionRequired,
    zv('param', drillRefParam),
    async (c) => {
      const ref = c.req.valid('param');
      const now = new Date().toISOString();
      const drill = await loadDrillQuestion(c.get('tx'), c.get('userId'), ref);
      if (!drill) return apiError(c, 404, 'not_found', NOT_FOUND.drill);
      // `now` も `/drills/next` と同じく載せる。名指しで開いた問題（保存した URL・一覧から）から回が始まっても、
      // 最初の解答より前に回の開始時刻が決まるように（レビュー `OCL-BB10F0BB`。prd/13 §7.6）
      return c.json({ drill, now });
    },
  )
  // その問題の解答履歴（prd/13 §7.7）。web は解いた後にだけ呼ぶ（正解の記録の手は答えそのもの）。
  // 全体の解答履歴の口（`/drills/attempts`）は 2026-10-23 に外した
  .get(
    '/drills/:kifuNo/:moveNumber/:kind/attempts',
    sessionRequired,
    zv('param', drillRefParam),
    async (c) => {
      const ref = c.req.valid('param');
      const drill = await loadDrill(c.get('tx'), c.get('userId'), ref);
      if (!drill) return apiError(c, 404, 'not_found', NOT_FOUND.drill);
      return c.json(await listDrillAttemptsOf(c.get('tx'), c.get('userId'), ref));
    },
  )
  // 「自明だった」の取り消し（prd/13 §7.7）。除外の行そのものを消すので解答履歴は残る
  .post(
    '/drills/:kifuNo/:moveNumber/:kind/unexclude',
    sessionRequired,
    zv('param', drillRefParam),
    async (c) => {
      const drill = await loadDrill(c.get('tx'), c.get('userId'), c.req.valid('param'));
      if (!drill) return apiError(c, 404, 'not_found', NOT_FOUND.drill);
      await unexcludeDrill(c.get('tx'), c.get('userId'), drill.id);
      return c.json({ ok: true } as const);
    },
  )
  // 「自明だった」で以後の出題から外す（prd/13 §7）。
  // 🔒 印は**履歴側**に置く——出題を作り直しても残るようにするため（prd/13 §6.2）
  .post(
    '/drills/:kifuNo/:moveNumber/:kind/exclude',
    sessionRequired,
    zv('param', drillRefParam),
    async (c) => {
      const drill = await loadDrill(c.get('tx'), c.get('userId'), c.req.valid('param'));
      if (!drill) return apiError(c, 404, 'not_found', NOT_FOUND.drill);
      // 以下の `id` は出題の行の ID（内部の値。記録と手順の記憶に使い、応答には載せない）
      const { id } = drill;
      await recordAttempt(c.get('tx'), {
        drillId: id,
        ownerId: drill.ownerId,
        move: null,
        verdict: null,
        lossCp: null,
        excluded: true,
      });
      // 手順の記憶（メモリ）はコミットの後に忘れる（記録が戻ったときに記憶だけ消えないように）
      c.get('afterCommit')(() => forgetLine(id));
      return c.json({ ok: true } as const);
    },
  )
  // 「諦めて答えを見る」（prd/13 §5.3・2026-10-19 決定）。**不正解として記録する**
  // （`verdict: 'wrong'`・`move: null`・`line` はそこまで確定した手順）。応答は解答の口の `done` と同じ形。
  // `line` は確定済みの手順（最後は受方の応手か空）。`best` は空のみ、`mate` は受け付ける正解手順
  // （元の pv・覚えた別解）のどれかの先頭と一致すること。違えば 400。
  // `practice: true`（解答後のやり直し）は記録しない
  .post(
    '/drills/:kifuNo/:moveNumber/:kind/give-up',
    smallBody,
    sessionRequired,
    zv('param', drillRefParam),
    zv(
      'json',
      z.object({
        line: z.array(z.string().min(2).max(8)).max(64),
        practice: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const { line, practice } = c.req.valid('json');
      const drill = await loadDrill(c.get('tx'), c.get('userId'), c.req.valid('param'));
      if (!drill) return apiError(c, 404, 'not_found', NOT_FOUND.drill);
      const { id } = drill;
      if (!isGiveUpLine(drill.kind, line, [recallLine(id), drill.answerPv])) {
        return apiError(c, 400, 'bad_request', '手順が出題と噛み合いません');
      }
      if (!practice) {
        await recordAttempt(c.get('tx'), {
          drillId: id,
          ownerId: drill.ownerId,
          move: null,
          line,
          verdict: 'wrong',
          lossCp: null,
        });
      }
      // 手順の記憶（メモリ）はコミットの後に忘れる（記録が戻ったときに記憶だけ消えないように）
      c.get('afterCommit')(() => forgetLine(id));
      return c.json({
        status: 'done' as const,
        verdict: 'wrong' as const,
        lossCp: null,
        gaveUp: true as const,
        ...drillReveal(drill, line),
      });
    },
  )
  // 解答（prd/13 §5）。**採点は server が持つ**——候補手と正解手をクライアントへ
  // 先に渡さないための置き場所でもある（上記 `/drills/next`）。
  // `line` は**出題局面からの全手順**（受方の応手を含み、最後がユーザーの手）。
  // `best` は 1 手、`mate` は詰み上がりまで積み上がる（prd/13 §5.2）。
  // 詰将棋で間違えた手（王手でない・詰まない）は `miss` を返し、利用者はその手を取り消して続ける（答えは載せない）。
  // `practice: true` は記録しない（最初の間違い・答えを見た後の操作。web が画面の状態で付ける）
  //
  // 候補手の外の手（詰将棋で正解手順を外れた手）は名指し評価で採点する。次の一手は読む場所が解析の担当（prd/14 §5.7）で決まる:
  // 担当 `worker` は手元 worker にジョブを積み（`pending`）、担当 `browser` は「この局面のこの手を名指しで読んで」
  // （`evaluate`）を返す。ブラウザは読んだ結果を `evaluation` に付けて同じ解答を送り直し、判定は server が行う。
  // 詰将棋は担当によらず `evaluate`（詰将棋の判定の読み方。prd/13 §5.5）。ブラウザが読めないと `browserUnavailable` で
  // 申告してきたら、担当 `worker` だけ手元 worker に回す
  // 🔒 ブラウザから届く評価は信用できない入力なので、Origin の検査・本文の上限・形の検証（`shared` の
  // `drillNamedEvaluationSchema`）を掛け、評価の手が解答の手と一致することも確かめる（prd/14 §5.8）
  .post(
    '/drills/:kifuNo/:moveNumber/:kind/answer',
    smallBody,
    sessionRequired,
    zv('param', drillRefParam),
    zv(
      'json',
      z.object({
        line: z.array(z.string().min(2).max(8)).min(1).max(64),
        // 採点の線引きは**閲覧者の設定**（prd/13 §5.1）。届かなければ既定
        correctMargin: z.number().int().min(0).max(10000).optional(),
        closeMargin: z.number().int().min(0).max(10000).optional(),
        // ブラウザの名指し評価（`evaluate` を受けたブラウザが付けて送り直す。prd/13 §5.3）
        evaluation: drillNamedEvaluationSchema.optional(),
        // 「この端末では読めない」の申告（詰将棋。担当 worker なら手元 worker で判定する。prd/13 §5.5）
        browserUnavailable: z.boolean().optional(),
        // 練習（解答後の「最初からやり直す」）。判定は返すが記録しない（prd/13 §5.3）
        practice: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const tx = c.get('tx');
      const userId = c.get('userId');
      const afterCommit = c.get('afterCommit');
      const drill = await loadDrill(tx, userId, c.req.valid('param'));
      if (!drill) return apiError(c, 404, 'not_found', NOT_FOUND.drill);
      // 流れの本体は `drill-answer-flow.ts`。DB・手順の記憶・エンジンはここで渡す
      const graded = await gradeAnswer(drill, c.req.valid('json'), {
        recallLine,
        forgetLine,
        afterCommit,
        recordAttempt: (attempt) => recordAttempt(tx, attempt),
        analysisAssignee: () => analysisAssigneeOf(tx, userId),
        resolveWithEngine: (input) => resolveWithEngine({ ...input, tx, userId, afterCommit }),
      });
      return c.json(graded.body, graded.status);
    },
  );
