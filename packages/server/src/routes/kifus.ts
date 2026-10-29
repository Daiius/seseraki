/**
 * 棋譜（一覧・詳細・取り込み・メモ・再解析・削除）と戦型別成績（prd/04・prd/05・prd/09）、解析の進捗。
 *
 * 🔒 棋譜はパスでも応答でも番号（`kifus.displayNo`）で扱う（prd/14 §4.4）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zv } from '../zod-validator.js';
import { apiError, NOT_FOUND } from '../api-error.js';
import { sessionRequired, sessionUser } from '../auth.js';
import { clearProgress, getProgressFor } from '../analysis-progress.js';
import { kifuListQuerySchema } from '../kifu-list-query.js';
import { statsTacticsQuerySchema } from '../stats-tactics-query.js';
import { KIF_TEXT_MAX, KIFU_MEMO_MAX, KIFU_TITLE_MAX } from '../kifu-input.js';
import {
  createKifu,
  deleteKifu,
  getKifuDetail,
  listKifus,
  reanalyzeKifu,
  statsTactics,
  updateKifuMemo,
} from '../kifu-queries.js';
import { kifuCreateBody, kifuNoParam, smallBody } from './common.js';

export const kifuRoutes = new Hono()
  .get('/kifus', sessionRequired, zv('query', kifuListQuerySchema), async (c) =>
    c.json(await listKifus(c.get('tx'), c.get('userId'), c.req.valid('query'))),
  )
  .get(
    '/kifus/:no',
    sessionRequired,
    zv('param', kifuNoParam),
    async (c) => {
      const { no } = c.req.valid('param');
      const kifu = await getKifuDetail(c.get('tx'), c.get('userId'), no);
      if (!kifu) return apiError(c, 404, 'not_found', NOT_FOUND.kifu);
      return c.json(kifu);
    },
  )
  // 戦型別成績（prd/09）。**生ラベルで数える平坦な行**を返し、階層（`IMPLIES`）は web で組む
  .get('/stats/tactics', sessionRequired, zv('query', statsTacticsQuerySchema), async (c) =>
    c.json(await statsTactics(c.get('tx'), c.get('userId'), c.req.valid('query'))),
  )
  .post(
    '/kifus',
    kifuCreateBody,
    sessionRequired,
    zv(
      'json',
      z.object({
        title: z.string().max(KIFU_TITLE_MAX).optional(),
        kifText: z.string().max(KIF_TEXT_MAX),
        // 開始日時の解釈 TZ。省略/auto は KIF 署名から判定（既定 JST）
        sourceTz: z.enum(['auto', 'JST', 'UTC']).optional(),
      }),
    ),
    async (c) => {
      // 🔒 所有者はセッションのユーザー（本文から取らない）。返すのは番号（prd/14 §4.4）
      const { displayNo } = await createKifu(c.get('tx'), c.get('userId'), c.req.valid('json'));
      return c.json({ no: displayNo }, 201);
    },
  )
  .post(
    '/kifus/:no/reanalyze',
    sessionRequired,
    zv('param', kifuNoParam),
    async (c) => {
      const { no } = c.req.valid('param');
      const id = await reanalyzeKifu(c.get('tx'), c.get('userId'), no);
      if (id === null) {
        return apiError(c, 404, 'not_found', NOT_FOUND.kifu);
      }
      // 旧解析の進捗を落とす（**コミットの後**。以降に届く旧世代の報告は世代照合で弾かれる）
      c.get('afterCommit')(() => clearProgress(id));
      return c.json({ ok: true }, 201);
    },
  )
  .delete(
    '/kifus/:no',
    sessionRequired,
    zv('param', kifuNoParam),
    async (c) => {
      const { no } = c.req.valid('param');
      const id = await deleteKifu(c.get('tx'), c.get('userId'), no);
      if (id === null) {
        return apiError(c, 404, 'not_found', NOT_FOUND.kifu);
      }
      // 消えた棋譜の「解析中」が残らないように（行が無くなるので以降の報告も弾かれる）
      c.get('afterCommit')(() => clearProgress(id));
      return c.json({ ok: true });
    },
  )
  // 解析中の棋譜の進捗（メモリ参照のみ・DB を触らない）。解析中は高々 1 件なので、
  // 一覧も詳細もこれ 1 つを見て自分の id と一致したら表示する。
  // 🔒 **解析中の棋譜の所有者にだけ見せる**（prd/14 §4.2）。他人には null
  .get('/analysis/progress', sessionUser, (c) => c.json(getProgressFor(c.get('userId'))))
  .patch(
    '/kifus/:no',
    smallBody,
    sessionRequired,
    zv('param', kifuNoParam),
    zv('json', z.object({ memo: z.string().max(KIFU_MEMO_MAX).nullable() })),
    async (c) => {
      const { no } = c.req.valid('param');
      const { memo } = c.req.valid('json');
      if (!(await updateKifuMemo(c.get('tx'), c.get('userId'), no, memo))) {
        return apiError(c, 404, 'not_found', NOT_FOUND.kifu);
      }
      return c.json({ ok: true });
    },
  );
