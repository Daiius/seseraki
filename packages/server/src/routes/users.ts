/**
 * ログイン中の自分（`/me`）と「自分」の設定（`/users/me*`。表示名・解析の担当・名前候補。prd/11・prd/14 §5.7）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zv } from '../zod-validator.js';
import { apiError, NOT_FOUND } from '../api-error.js';
import { sessionRequired } from '../auth.js';
import { isUniqueViolation } from '../db/errors.js';
import { clearProgressForOwner } from '../analysis-progress.js';
import { analysisAssigneeOf, canChooseWorker, switchAnalysisAssignee } from '../analysis-report.js';
import { idParam } from '../params.js';
import {
  addAlias,
  rebuildSubjectSides,
  removeAlias,
  selfProfile,
  updateAliasPeriod,
  updateDisplayName,
} from '../users.js';
import { dateString, periodRefine, smallBody } from './common.js';

const aliasCreateSchema = periodRefine(
  z.object({
    name: z.string().trim().min(1).max(100),
    validFrom: dateString.nullish(),
    validTo: dateString.nullish(),
  }),
);

const aliasPeriodSchema = periodRefine(
  z.object({
    validFrom: dateString.nullable(),
    validTo: dateString.nullable(),
  }),
);

export const userRoutes = new Hono()
  // ログイン中の自分（prd/07 §5.3）。未ログインは 401・所有者以外は 403（所有者ゲート。§5.1）。
  // web のルートガードがこれを叩く。⚠ /auth/* の外に置く（/auth/* は Better Auth が丸ごと受ける）。
  // 解析の担当（prd/14 §5.7）も返す——web は「解析が終わったか」の判定と、ブラウザ解析を回すかをこれで決める。
  // `canChooseWorker` は担当に `worker` を選べるか（所有者だけ）
  .get('/me', sessionRequired, async (c) => {
    const userId = c.get('userId');
    const analysisAssignee = await analysisAssigneeOf(c.get('tx'), userId);
    // セッションはあるのにユーザーの行が無い（消された直後）。未ログインと同じに扱う
    if (analysisAssignee === null) return c.body(null, 401);
    return c.json({ userId, analysisAssignee, canChooseWorker: canChooseWorker(userId) });
  })
  // --- 自分（prd/11）---
  // 🔒 名前候補を変えたら、**同じトランザクションで主体側を引き直す**（prd/11 §4.2）。
  // 手動の再導出に頼ると、変えた直後に画面の数字が古いまま残り、
  // しかも間違っていることが画面から分からない。
  // 応答の `rederived` は主体側が変わった棋譜の数（`rebuildSubjectSides`）。
  .get('/users/me', sessionRequired, async (c) =>
    c.json(await selfProfile(c.get('tx'), c.get('userId'))),
  )
  .patch(
    '/users/me',
    sessionRequired,
    zv('json', z.object({ displayName: z.string().trim().min(1).max(100) })),
    async (c) => {
      await updateDisplayName(c.get('tx'), c.get('userId'), c.req.valid('json').displayName);
      return c.json({ ok: true } as const);
    },
  )
  // 解析の担当の切り替え（prd/14 §5.7）。🔒 `worker` を選べるのは所有者だけ（他は 403）。
  // 同じ tx で、そのユーザーの未完了の棋譜の世代を進める（途中の解析は消す。`switchAnalysisAssignee`）。
  // 同じ値を送っても何も起きない（`changed: false`）
  .put(
    '/users/me/analysis-assignee',
    smallBody,
    sessionRequired,
    zv('json', z.object({ assignee: z.enum(['worker', 'browser']) })),
    async (c) => {
      const userId = c.get('userId');
      const result = await switchAnalysisAssignee(c.get('tx'), userId, c.req.valid('json').assignee);
      if (result.status === 'forbidden') {
        return apiError(c, 403, 'forbidden', 'この担当は選べません');
      }
      if (result.status === 'not-found') return apiError(c, 404, 'not_found', NOT_FOUND.user);
      const changed = result.status === 'switched';
      // 切り替え前の解析の進捗を落とす（**コミットの後**。以降に届く旧世代の報告は世代と担当の照合で弾かれる）
      if (changed) c.get('afterCommit')(() => clearProgressForOwner(userId));
      return c.json({ ok: true, analysisAssignee: result.assignee, changed } as const);
    },
  )
  .post(
    '/users/me/aliases',
    sessionRequired,
    zv('json', aliasCreateSchema),
    async (c) => {
      const { name, validFrom, validTo } = c.req.valid('json');
      const userId = c.get('userId');
      try {
        // ⚠ savepoint（入れ子のトランザクション）で囲む。一意制約違反でリクエストの tx 全体が
        // 中断状態にならないように（409 を返した後にコミットできるように）
        const updated = await c.get('tx').transaction(async (tx) => {
          await addAlias(tx, userId, name, { validFrom, validTo });
          return rebuildSubjectSides(tx, userId);
        });
        return c.json({ ok: true, rederived: updated } as const, 201);
      } catch (e) {
        // `(userId, name)` は UNIQUE（大文字小文字を区別する。prd/11 §2.1・prd/14 §4.1）
        if (isUniqueViolation(e)) {
          return apiError(c, 409, 'conflict', 'この名前は既に登録されている');
        }
        throw e;
      }
    },
  )
  .patch(
    '/users/me/aliases/:id',
    sessionRequired,
    zv('param', idParam),
    zv('json', aliasPeriodSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const { validFrom, validTo } = c.req.valid('json');
      const tx = c.get('tx');
      const userId = c.get('userId');
      // 🔒 本人の名前候補だけ（prd/14 §4）。他人のもの・無いものは 404
      if (!(await updateAliasPeriod(tx, userId, id, { validFrom, validTo }))) {
        return apiError(c, 404, 'not_found', NOT_FOUND.alias);
      }
      const updated = await rebuildSubjectSides(tx, userId);
      return c.json({ ok: true, rederived: updated } as const);
    },
  )
  .delete(
    '/users/me/aliases/:id',
    sessionRequired,
    zv('param', idParam),
    async (c) => {
      // ⚠ **旧名を消すと、その名前で指した過去の棋譜が「自分の対局」でなくなる**
      // （prd/11 §2.2）。画面側で警告してから呼ぶ
      const { id } = c.req.valid('param');
      const tx = c.get('tx');
      const userId = c.get('userId');
      // 🔒 本人の名前候補だけ（prd/14 §4）。他人のもの・無いものは 404
      if (!(await removeAlias(tx, userId, id))) {
        return apiError(c, 404, 'not_found', NOT_FOUND.alias);
      }
      const updated = await rebuildSubjectSides(tx, userId);
      return c.json({ ok: true, rederived: updated } as const);
    },
  );
