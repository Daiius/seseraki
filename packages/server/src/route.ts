/**
 * API のルート（Hono RPC。`AppType` が web / worker の型の出所）。
 *
 * 🔒 **ログインの経路（`sessionRequired`）は、ユーザーとして開いたトランザクション（`c.get('tx')`）だけを使う**
 * （prd/14 §4「RLS の形」）。グローバルの `db` を import しない（`db-import-boundary.test.ts` が検査する）。
 * 棋譜系の表に触れる処理は、所有者（`c.get('userId')`。🔒 セッションから取る）と tx を引数に取るクエリ関数
 * （`kifu-queries.ts` / `position-queries.ts` / `drill-query.ts` / `users.ts` など）に置く。
 * 他人の棋譜・問題・名前候補・評価ジョブは 404（存在を明かさない）。
 *
 * 全員ぶんを扱う経路（worker の報告・動画解析の取り込み。API_KEY）は `worker-routes.ts`。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { zValidator as zv } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { isUniqueViolation } from './db/errors.js';
import { users, userAliases } from './db/schema.js';
import { kifuListQuerySchema } from './kifu-list-query.js';
import { statsTacticsQuerySchema } from './stats-tactics-query.js';
import { auth, sessionRequired, sessionUser, settings as authSettings } from './auth.js';
import { devLoginRoutes } from './dev-login.js';
import { getProgressFor, clearProgress } from './analysis-progress.js';
import {
  EvaluationQueueFullError,
  getEvaluationResult,
  startEvaluation,
} from './position-eval.js';
import { lookupKifuEvaluation } from './position-kifu-reuse.js';
import {
  applyMove,
  buildPositions,
  parseSfen,
  positionSfen,
  validateMoveOnPosition,
  validatePositionForEngine,
  type BoardState,
} from 'shared';
import { parsePositionKey } from './positions.js';
import {
  DEFAULT_SCORING,
  isPrefixOf,
  isReachableMove,
  mateStep,
  scoreFromCandidates,
  type DrillScoring,
} from './drill-answer.js';
import { forgetLine, recallLine } from './drill-lines.js';
import { resolveWithEngine, type ResolveInput } from './drill-engine.js';
import {
  drillCounts,
  listDrillAttempts,
  listDrills,
  loadDrill,
  loadDrillQuestion,
  pickNextDrill,
  recordAttempt,
  unexcludeDrill,
} from './drill-query.js';
import { drillAttemptQuerySchema, drillListQuerySchema } from './drill-list-query.js';
import {
  addAlias,
  countUnresolvedSubjects,
  OWNER_USER_ID,
  rebuildSubjectSides,
  removeAlias,
  updateAliasPeriod,
} from './users.js';
import {
  createKifu,
  deleteKifu,
  getKifuDetail,
  listKifus,
  listVideoKifus,
  reanalyzeKifu,
  statsTactics,
  updateKifuMemo,
} from './kifu-queries.js';
import {
  findPositionGames,
  findSimilarPositions,
  findSubjectGames,
  INITIAL_SFEN,
} from './position-queries.js';
import { workerRoutes } from './worker-routes.js';

export type { SourceTzChoice } from './kifu-queries.js';

/** `YYYY-MM-DD` の日付。名前候補の有効期間（prd/11 §5） */
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * 有効期間は**組として**成り立っていないといけない。
 *
 * 🔴 **逆転した期間（開始 > 終了）を保存すると、その候補は日時のある全棋譜で不活性になり、
 * 同じトランザクションの再導出で `subjectSide` が NULL に落ちる**——成績からも
 * 自分視点の表示からも**静かに脱落する**。個々の値が日付として正しいだけでは足りない。
 */
const periodRefine = <T extends { validFrom?: string | null; validTo?: string | null }>(
  schema: z.ZodType<T>,
) =>
  schema.refine((v) => !v.validFrom || !v.validTo || v.validFrom <= v.validTo, {
    message: '期間が逆転している（validTo は validFrom 以降）',
    path: ['validTo'],
  });

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

export const app = new Hono().basePath('/api');

const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use('*', logger());
if (corsOrigins.length > 0) {
  app.use('*', cors({ origin: corsOrigins, credentials: true }));
}

// 人のログイン（Better Auth。prd/07 §2.1）。サインイン・コールバック・サインアウト・セッション取得を
// 丸ごと受ける。⚠ **アプリの API を /auth/* の下に置かない**（このハンドラが先に受ける）
app.on(['POST', 'GET'], '/auth/*', (c) => auth.handler(c.req.raw));

// 🔒 dev ログインの抜け道は **NODE_ENV=development のときだけ登録する**（prd/07 §6）。
// それ以外ではルート自体が無く 404（auth-routes.test.ts で固定）。RPC の型にも載せない
if (authSettings.isDev) {
  app.route('/dev', devLoginRoutes(auth));
}

/** 出題局面（`moveNumber` 手を指す直前の局面）。指し手列が足りなければ null */
function drillPosition(usiMoves: string[] | null, moveNumber: number): BoardState | null {
  if (!usiMoves || moveNumber > usiMoves.length) return null;
  return buildPositions(usiMoves)[moveNumber] ?? null;
}

/** 出題局面に手順を積む。読めない手が混ざったら null（数字を捏造しない） */
function applyLine(base: BoardState, moves: string[]): BoardState | null {
  let state = base;
  for (const move of moves) {
    try {
      state = applyMove(state, move);
    } catch {
      return null;
    }
  }
  return state;
}

/** エンジンの採点結果を HTTP へ写す。**待ちは 202、キュー満杯は 503**（prd/12 §2.4 と同じ流儀） */
async function answerWithEngine(input: ResolveInput, reveal: Record<string, unknown>) {
  const answer = await resolveWithEngine(input);
  switch (answer.status) {
    case 'pending':
      return { body: { status: 'pending' as const, jobId: answer.jobId }, status: 202 as const };
    case 'busy':
      return { body: { error: '評価キューが一杯です' }, status: 503 as const };
    case 'failed':
      return { body: { error: answer.error }, status: 502 as const };
    case 'continue':
      return { body: { status: 'continue' as const, reply: answer.reply }, status: 200 as const };
    case 'done':
      return { body: { ...answer, ...reveal }, status: 200 as const };
  }
}
const route = app
  // --- 認証 ---
  // ログイン中の自分（prd/07 §5.3）。未ログインは 401・所有者以外は 403（所有者ゲート。§5.1）。
  // web のルートガードがこれを叩く。⚠ /auth/* の外に置く（/auth/* は Better Auth が丸ごと受ける）。
  // 表に触れないのでトランザクションを開かない（`sessionUser`）
  .get('/me', sessionUser, (c) => c.json({ userId: c.get('userId') }))
  // --- Web 向け（セッション認証 + ユーザーとして開いたトランザクション） ---
  .get('/kifus', sessionRequired, zv('query', kifuListQuerySchema), async (c) =>
    c.json(await listKifus(c.get('tx'), c.get('userId'), c.req.valid('query'))),
  )
  .get(
    '/kifus/:id',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const kifu = await getKifuDetail(c.get('tx'), c.get('userId'), id);
      if (!kifu) return c.json({ error: 'not found' }, 404);
      return c.json(kifu);
    },
  )
  // 戦型別成績（prd/09）。**生ラベルで数える平坦な行**を返し、階層（`IMPLIES`）は web で組む
  .get('/stats/tactics', sessionRequired, zv('query', statsTacticsQuerySchema), async (c) =>
    c.json(await statsTactics(c.get('tx'), c.get('userId'), c.req.valid('query'))),
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
      // 🔒 所有者はセッションのユーザー（本文から取らない）
      const id = await createKifu(c.get('tx'), c.get('userId'), c.req.valid('json'));
      return c.json({ id }, 201);
    },
  )
  // --- 自分（prd/11）---
  // 🔒 名前候補を変えたら、**同じトランザクションで主体側を引き直す**（prd/11 §4.2）。
  // 手動の再導出に頼ると、変えた直後に画面の数字が古いまま残り、
  // しかも間違っていることが画面から分からない。
  .get('/users/me', sessionRequired, async (c) => {
    const tx = c.get('tx');
    const userId = c.get('userId');
    const [user] = await tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    const aliases = await tx
      .select({
        id: userAliases.id,
        name: userAliases.name,
        validFrom: userAliases.validFrom,
        validTo: userAliases.validTo,
      })
      .from(userAliases)
      .where(eq(userAliases.userId, userId))
      .orderBy(asc(userAliases.id));
    return c.json({
      ...user,
      aliases,
      /** 主体側が決まらない棋譜の数（名前候補の設定を促すために出す） */
      unresolvedSubjects: await countUnresolvedSubjects(tx, userId),
    });
  })
  .patch(
    '/users/me',
    sessionRequired,
    zv('json', z.object({ displayName: z.string().trim().min(1).max(100) })),
    async (c) => {
      const { displayName } = c.req.valid('json');
      await c
        .get('tx')
        .update(users)
        .set({ displayName })
        .where(eq(users.id, c.get('userId')));
      return c.json({ ok: true } as const);
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
          return c.json({ error: 'この名前は既に登録されている' } as const, 409);
        }
        throw e;
      }
    },
  )
  .patch(
    '/users/me/aliases/:id',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    zv('json', aliasPeriodSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const { validFrom, validTo } = c.req.valid('json');
      const tx = c.get('tx');
      const userId = c.get('userId');
      // 🔒 本人の名前候補だけ（prd/14 §4）。他人のもの・無いものは 404
      if (!(await updateAliasPeriod(tx, userId, id, { validFrom, validTo }))) {
        return c.json({ error: 'not found' } as const, 404);
      }
      const updated = await rebuildSubjectSides(tx, userId);
      return c.json({ ok: true, rederived: updated } as const);
    },
  )
  .delete(
    '/users/me/aliases/:id',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    async (c) => {
      // ⚠ **旧名を消すと、その名前で指した過去の棋譜が「自分の対局」でなくなる**
      // （prd/11 §2.2）。画面側で警告してから呼ぶ
      const { id } = c.req.valid('param');
      const tx = c.get('tx');
      const userId = c.get('userId');
      // 🔒 本人の名前候補だけ（prd/14 §4）。他人のもの・無いものは 404
      if (!(await removeAlias(tx, userId, id))) {
        return c.json({ error: 'not found' } as const, 404);
      }
      const updated = await rebuildSubjectSides(tx, userId);
      return c.json({ ok: true, rederived: updated } as const);
    },
  )
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
      if (!key) return c.json({ error: 'not found' } as const, 404);
      const found = await findPositionGames(c.get('tx'), c.get('userId'), key);
      if (!found) return c.json({ error: 'not found' } as const, 404);
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
      if (!key) return c.json({ error: 'not found' } as const, 404);
      const found = await findSubjectGames(c.get('tx'), c.get('userId'), key, side);
      if (!found) return c.json({ error: 'not found' } as const, 404);
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
        window: z.coerce.number().int().min(0).max(20).default(4),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
    ),
    async (c) => {
      const userId = c.get('userId');
      if (userId !== OWNER_USER_ID) {
        return c.json({ error: 'この機能は使えません' } as const, 403);
      }
      const { pos, window, limit } = c.req.valid('query');
      const key = parsePositionKey(pos);
      if (!key) return c.json({ error: 'not found' } as const, 404);
      const found = await findSimilarPositions(c.get('tx'), userId, key, { window, limit });
      if (!found) return c.json({ error: 'not found' } as const, 404);
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
        return c.json({ error: 'SFEN を読めません', violations: [] }, 400);
      }
      const position = validatePositionForEngine(state);
      if (!position.ok) {
        return c.json(
          { error: 'エンジンに渡せない局面です', violations: position.violations },
          400,
        );
      }
      if (move !== null) {
        const moveCheck = validateMoveOnPosition(state, move);
        if (!moveCheck.ok) {
          return c.json(
            { error: 'エンジンに渡せない指し手です', violations: moveCheck.violations },
            400,
          );
        }
      }

      // キャッシュ・ジョブのキーは**読み直して書き戻した SFEN**にする。
      // 手数の有無や書き方の揺れで同じ局面が別扱いになるのを防ぐ（prd/12 §2.4）
      const normalized = positionSfen(state);
      const userId = c.get('userId');

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
          return c.json({ error: '評価キューが一杯です' } as const, 503);
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
        return c.json({ error: '評価ジョブが見つかりません' } as const, 404);
      }
      if (poll.state === 'pending') {
        return c.json({ status: 'pending' as const, jobId });
      }
      return c.json({ jobId, source: 'engine' as const, ...poll.outcome });
    },
  )
  // --- 出題（prd/13）---
  // 🔴 **答えを含む列は返さない**（`answerMove` / `candidates` / `playedMove`）。
  // 渡した時点で答えが見えているのと同じで、専用ページにした意味が消える（prd/13 §7）。
  // 棋譜名・手数・対局者も伏せる——解答後に `POST /drills/:id/answer` が返す
  .get(
    '/drills/next',
    sessionRequired,
    zv('query', z.object({ kind: z.enum(['mate', 'best']).optional() })),
    async (c) => {
      const { kind } = c.req.valid('query');
      const drill = await pickNextDrill(c.get('tx'), c.get('userId'), kind);
      return c.json({ drill });
    },
  )
  .get('/drills/counts', sessionRequired, async (c) =>
    c.json(await drillCounts(c.get('tx'), c.get('userId'))),
  )
  // 解答履歴の一覧（prd/13 §7.3）。⚠ **`/drills/:id` より先に登録する**——
  // `:id` を先に置くと固定の口を飲み込む
  .get(
    '/drills/attempts',
    sessionRequired,
    zv('query', drillAttemptQuerySchema),
    async (c) => c.json(await listDrillAttempts(c.get('tx'), c.get('userId'), c.req.valid('query'))),
  )
  // 問題の一覧（prd/13 §7.2）。🔴 **答えを含む列は返さない**（`/drills/next` と同じ規則）
  .get('/drills', sessionRequired, zv('query', drillListQuerySchema), async (c) =>
    c.json(await listDrills(c.get('tx'), c.get('userId'), c.req.valid('query'))),
  )
  // 一覧から名指しで開いた 1 問（prd/13 §5.4）。返す形は `/drills/next` と同じ
  .get(
    '/drills/:id',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number().int().positive() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const drill = await loadDrillQuestion(c.get('tx'), c.get('userId'), id);
      if (!drill) return c.json({ error: '出題が見つかりません' } as const, 404);
      return c.json({ drill });
    },
  )
  // 「自明だった」の取り消し（prd/13 §7.2）。除外の行そのものを消すので解答履歴は残る
  .post(
    '/drills/:id/unexclude',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number().int().positive() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const drill = await loadDrill(c.get('tx'), c.get('userId'), id);
      if (!drill) return c.json({ error: '出題が見つかりません' } as const, 404);
      await unexcludeDrill(c.get('tx'), c.get('userId'), id);
      return c.json({ ok: true } as const);
    },
  )
  // 「自明だった」で以後の出題から外す（prd/13 §7）。
  // 🔒 印は**履歴側**に置く——出題を作り直しても残るようにするため（prd/13 §6.2）
  .post(
    '/drills/:id/exclude',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number().int().positive() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const drill = await loadDrill(c.get('tx'), c.get('userId'), id);
      if (!drill) return c.json({ error: '出題が見つかりません' } as const, 404);
      await recordAttempt(c.get('tx'), {
        drillId: id,
        ownerId: drill.ownerId,
        move: null,
        verdict: null,
        lossCp: null,
        excluded: true,
      });
      forgetLine(id);
      return c.json({ ok: true } as const);
    },
  )
  // 解答（prd/13 §5）。**採点は server が持つ**——候補手と正解手をクライアントへ
  // 先に渡さないための置き場所でもある（上記 `/drills/next`）。
  // `line` は**出題局面からの全手順**（受方の応手を含み、最後がユーザーの手）。
  // `best` は 1 手、`mate` は詰み上がりまで積み上がる（prd/13 §5.2）。
  .post(
    '/drills/:id/answer',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number().int().positive() })),
    zv(
      'json',
      z.object({
        line: z.array(z.string().min(2).max(8)).min(1).max(64),
        // 採点の線引きは**閲覧者の設定**（prd/13 §5.1）。届かなければ既定
        correctMargin: z.number().int().min(0).max(10000).optional(),
        closeMargin: z.number().int().min(0).max(10000).optional(),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const { line, correctMargin, closeMargin } = c.req.valid('json');
      const drill = await loadDrill(c.get('tx'), c.get('userId'), id);
      if (!drill) return c.json({ error: '出題が見つかりません' } as const, 404);
      const scoring: DrillScoring = {
        correctMargin: correctMargin ?? DEFAULT_SCORING.correctMargin,
        closeMargin: closeMargin ?? DEFAULT_SCORING.closeMargin,
      };

      // 🔴 **手順が問いに対応していることを、局面を作る前に確かめる**
      // （レビュー `OCL-41F41851`）。任意の派生局面を作らせると、**別の局面で採点して
      // 出題局面の最善値と比べる**ことになり、採点も解答履歴も問いと噛み合わなくなる。
      // 覚えている手順（別解に入った後）を優先し、無ければ出題時の pv（prd/13 §5.2）
      const expected = drill.kind === 'mate' ? (recallLine(id) ?? drill.answerPv ?? []) : [];
      const prefix = line.slice(0, -1);
      if (drill.kind === 'best' ? line.length !== 1 : !isPrefixOf(prefix, expected)) {
        return c.json({ error: '手順が出題と噛み合いません' } as const, 400);
      }

      // 出題局面 → `line` の 1 手前まで進めた局面。ここがユーザーの手を指す局面
      const base = drillPosition(drill.usiMoves, drill.moveNumber);
      if (!base) return c.json({ error: '出題局面を再現できません' } as const, 409);
      const move = line[line.length - 1];
      const state = applyLine(base, prefix);
      if (!state) return c.json({ error: '手順を再現できません' } as const, 400);

      // エンジンに渡す前の検証（prd/12 §2.5）。合法性は問わないが、
      // クラッシュ・ハングさせうる手はここで落とす
      const check = validateMoveOnPosition(state, move);
      if (!check.ok) {
        return c.json(
          { error: 'その手は指せません', violations: check.violations },
          400,
        );
      }
      // 🔴 **駒の動き方も見る**（レビュー `OCL-1A2B07B9`）。上の検証は**合法性を問わない**
      // （検討盤のフル編集も同じ道を通るため）ので、歩を横に動かす手は素通りしてエンジンまで届く。
      // **出題の解答は実際に指せた手でなければ意味が無い**ので、この経路だけで足す
      if (!isReachableMove(state, move)) {
        return c.json({ error: 'その手は指せません' } as const, 400);
      }

      // 解答後にだけ返す情報（ネタバレ回避。prd/13 §7）
      const reveal = {
        kifuId: drill.kifuId,
        moveNumber: drill.moveNumber,
        reason: drill.reason,
        answerMove: drill.answerMove,
        answerPv: drill.answerPv,
        playedMove: drill.playedMove,
        playedLossCp: drill.playedLossCp,
      };

      if (drill.kind === 'mate') {
        const step = mateStep(expected, line);
        if (step.state === 'match') {
          if (!step.solved) {
            // 途中。受方の応手だけ返す（**残りの手順は渡さない**）
            return c.json({ status: 'continue' as const, reply: step.reply });
          }
          await recordAttempt(c.get('tx'), {
            drillId: id,
            ownerId: drill.ownerId,
            move,
            line,
            verdict: 'correct',
            lossCp: null,
          });
          forgetLine(id);
          // ⚠ `lossCp` は必ず載せる（mate では常に null）。応答の形を分岐で変えない
          return c.json({
            status: 'done' as const,
            verdict: 'correct' as const,
            lossCp: null,
            ...reveal,
          });
        }
        // 手順から外れた。**別解かもしれない**のでエンジンに聞く（prd/13 §5.2）
        const deviated = await answerWithEngine({ tx: c.get('tx'), userId: c.get('userId'), drill, state, move, line, scoring }, reveal);
        return c.json(deviated.body, deviated.status);
      }

      // 次の一手。**出題時の候補手にあれば往復ゼロで採点する**（prd/13 §5.1）
      const scored = scoreFromCandidates(drill, move, scoring);
      if (scored) {
        await recordAttempt(c.get('tx'), { drillId: id, ownerId: drill.ownerId, move, line, ...scored });
        return c.json({ status: 'done' as const, ...scored, ...reveal });
      }
      const resolved = await answerWithEngine({ tx: c.get('tx'), userId: c.get('userId'), drill, state, move, line, scoring }, reveal);
      return c.json(resolved.body, resolved.status);
    },
  )
  // --- 動画解析（prd/10）---
  // 一覧は動画ごと → 局ごと（所有者の棋譜だけ）。取り込み（API_KEY）は `worker-routes.ts`
  .get('/video-analysis/kifus', sessionRequired, async (c) =>
    c.json(await listVideoKifus(c.get('tx'), c.get('userId'))),
  )
  .post(
    '/kifus/:id/reanalyze',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!(await reanalyzeKifu(c.get('tx'), c.get('userId'), id))) {
        return c.json({ error: 'not found' }, 404);
      }
      // 旧解析の進捗を落とす（**コミットの後**。以降に届く旧世代の報告は世代照合で弾かれる）
      c.get('afterCommit')(() => clearProgress(id));
      return c.json({ ok: true }, 201);
    },
  )
  .delete(
    '/kifus/:id',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!(await deleteKifu(c.get('tx'), c.get('userId'), id))) {
        return c.json({ error: 'not found' }, 404);
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
    '/kifus/:id',
    sessionRequired,
    zv('param', z.object({ id: z.coerce.number() })),
    zv('json', z.object({ memo: z.string().nullable() })),
    async (c) => {
      const { id } = c.req.valid('param');
      const { memo } = c.req.valid('json');
      if (!(await updateKifuMemo(c.get('tx'), c.get('userId'), id, memo))) {
        return c.json({ error: 'not found' }, 404);
      }
      return c.json({ ok: true });
    },
  )
  // --- 全員ぶんを扱う経路（API_KEY）: worker の報告・動画解析の取り込み ---
  .route('/', workerRoutes);

export type AppType = typeof route;
