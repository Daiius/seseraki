/**
 * 局面検索（prd/10 §5）と検討局面の評価（prd/12 §2）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { parseSfen, positionSfen, validateMoveOnPosition, validatePositionForEngine } from 'shared';
import { zv } from '../zod-validator.js';
import { apiError, NOT_FOUND } from '../api-error.js';
import { sessionRequired, sessionUser } from '../auth.js';
import { analysisAssigneeOf } from '../analysis-report.js';
import { EvaluationQueueFullError, getEvaluationResult, startEvaluation } from '../position-eval.js';
import { lookupKifuEvaluation } from '../position-kifu-reuse.js';
import { parsePositionKey } from '../positions.js';
import {
  findPositionGames,
  findSimilarPositions,
  findSubjectGames,
  INITIAL_SFEN,
} from '../position-queries.js';
import { OWNER_USER_ID } from '../users.js';

export const positionRoutes = new Hono()
  // --- 局面検索（prd/10 §5.3）---
  // 🔒 **ここには `ownGamesOnly` を掛けない。** 一覧・集計は「自分の成績」なので動画解析を
  // 外すが、局面検索は**自分の対局と動画解析を横断して探す**のが目的そのもの（prd/10 §5.3）。
  // 結果には `source` を添えて、どちらの出所かを画面で区別できるようにする。
  // 🔒 **所有者の棋譜だけを探す**（prd/14 §4・§6.3）
  .get(
    '/positions',
    sessionRequired,
    zv('query', z.object({ pos: z.string().max(200).optional() })),
    async (c) => {
      // 🔒 **読み直して書き戻した SFEN で引く**（prd/14 §6.3）。索引はハッシュで引いて
      // 盤・持ち駒・手番で照合するので、照合に使うバイト列も同じ局面から作る。
      // 読めない SFEN はどの棋譜も通っていないので 404（文字列で引いていた頃と同じ）
      const key = parsePositionKey(c.req.valid('query').pos ?? INITIAL_SFEN);
      if (!key) return apiError(c, 404, 'not_found', NOT_FOUND.position);
      const found = await findPositionGames(c.get('tx'), c.get('userId'), key);
      if (!found) return apiError(c, 404, 'not_found', NOT_FOUND.position);
      return c.json(found);
    },
  )
  // 主体側モード（prd/10 §3.3）。**自分の駒の配置**が同じ棋譜を、先後をまたいで探す。
  // 読み出す行数に上限がある（当たったら `truncated`。prd/14 §6.3）
  .get(
    '/positions/subject',
    sessionRequired,
    zv(
      'query',
      z.object({
        pos: z.string().min(1).max(200),
        /** 基準局面を**どちら側から見るか** */
        side: z.enum(['sente', 'gote']),
      }),
    ),
    async (c) => {
      const { pos, side } = c.req.valid('query');
      const key = parsePositionKey(pos);
      if (!key) return apiError(c, 404, 'not_found', NOT_FOUND.position);
      const found = await findSubjectGames(c.get('tx'), c.get('userId'), key, side);
      if (!found) return apiError(c, 404, 'not_found', NOT_FOUND.position);
      return c.json(found);
    },
  )
  // 近い局面（prd/10 §5.2）。完全一致は `/positions` が返すので、ここは**別枠**。
  // 🔒 **所有者（サイトの持ち主）だけ**（prd/14 §6.3）。手数帯の全局面を読み出して盤を比べる処理で
  // server のメインスレッドを使い、局数が多いほど打ち切りで結果も不正確になる
  .get(
    '/positions/similar',
    sessionRequired,
    zv(
      'query',
      z.object({
        pos: z.string().min(1).max(200),
        /** 手数帯の幅（基準の手数 ± これ）。粗い絞り込みで、読み出す行数を決める */
        window: z.coerce.number<number>().int().min(0).max(20).default(4),
        limit: z.coerce.number<number>().int().min(1).max(50).default(20),
      }),
    ),
    async (c) => {
      const userId = c.get('userId');
      if (userId !== OWNER_USER_ID) {
        return apiError(c, 403, 'forbidden', 'この機能は使えません');
      }
      const { pos, window, limit } = c.req.valid('query');
      const key = parsePositionKey(pos);
      if (!key) return apiError(c, 404, 'not_found', NOT_FOUND.position);
      const found = await findSimilarPositions(c.get('tx'), userId, key, { window, limit });
      if (!found) return apiError(c, 404, 'not_found', NOT_FOUND.position);
      return c.json(found);
    },
  )
  // 検討局面の評価（prd/12 §2）。**受け付けて即座に返す**（決定 2026-08-29）。
  // キャッシュ・棋譜解析から引ければその場で結果まで返り（1 往復）、エンジンに回すときは
  // `status: 'pending'` と `jobId` を返す。要求側は GET /positions/evaluate/:jobId で取りに来る。
  // 🔴 long-poll をやめたのは、前段にタイムアウトを持つ層があり、その期限が server の期限より
  //    ずっと短いため。**成功しているのに失敗して見える**事故が本番で起きた（prd/12 §2.4）。
  //    ⚠ リクエストの tx の中で待たないことにもなる（接続を握ったまま待たない。prd/14 §4）
  // `move` を付けると名指し評価（`go searchmoves`。その手のスコアと咎め筋）になる。
  // 🔒 評価は**手番側から見た値**（検討モードでは自分。prd/12 §2.3）。
  .post(
    '/positions/evaluate',
    sessionRequired,
    zv(
      'json',
      z.object({
        /** 局面キーと同じ 3 フィールドの SFEN。手数付き（4 フィールド）も受ける */
        sfen: z.string().min(1).max(200),
        /** 名指し評価の対象手（USI）。省略すれば局面評価 */
        move: z.string().min(2).max(8).nullish(),
      }),
    ),
    async (c) => {
      const { sfen, move = null } = c.req.valid('json');

      // エンジンに渡す前に検証する（prd/12 §2.5）。合法性は問わないが、
      // エンジンをクラッシュ・ハングさせうる局面は 4xx で弾く
      const state = parseSfen(sfen);
      if (!state) {
        return apiError(c, 400, 'bad_request', 'SFEN を読めません', { violations: [] });
      }
      const position = validatePositionForEngine(state);
      if (!position.ok) {
        return apiError(c, 400, 'bad_request', 'エンジンに渡せない局面です', {
          violations: position.violations,
        });
      }
      if (move !== null) {
        const moveCheck = validateMoveOnPosition(state, move);
        if (!moveCheck.ok) {
          return apiError(c, 400, 'bad_request', 'エンジンに渡せない指し手です', {
            violations: moveCheck.violations,
          });
        }
      }

      // キャッシュ・ジョブのキーは**読み直して書き戻した SFEN**にする。
      // 手数の有無や書き方の揺れで同じ局面が別扱いになるのを防ぐ（prd/12 §2.4）
      const normalized = positionSfen(state);
      const userId = c.get('userId');

      // 🔒 **解析の担当が `worker` のユーザーだけ**（prd/14 §5.7・prd/12 §2.4）。この口は手元 worker に
      // ジョブを積むので、絞らないとログインした誰もが所有者の worker を使える。
      // ⚠ 棋譜解析からの再利用（下）より前に断る——担当 `browser` の検討盤はブラウザで評価する設計で、
      // 一部の局面だけ答えが返る口にしない。出題の解答の評価（`drill-engine.ts`）も担当 `worker` だけが
      // 手元 worker にジョブを積み、担当 `browser` はブラウザが名指しで読む（prd/14 §5.7・prd/13 §5.3）
      if ((await analysisAssigneeOf(c.get('tx'), userId)) !== 'worker') {
        return apiError(c, 403, 'forbidden', 'この機能は使えません');
      }

      // 🔴 **エンジンにジョブを積む前に、既存の棋譜解析から引く**（prd/12 §2.6）。
      // 検討の起点は閲覧中の棋譜の局面なので、数手動かすまでは解析済みの局面を
      // なぞっているだけのことが多い。⚠ 局面の検証（上）はこの判定より**前**のまま
      // 保つ——エンジンに渡さないとしても、壊れた局面を受け付けてよいことにはならない。
      // ⚠ **`source` で出所を隠さない**（解析時のエンジン設定は今と違いうる）。
      // 🔴 **要求者の棋譜からだけ引く**（prd/14 §4。利用者をまたいで解析結果を流さない）
      const reused = await lookupKifuEvaluation(c.get('tx'), userId, {
        sfen: normalized,
        move,
      });
      if (reused) {
        // `reused` が `source: 'kifu'` を持つ（出所の付与は position-kifu-reuse.ts の責務）
        return c.json({ sfen: normalized, move, ...reused });
      }

      try {
        // 🔒 ジョブは要求者のもの（結果の取得は要求者だけ。prd/14 §4.2）
        const started = startEvaluation({ sfen: normalized, move }, userId);
        if (started.state === 'settled') {
          return c.json({
            sfen: normalized,
            move,
            source: 'engine' as const,
            ...started.outcome,
          });
        }
        // ⚠ 202 は「受け付けた・結果はまだ」。要求側はこの `jobId` で取りに来る
        return c.json(
          {
            sfen: normalized,
            move,
            status: 'pending' as const,
            jobId: started.jobId,
          },
          202,
        );
      } catch (err) {
        if (err instanceof EvaluationQueueFullError) {
          // worker が止まっている疑い。積み上げずにその場で断る
          return apiError(c, 503, 'unavailable', '評価キューが一杯です');
        }
        throw err;
      }
    },
  )
  // 評価結果の取得（prd/12 §2.4）。**ポーリングされる前提の軽い口**。
  // 🔒 `pending`（まだ出ていない）と 404（もう取れない）を混ぜない。404 は TTL 切れか
  //    server の再起動で、要求側は**同じ body を投げ直す**（キャッシュにあれば即答）。
  // 🔒 **要求者でなければ 404**（存在を明かさない。prd/14 §4.2）。メモリだけを見るので
  //    DB のトランザクションは開かない（`sessionUser`）
  .get(
    '/positions/evaluate/:jobId',
    sessionUser,
    zv('param', z.object({ jobId: z.string().min(1).max(64) })),
    (c) => {
      const { jobId } = c.req.valid('param');
      const poll = getEvaluationResult(jobId, c.get('userId'));
      if (poll.state === 'unknown') {
        return apiError(c, 404, 'not_found', NOT_FOUND.evaluationJob);
      }
      if (poll.state === 'pending') {
        return c.json({ status: 'pending' as const, jobId });
      }
      return c.json({ jobId, source: 'engine' as const, ...poll.outcome });
    },
  );
