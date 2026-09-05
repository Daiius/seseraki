import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { alias } from 'drizzle-orm/mysql-core';
import { logger } from 'hono/logger';
import { zValidator as zv } from '@hono/zod-validator';
import { z } from 'zod';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { db } from './db/index.js';
import {
  kifus,
  moveAnalyses,
  candidateMoves,
  kifuTactics,
  videoKifuSources,
  kifuPositions,
  users,
  userAliases,
} from './db/schema.js';
import {
  kifuListOrderBy,
  kifuListQuerySchema,
  kifuListWhere,
  playedOrCreatedAt,
} from './kifu-list-query.js';
import {
  statsTacticsJoinOn,
  statsTacticsOrderBy,
  statsTacticsPeriodWhere,
  statsTacticsQuerySchema,
  statsTacticsRowsSelect,
  statsTacticsSummarySelect,
  statsTacticsWhere,
} from './stats-tactics-query.js';
import { apiKeyRequired } from './middlewares.js';
import {
  formatDiff,
  importVideoKifu,
  videoKifuInputSchema,
} from './video-analysis.js';
import {
  hasValidSession,
  issueSession,
  revokeSession,
  sessionRequired,
  verifyCredentials,
} from './auth.js';
import {
  clearProgress,
  getClearToken,
  getProgress,
  setProgress,
} from './analysis-progress.js';
import {
  canWriteRow,
  isAnalysisComplete,
  isChunkAcceptable,
  isChunkInRange,
  isStageComplete,
  nextKifuProfile,
  resolveExistingMoveAnalyses,
} from './analysis-submit.js';
import {
  claimEvaluationJob,
  completeEvaluationJob,
  EvaluationQueueFullError,
  getEvaluationResult,
  startEvaluation,
} from './position-eval.js';
import { lookupKifuEvaluation } from './position-kifu-reuse.js';
import { swarsToKif, formatTitle, parsePlayedAt } from './swars/csa-to-kif.js';
import { fetchHistoryKeys, fetchGameData } from './swars/fetch.js';
import { getJob, startJob } from './swars/job-store.js';
import {
  attributionOf,
  createInitialState,
  parseSfen,
  positionDiff,
  positionSfen,
  validateMoveOnPosition,
  validatePositionForEngine,
  type PositionDiff,
  type TacticLabel,
} from 'shared';
import { replaceTactics } from './tactics';
import { replacePositions } from './positions';
import {
  addAlias,
  countUnresolvedSubjects,
  currentUserId,
  rebuildSubjectSides,
  refreshSubjectSide,
  removeAlias,
  updateAliasPeriod,
} from './users';
import {
  detectLegacyUtcTimezone,
  parseKif,
  type KifTimezone,
} from './kif/parser.js';

/** 投入時の TZ 指定。'auto' は自動判定＝現状 JST 固定（[parseKif]） */
export type SourceTzChoice = 'auto' | KifTimezone;

/** 局面検索の起点。`pos` 未指定ならここから辿る（prd/10 §6.2） */
const INITIAL_SFEN = positionSfen(createInitialState());

/**
 * 1 つの局面について返す到達行の上限。
 * ⚠ **切ったことは `total` / `hasMore` で必ず知らせる**（prd/10 §6.2）。初期局面は
 * 全棋譜が通るので、棋譜が増えれば必ずここに当たる。
 */
const POSITION_GAMES_LIMIT = 200;

/**
 * 近い局面の探索で読み出す行の上限。手数帯で絞った後の行数なので、
 * 数百局なら普通は数千行で収まる。⚠ **当たったら `truncated` で知らせる**。
 */
const SIMILAR_SCAN_LIMIT = 20000;

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
 * @param tz 開始日時の解釈 TZ。'auto'（既定）は JST。
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

// swars 自動取り込み（`/swars/*`）は恒常的に無効。swars 側で KIF を手軽にコピーできる
// ようになり自動取り込みが不要になったこと、およびグレー領域の機能なので露出を絞ることが理由
// （prd/04 §4）。**実装（swars/ モジュール・下のジョブ起動ロジック）は残す**が、フロント/API から
// は到達できない。env フラグではなくコード上の定数なので、再有効化には明示的なコード変更が要る。
// 型は boolean（リテラル true にしない）——後続のハンドラ実装を「到達不能コード」にしないため。
const SWARS_IMPORT_DISABLED: boolean = true;

// 無効化ガード。認証・body 検証より前に置き、**常時 404** にする（無効な口では認証状態も晒さない）。
const swarsDisabled: MiddlewareHandler = async (c, next) => {
  if (SWARS_IMPORT_DISABLED) {
    return c.json({ error: 'swars import is disabled' } as const, 404);
  }
  await next();
};

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
    zv('query', kifuListQuerySchema),
    async (c) => {
      const query = c.req.valid('query');
      const { page } = query;
      const limit = 50;
      const offset = (page - 1) * limit;

      const where = kifuListWhere(query);

      const [{ total }] = await db
        .select({ total: count() })
        .from(kifus)
        .where(where);

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
          // 完了した段階のうち最も高いもの（prd/05 §1.1d）。一覧は「解析済み」に quick を
          // 含めたうえで、簡易のみの棋譜に「簡易」の印を添えるためにこれを見る
          analysisProfile: kifus.analysisProfile,
          analysisError: kifus.analysisError,
          hasMemo: sql<boolean>`${kifus.memo} IS NOT NULL`,
          // 主体の手番（prd/11 §4）。web はこれで自分/相手を出せる——
          // 名前候補から毎回判定しなくてよくなる（移行は prd/11 §6 の段階 B）
          subjectSide: kifus.subjectSide,
        })
        .from(kifus)
        .where(where)
        .orderBy(...kifuListOrderBy(query))
        .limit(limit)
        .offset(offset);

      // 戦型ラベルはページ内の棋譜ぶんをまとめて引く（N+1 を避ける）。
      // **保存値をそのまま返す**（経由形も含む）。表示の抑制と関係ラベルの導出は
      // shared の純関数で web 側が行う（prd/03 §2.1.2）
      const ids = rows.map((r) => r.id);
      const tacticRows =
        ids.length === 0
          ? []
          : await db
              .select({
                kifuId: kifuTactics.kifuId,
                side: kifuTactics.side,
                label: kifuTactics.label,
                turn: kifuTactics.turn,
              })
              .from(kifuTactics)
              .where(inArray(kifuTactics.kifuId, ids));
      const tacticsByKifu = new Map<number, TacticLabel[]>();
      for (const { kifuId, ...t } of tacticRows) {
        const list = tacticsByKifu.get(kifuId);
        if (list) list.push(t);
        else tacticsByKifu.set(kifuId, [t]);
      }

      return c.json({
        kifus: rows.map(({ analyzedAt, analysisError, hasMemo, ...r }) => ({
          ...r,
          analyzed: analyzedAt !== null,
          failed: analysisError !== null,
          hasMemo: Boolean(hasMemo),
          tactics: tacticsByKifu.get(r.id) ?? [],
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

      // 戦型ラベルは**保存値をそのまま返す**（経由形も含む）。表示の抑制と関係ラベルの導出は
      // shared の純関数で web 側が行う（prd/03 §2.1.2）
      const tactics = await db
        .select({
          side: kifuTactics.side,
          label: kifuTactics.label,
          turn: kifuTactics.turn,
        })
        .from(kifuTactics)
        .where(eq(kifuTactics.kifuId, id));

      return c.json({ ...kifu, analyses: analysesWithCandidates, tactics });
    },
  )
  // 戦型別成績（prd/09）。**生ラベルで数える平坦な行**を返し、階層（`IMPLIES`）は web で組む。
  // 局数の合計は総局数を超える（各行は独立した問いへの答えで分割ではない。prd/09 §2.1）
  .get(
    '/stats/tactics',
    sessionRequired,
    zv('query', statsTacticsQuerySchema),
    async (c) => {
      const query = c.req.valid('query');

      // 総局数と除外の内訳は期間内の全局が母集団（ラベルとは無関係）。
      // 集計対象が空でも 1 行返るので `[summary]` で受けられる
      const [summary] = await db
        .select(statsTacticsSummarySelect(query))
        .from(kifus)
        .where(statsTacticsPeriodWhere(query));

      const rows = await db
        .select(statsTacticsRowsSelect(query))
        .from(kifus)
        .innerJoin(kifuTactics, statsTacticsJoinOn(query))
        .where(statsTacticsWhere(query))
        .groupBy(kifuTactics.label)
        .orderBy(...statsTacticsOrderBy());

      const { totalGames, ...excluded } = summary;
      return c.json({
        totalGames,
        excluded,
        // 帰属は判定側（shared）が単一の出所。web が帰属バッジ・分母の説明に使う（prd/09 §2.2）
        rows: rows.map((r) => ({ ...r, attribution: attributionOf(r.label) })),
      });
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
      // **usiMoves の書き込みと戦型の判定は同一トランザクション**（prd/01 §6.4）。
      // 別にすると、戦型判定で落ちたときに「指し手はあるがラベルが無い」棋譜が残り、
      // 一覧の絞り込みから黙って外れる
      const id = await db.transaction(async (tx) => {
        const ownerId = await currentUserId(tx);
        const [result] = await tx
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
            ownerId,
          })
          .$returningId();
        await replaceTactics(tx, result.id, usiMoves);
        await replacePositions(tx, result.id, usiMoves);
        // 主体側も同じトランザクションで（対局者名から導出する。prd/11 §4）
        await refreshSubjectSide(tx, result.id);
        return result.id;
      });
      return c.json({ id }, 201);
    },
  )
  // --- 自分（prd/11）---
  // 🔒 名前候補を変えたら、**同じトランザクションで主体側を引き直す**（prd/11 §4.2）。
  // 手動の再導出に頼ると、変えた直後に画面の数字が古いまま残り、
  // しかも間違っていることが画面から分からない。
  .get('/users/me', sessionRequired, async (c) => {
    const userId = await currentUserId();
    const [user] = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    const aliases = await db
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
      unresolvedSubjects: await countUnresolvedSubjects(userId),
    });
  })
  .patch(
    '/users/me',
    sessionRequired,
    zv('json', z.object({ displayName: z.string().trim().min(1).max(100) })),
    async (c) => {
      const { displayName } = c.req.valid('json');
      const userId = await currentUserId();
      await db.update(users).set({ displayName }).where(eq(users.id, userId));
      return c.json({ ok: true } as const);
    },
  )
  .post(
    '/users/me/aliases',
    sessionRequired,
    zv('json', aliasCreateSchema),
    async (c) => {
      const { name, validFrom, validTo } = c.req.valid('json');
      const userId = await currentUserId();
      try {
        const updated = await db.transaction(async (tx) => {
          await addAlias(tx, userId, name, { validFrom, validTo });
          return rebuildSubjectSides(tx, userId);
        });
        return c.json({ ok: true, rederived: updated } as const, 201);
      } catch (e) {
        // `name` は UNIQUE（大文字小文字を区別する。prd/11 §2.1）
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes('Duplicate')) {
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
      const userId = await currentUserId();
      const updated = await db.transaction(async (tx) => {
        await updateAliasPeriod(tx, id, { validFrom, validTo });
        return rebuildSubjectSides(tx, userId);
      });
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
      const userId = await currentUserId();
      const updated = await db.transaction(async (tx) => {
        await removeAlias(tx, id);
        return rebuildSubjectSides(tx, userId);
      });
      return c.json({ ok: true, rederived: updated } as const);
    },
  )
  // --- 局面検索（prd/10 §5.3）---
  // 🔒 **ここには `ownGamesOnly` を掛けない。** 一覧・集計は「自分の成績」なので動画解析を
  // 外すが、局面検索は**自分の対局と動画解析を横断して探す**のが目的そのもの（prd/10 §5.3）。
  // 結果には `source` を添えて、どちらの出所かを画面で区別できるようにする。
  .get(
    '/positions',
    sessionRequired,
    zv('query', z.object({ pos: z.string().max(200).optional() })),
    async (c) => {
      const sfen = c.req.valid('query').pos ?? INITIAL_SFEN;

      // この局面を通った棋譜。**同じ棋譜が同じ局面を 2 度通ることもある**（千日手模様）ので
      // kifuId では畳まず、到達した手数ごとに 1 行返す。
      //
      // 🔒 **打ち切ったことを黙らない。** 初期局面は全棋譜が通るので、棋譜が増えれば
      // 必ず上限に当たる。件数を返さないと、UI の「N 件」が実数と食い違ううえ、
      // 「この局面を通った棋譜はこれで全部」と誤読される。
      // ⚠ **総数は `count(*) over ()` で同じクエリから取る。** count を別クエリにすると
      // 2 つのスナップショットになり、その間に取り込み・削除・再構築が走ると
      // 「total 199 なのに games 200 件」のような食い違いが出る（0 件なら 404 を返すので、
      // 総数が取れない場合を扱う必要はない）
      const rows = await db
        .select({
          kifuId: kifuPositions.kifuId,
          moveNumber: kifuPositions.moveNumber,
          board: kifuPositions.board,
          hands: kifuPositions.hands,
          sideToMove: kifuPositions.sideToMove,
          title: kifus.title,
          source: kifus.source,
          playedAt: kifus.playedAt,
          total: sql<number>`count(*) over ()`,
        })
        .from(kifuPositions)
        .innerJoin(kifus, eq(kifus.id, kifuPositions.kifuId))
        .where(eq(kifuPositions.sfen, sfen))
        // ⚠ **並びは打ち切りとセットで意味を持つ。** 序盤の局面はどの棋譜も通るので
        // 必ず上限に当たる。そこで残るのが「古い棋譜」では使い物にならないので、
        // 到達が早い順 → **新しい対局順**に並べる（基準は一覧と同じ playedOrCreatedAt）
        .orderBy(
          asc(kifuPositions.moveNumber),
          desc(playedOrCreatedAt),
          desc(kifuPositions.kifuId),
        )
        .limit(POSITION_GAMES_LIMIT);
      if (rows.length === 0) return c.json({ error: 'not found' } as const, 404);

      // 枝の列挙。**次の局面が持つ `move` で集計する**——局面キーだけでは
      // 「同じ局面から指された別の手」を区別できない（prd/10 §5.3）
      const next = alias(kifuPositions, 'next');
      const branches = await db
        .select({
          move: next.move,
          sfen: next.sfen,
          games: sql<number>`count(*)`,
        })
        .from(kifuPositions)
        .innerJoin(
          next,
          and(
            eq(next.kifuId, kifuPositions.kifuId),
            eq(next.moveNumber, sql`${kifuPositions.moveNumber} + 1`),
          ),
        )
        .where(eq(kifuPositions.sfen, sfen))
        .groupBy(next.move, next.sfen)
        .orderBy(desc(sql`count(*)`), asc(next.move));

      // 盤・持ち駒はこの局面のものなのでどの行でも同じ。web が盤を描くのに使う
      const [first] = rows;
      const total = Number(first.total);
      return c.json({
        sfen,
        isInitial: sfen === INITIAL_SFEN,
        board: [...first.board],
        hands: [...first.hands],
        sideToMove: first.sideToMove,
        games: rows.map(
          ({ board: _b, hands: _h, sideToMove: _s, total: _t, ...g }) => g,
        ),
        /** 到達の総数。`games` は上限で切れていることがある（`hasMore`） */
        total,
        hasMore: total > rows.length,
        branches: branches.map((b) => ({ ...b, games: Number(b.games) })),
      });
    },
  )
  // 主体側モード（prd/10 §3.3）。**自分の駒の配置**が同じ棋譜を、先後をまたいで探す。
  // 🔒 `subjectSide` が NULL の棋譜は除外し、**その件数を返す**——黙って落とすと、
  // 結果が少ない理由が「似た形が無い」のか「主体が決まらない棋譜を外した」のか分からない
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

      // 基準となる片側の配置。⚠ `goteSfen` は 180 度回して保存されているので、
      // 先後をまたいでそのまま比べられる（prd/10 §3.2）
      const [base] = await db
        .select({
          senteSfen: kifuPositions.senteSfen,
          goteSfen: kifuPositions.goteSfen,
        })
        .from(kifuPositions)
        .where(eq(kifuPositions.sfen, pos))
        .limit(1);
      if (!base) return c.json({ error: 'not found' } as const, 404);
      const baseSideSfen = side === 'sente' ? base.senteSfen : base.goteSfen;

      const rows = await db
        .select({
          kifuId: kifuPositions.kifuId,
          moveNumber: kifuPositions.moveNumber,
          sfen: kifuPositions.sfen,
          title: kifus.title,
          source: kifus.source,
          subjectSide: kifus.subjectSide,
          playedAt: kifus.playedAt,
          total: sql<number>`count(*) over ()`,
        })
        .from(kifuPositions)
        .innerJoin(kifus, eq(kifus.id, kifuPositions.kifuId))
        .where(
          and(
            isNotNull(kifus.subjectSide),
            or(
              and(
                eq(kifus.subjectSide, 'sente'),
                eq(kifuPositions.senteSfen, baseSideSfen),
              ),
              and(
                eq(kifus.subjectSide, 'gote'),
                eq(kifuPositions.goteSfen, baseSideSfen),
              ),
            ),
          ),
        )
        .orderBy(
          asc(kifuPositions.moveNumber),
          desc(playedOrCreatedAt),
          desc(kifuPositions.kifuId),
        )
        .limit(POSITION_GAMES_LIMIT);

      // 主体側が決まらない棋譜の数（この検索の対象外になっているもの）
      const [{ unresolved }] = await db
        .select({ unresolved: count() })
        .from(kifus)
        .where(isNull(kifus.subjectSide));

      const total = rows.length > 0 ? Number(rows[0].total) : 0;
      return c.json({
        base: { sfen: pos, side, sideSfen: baseSideSfen },
        games: rows.map(({ total: _t, ...g }) => g),
        total,
        hasMore: total > rows.length,
        /** 🔒 主体側が決まらないので除外した棋譜の数（prd/10 §3.3） */
        unresolvedSubjects: unresolved,
      });
    },
  )
  // 近い局面（prd/10 §5.2）。完全一致は `/positions` が返すので、ここは**別枠**。
  // 距離の計算はアプリ側に置く——「近い」が何を意味するかは使ってみないと決まらないので、
  // 定義を SQL に焼き込まない
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
      const { pos, window, limit } = c.req.valid('query');

      // 基準の局面。**最初に到達した手数**を手数帯の中心にする
      // （同じ局面でも棋譜ごとに到達手数が違う）
      const [base] = await db
        .select({
          moveNumber: kifuPositions.moveNumber,
          board: kifuPositions.board,
          hands: kifuPositions.hands,
        })
        .from(kifuPositions)
        .where(eq(kifuPositions.sfen, pos))
        .orderBy(asc(kifuPositions.moveNumber))
        .limit(1);
      if (!base) return c.json({ error: 'not found' } as const, 404);

      // この局面を既に通った棋譜を外すためのエイリアス（下の NOT EXISTS で使う）
      const exact = alias(kifuPositions, 'exact');
      const from = Math.max(0, base.moveNumber - window);
      const to = base.moveNumber + window;

      // 粗く絞ってから全件に距離を掛ける。手数帯で絞れば 1 棋譜あたり高々
      // `2 * window + 1` 行なので、数百局でも数千行に収まる
      const candidates = await db
        .select({
          sfen: kifuPositions.sfen,
          kifuId: kifuPositions.kifuId,
          moveNumber: kifuPositions.moveNumber,
          board: kifuPositions.board,
          hands: kifuPositions.hands,
          sideToMove: kifuPositions.sideToMove,
          title: kifus.title,
          source: kifus.source,
          playedAt: kifus.playedAt,
        })
        .from(kifuPositions)
        .innerJoin(kifus, eq(kifus.id, kifuPositions.kifuId))
        .where(
          and(
            gte(kifuPositions.moveNumber, from),
            lte(kifuPositions.moveNumber, to),
            // 完全一致は `/positions` の側で出ているので、ここでは除く
            ne(kifuPositions.sfen, pos),
            // 🔒 **この局面を通った棋譜そのものを外す。** 外さないと、序盤では
            // 「1 手前の局面（距離 2）」が全棋譜ぶん並ぶだけになる——どの棋譜も
            // 通っているので**当たり前の結果しか出ない**。近さが意味を持つのは
            // 「完全一致はしないが似ている棋譜」で、それを探すのがこの機能の目的
            notExists(
              db
                .select({ one: sql`1` })
                .from(exact)
                .where(and(eq(exact.kifuId, kifuPositions.kifuId), eq(exact.sfen, pos))),
            ),
          ),
        )
        .limit(SIMILAR_SCAN_LIMIT);

      // ⭐ **棋譜ごとに最も近い 1 局面へ畳む。** 隣接する局面は高々 2 マスしか違わないので、
      // 畳まないと**同じ棋譜の連続する局面が上位を埋め尽くす**（似た棋譜が 1 局しか出ない）
      const best = new Map<number, (typeof candidates)[number] & { diff: PositionDiff }>();
      for (const row of candidates) {
        const diff = positionDiff(base, row);
        const current = best.get(row.kifuId);
        if (!current || diff.total < current.diff.total) {
          best.set(row.kifuId, { ...row, diff });
        }
      }

      const similar = [...best.values()]
        .sort((a, b) => a.diff.total - b.diff.total || a.moveNumber - b.moveNumber)
        .slice(0, limit)
        .map(({ board: _b, hands: _h, diff, ...r }) => ({
          ...r,
          distance: diff.total,
          boardDiff: diff.board,
          handsDiff: diff.hands,
        }));

      return c.json({
        base: { sfen: pos, moveNumber: base.moveNumber, from, to },
        similar,
        /** 距離を掛けた行数と、読み出しを打ち切ったか（🔒 黙って切らない） */
        scanned: candidates.length,
        truncated: candidates.length === SIMILAR_SCAN_LIMIT,
        /** 畳む前に見つかった棋譜の数（`similar` は limit で切れている） */
        matchedGames: best.size,
      });
    },
  )
  // 検討局面の評価（prd/12 §2）。**受け付けて即座に返す**（決定 2026-08-29）。
  // キャッシュ・棋譜解析から引ければその場で結果まで返り（1 往復）、エンジンに回すときは
  // `status: 'pending'` と `jobId` を返す。要求側は GET /positions/evaluate/:jobId で取りに来る。
  // 🔴 long-poll をやめたのは、前段にタイムアウトを持つ層があり、その期限が server の期限より
  //    ずっと短いため。**成功しているのに失敗して見える**事故が本番で起きた（prd/12 §2.4）。
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

      // 🔴 **エンジンにジョブを積む前に、既存の棋譜解析から引く**（prd/12 §2.6）。
      // 検討の起点は閲覧中の棋譜の局面なので、数手動かすまでは解析済みの局面を
      // なぞっているだけのことが多い。⚠ 局面の検証（上）はこの判定より**前**のまま
      // 保つ——エンジンに渡さないとしても、壊れた局面を受け付けてよいことにはならない。
      // ⚠ **`source` で出所を隠さない**（解析時のエンジン設定は今と違いうる）
      const reused = await lookupKifuEvaluation({ sfen: normalized, move });
      if (reused) {
        // `reused` が `source: 'kifu'` を持つ（出所の付与は position-kifu-reuse.ts の責務）
        return c.json({ sfen: normalized, move, ...reused });
      }

      try {
        const started = startEvaluation({ sfen: normalized, move });
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
  .get(
    '/positions/evaluate/:jobId',
    sessionRequired,
    zv('param', z.object({ jobId: z.string().min(1).max(64) })),
    (c) => {
      const { jobId } = c.req.valid('param');
      const poll = getEvaluationResult(jobId);
      if (poll.state === 'unknown') {
        return c.json({ error: '評価ジョブが見つかりません' } as const, 404);
      }
      if (poll.state === 'pending') {
        return c.json({ status: 'pending' as const, jobId });
      }
      return c.json({ jobId, source: 'engine' as const, ...poll.outcome });
    },
  )
  // --- 動画解析（prd/10）---
  // 一覧は動画ごと → 局ごと。件数が少ない（1 動画 2〜3 局）ためページングは持たない
  .get('/video-analysis/kifus', sessionRequired, async (c) => {
    const rows = await db
      .select({
        kifuId: kifus.id,
        title: kifus.title,
        videoId: videoKifuSources.videoId,
        gameIndex: videoKifuSources.gameIndex,
        startedAtSec: videoKifuSources.startedAtSec,
        endedAtSec: videoKifuSources.endedAtSec,
        bottomIsSente: videoKifuSources.bottomIsSente,
        extractorRev: videoKifuSources.extractorRev,
        updatedAt: videoKifuSources.updatedAt,
        // 一覧に要るのは手数だけ。指し手列そのものを載せると 1 局 100 手ぶんが無駄に流れる
        moveCount: sql<number>`json_length(${kifus.usiMoves})`,
        analyzedAt: kifus.analysisCompletedAt,
        analysisError: kifus.analysisError,
      })
      .from(videoKifuSources)
      .innerJoin(kifus, eq(kifus.id, videoKifuSources.kifuId))
      .orderBy(
        asc(videoKifuSources.videoId),
        asc(videoKifuSources.gameIndex),
      );

    // 戦型ラベルはまとめて引く（一覧と同じ形。N+1 を避ける）
    const ids = rows.map((r) => r.kifuId);
    const tacticRows =
      ids.length === 0
        ? []
        : await db
            .select({
              kifuId: kifuTactics.kifuId,
              side: kifuTactics.side,
              label: kifuTactics.label,
              turn: kifuTactics.turn,
            })
            .from(kifuTactics)
            .where(inArray(kifuTactics.kifuId, ids));
    const tacticsByKifu = new Map<number, TacticLabel[]>();
    for (const { kifuId, ...t } of tacticRows) {
      const list = tacticsByKifu.get(kifuId);
      if (list) list.push(t);
      else tacticsByKifu.set(kifuId, [t]);
    }

    return c.json({
      games: rows.map(({ analyzedAt, analysisError, ...r }) => ({
        ...r,
        moveCount: Number(r.moveCount ?? 0),
        analyzed: analyzedAt !== null,
        failed: analysisError !== null,
        analysisError,
        tactics: tacticsByKifu.get(r.kifuId) ?? [],
      })),
    });
  })
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
      // TZ は投入時のユーザー選択（保存済み sourceTz）を維持する。未設定（旧データ＝TZ を
      // 記録し始める前の投入分）は、当時 UTC で書き出していたアプリの棋譜がありうるので
      // 旧署名で補う（新規取り込みは JST 固定。[detectLegacyUtcTimezone]）。
      const tz =
        (kifu.sourceTz as KifTimezone | null) ??
        detectLegacyUtcTimezone(kifu.kifText);
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
            // 段階もやり直す（両段階を最初から。prd/05 §1.1d）
            analysisProfile: null,
            analysisRevision: sql`${kifus.analysisRevision} + 1`,
          })
          .where(eq(kifus.id, id));
        // 旧解析結果を削除（未解析状態で旧結果が残らないように）。candidateMoves は CASCADE
        await tx.delete(moveAnalyses).where(eq(moveAnalyses.kifuId, id));
        // 指し手列を作り直したので戦型も置き換える（prd/01 §6.4）。
        // 再変換に失敗して usiMoves が null になった場合はラベルを空にする
        await replaceTactics(tx, id, usiMoves);
        // 局面索引も同じトランザクションで作り直す（派生値なので usiMoves に追随する。prd/10 §3.2）
        await replacePositions(tx, id, usiMoves);
        // 再変換で対局者名が変わりうるので、主体側も引き直す（prd/11 §4.2）
        await refreshSubjectSide(tx, id);
      });
      // 旧解析の進捗を落とす。以降に届く旧世代の報告は世代照合で弾かれる
      clearProgress(id);
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
      // 消えた棋譜の「解析中」が残らないように（行が無くなるので以降の報告も弾かれる）
      clearProgress(id);
      return c.json({ ok: true });
    },
  )
  // 解析中の棋譜の進捗（メモリ参照のみ・DB を触らない）。解析中は高々 1 件なので、
  // 一覧も詳細もこれ 1 つを見て自分の id と一致したら表示する
  .get('/analysis/progress', sessionRequired, (c) => {
    return c.json(getProgress());
  })
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
      // ⚠ **段階ごとに数える**（prd/05 §1.1d）: quick は全行数、full は `profile='full'` の行数
      // （full は 0 から順に上書きするので、full 行は常に先頭からの連続区間になる）
      const [{ analyzedCount }] = await db
        .select({ analyzedCount: count() })
        .from(moveAnalyses)
        .where(
          profile === 'full'
            ? and(
                eq(moveAnalyses.kifuId, kifu.id),
                eq(moveAnalyses.profile, 'full'),
              )
            : eq(moveAnalyses.kifuId, kifu.id),
        );
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
      const applied = result[0].affectedRows > 0;
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
        setProgress({ kifuId, revision, profile, analyzed, total }, token);
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
      // 来歴の列（局面ごとに同じ値が入る。チャンク単位で 1 回の解析設定だから）
      const provenance = {
        profile,
        engineName: engineName ?? null,
        movetimeMs: movetimeMs ?? null,
        targetDepth: targetDepth ?? null,
        multiPv: multiPv ?? null,
      };
      let applied = false;
      let completed = false;
      // 棋譜の手数を超える moveNumber が入ると、必要な局面が欠けたまま件数だけが達して
      // 完了扱いになりうる（完了すると poll 対象から外れ、自動再開でも直らない）
      let outOfRange = false;
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
        applied = true;

        // チャンクは**追記**する（DELETE しない）。前世代の全消去は `reanalyze` の DELETE が
        // 唯一の経路になる（prd/03 §3・§7）。
        if (analyses.length > 0) {
          const existing = await tx
            .select({
              id: moveAnalyses.id,
              moveNumber: moveAnalyses.moveNumber,
              profile: moveAnalyses.profile,
            })
            .from(moveAnalyses)
            .where(
              and(
                eq(moveAnalyses.kifuId, kifuId),
                inArray(
                  moveAnalyses.moveNumber,
                  analyses.map((a) => a.moveNumber),
                ),
              ),
            );
          const existingProfiles = new Map(
            existing.map((row) => [row.moveNumber, row.profile]),
          );
          // 同一 moveNumber の再送は既存行を使い回して候補手を入れ直す（行が二重に増えない）
          for (const { analysis, existingId } of resolveExistingMoveAnalyses(
            analyses,
            existing,
          )) {
            // 段階の後退防止（prd/05 §1.1d）: 既存が full の局面に quick が届いたら書かずに無視する
            if (!canWriteRow(existingProfiles.get(analysis.moveNumber), profile)) {
              continue;
            }
            let moveAnalysisId = existingId;
            if (moveAnalysisId === null) {
              const [inserted] = await tx
                .insert(moveAnalyses)
                .values({
                  kifuId,
                  moveNumber: analysis.moveNumber,
                  ...provenance,
                })
                .$returningId();
              moveAnalysisId = inserted.id;
            } else {
              // 上書き（quick → full）でも行は増やさず、来歴を今回の段階で更新する
              await tx
                .update(moveAnalyses)
                .set(provenance)
                .where(eq(moveAnalyses.id, moveAnalysisId));
              await tx
                .delete(candidateMoves)
                .where(eq(candidateMoves.moveAnalysisId, moveAnalysisId));
            }
            if (analysis.candidates.length > 0) {
              await tx.insert(candidateMoves).values(
                analysis.candidates.map((candidate) => ({
                  moveAnalysisId,
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
        }

        // 完了は **server が件数で判定**する（worker の申告に依らない。prd/05 §1.1c）。
        // 同じトランザクション内で数えて立てるので、チャンク境界や worker のクラッシュ位置に依存しない。
        // ⚠ **段階ごとに数える**（prd/05 §1.1d）: quick = 全行数 / full = `profile='full'` の行数
        const [{ stored, storedFull }] = await tx
          .select({
            stored: count(),
            storedFull: sql<number>`sum(case when ${moveAnalyses.profile} = 'full' then 1 else 0 end)`.mapWith(
              Number,
            ),
          })
          .from(moveAnalyses)
          .where(eq(moveAnalyses.kifuId, kifuId));
        const quickDone = isAnalysisComplete(stored, current.usiMoves);
        const fullDone = isAnalysisComplete(storedFull, current.usiMoves);
        // 進捗表示を落とすのは**報告された段階**が終わったとき（full 進行中に quick の
        // 完了で落とすと、まだ動いている解析の表示が消える）
        completed = profile === 'full' ? fullDone : quickDone;
        const profileAfter = nextKifuProfile(current.analysisProfile, {
          quick: quickDone,
          full: fullDone,
        });
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
  )
  // --- swars 棋譜取得 ---
  .post(
    '/swars/import',
    swarsDisabled,
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
            const newId = await db.transaction(async (tx) => {
              const ownerId = await currentUserId(tx);
              const [result] = await tx
                .insert(kifus)
                .values({
                  ownerId,
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
              await replaceTactics(tx, result.id, usiMoves);
        await replacePositions(tx, result.id, usiMoves);
        // 主体側も同じトランザクションで（対局者名から導出する。prd/11 §4）
        await refreshSubjectSide(tx, result.id);
              return result.id;
            });
            imported.push({ id: newId, gameKey });
          } catch (e) {
            errors.push({ gameKey, error: String(e) });
          }
        }

        return { imported, skipped, errors };
      });

      return c.json(state, 202);
    },
  )
  .get('/swars/import/status', swarsDisabled, sessionRequired, (c) => {
    return c.json(getJob());
  });

export type AppType = typeof route;
