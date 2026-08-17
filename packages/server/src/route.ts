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
  isAnalysisComplete,
  isChunkAcceptable,
  isChunkInRange,
  resolveExistingMoveAnalyses,
} from './analysis-submit.js';
import { swarsToKif, formatTitle, parsePlayedAt } from './swars/csa-to-kif.js';
import { fetchHistoryKeys, fetchGameData } from './swars/fetch.js';
import { getJob, startJob } from './swars/job-store.js';
import {
  attributionOf,
  createInitialState,
  positionDiff,
  positionSfen,
  type PositionDiff,
  type TacticLabel,
} from 'shared';
import { replaceTactics } from './tactics';
import { replacePositions } from './positions';
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
          analysisError: kifus.analysisError,
          hasMemo: sql<boolean>`${kifus.memo} IS NOT NULL`,
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
          })
          .$returningId();
        await replaceTactics(tx, result.id, usiMoves);
        await replacePositions(tx, result.id, usiMoves);
        return result.id;
      });
      return c.json({ id }, 201);
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
    if (!kifu) return c.json(null);
    // 既に入っている局面数を返し、worker はその続き（moveNumber = analyzedCount）から解析する
    // （チャンク submit の中断からの再開。prd/05 §1.1c）。チャンク submit の失敗は解析ごと中断する
    // ため moveNumber に穴が空かず、**件数がそのまま再開位置**になる
    const [{ analyzedCount }] = await db
      .select({ analyzedCount: count() })
      .from(moveAnalyses)
      .where(eq(moveAnalyses.kifuId, kifu.id));
    return c.json({ ...kifu, analyzedCount });
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
        analyzed: z.number().min(0),
        total: z.number().min(1),
      }),
    ),
    async (c) => {
      const { kifuId, revision, analyzed, total } = c.req.valid('json');
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
          error: kifus.analysisError,
        })
        .from(kifus)
        .where(eq(kifus.id, kifuId));
      const valid =
        kifu !== undefined &&
        kifu.revision === revision &&
        kifu.completedAt === null &&
        kifu.error === null;
      const applied =
        valid && setProgress({ kifuId, revision, analyzed, total }, token);
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
      const { kifuId, revision, analyses } = c.req.valid('json');
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
            usiMoves: kifus.usiMoves,
          })
          .from(kifus)
          .where(eq(kifus.id, kifuId))
          .for('update');
        // 同一世代 かつ 失敗記録なし かつ 未完了 のときだけ適用。既に error が立っていれば結果は
        // 保存しない → completedAt と analysisError は排他になる（行ロック下で error 報告と直列化）。
        // 完了済みも弾く＝完了後の解析結果は不変（遅れて届いたチャンクで部分的に上書きされない）。
        if (!isChunkAcceptable(current, revision)) return;
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
          // 同一 moveNumber の再送は既存行を使い回して候補手を入れ直す（行が二重に増えない）
          for (const { analysis, existingId } of resolveExistingMoveAnalyses(
            analyses,
            existing,
          )) {
            let moveAnalysisId = existingId;
            if (moveAnalysisId === null) {
              const [inserted] = await tx
                .insert(moveAnalyses)
                .values({
                  kifuId,
                  moveNumber: analysis.moveNumber,
                })
                .$returningId();
              moveAnalysisId = inserted.id;
            } else {
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
        const [{ stored }] = await tx
          .select({ stored: count() })
          .from(moveAnalyses)
          .where(eq(moveAnalyses.kifuId, kifuId));
        completed = isAnalysisComplete(stored, current.usiMoves);
        if (completed) {
          await tx
            .update(kifus)
            .set({ analysisCompletedAt: new Date() })
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
              const [result] = await tx
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
              await replaceTactics(tx, result.id, usiMoves);
        await replacePositions(tx, result.id, usiMoves);
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
