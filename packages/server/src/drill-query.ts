/**
 * 出題の取り出し（prd/13 §6.3 / §7）。
 *
 * 🔴 **答えを含む列（`answerMove` / `candidates` / `playedMove`）は出題時に返さない。**
 * クライアントへ渡した時点で答えが見えているのと同じで、`/drills` を専用ページにした
 * 意味（prd/13 §7）が消える。返すのは**盤面と問いだけ**。
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { buildPositions, positionSfen, usiToJapaneseWithPiece, type BoardState } from 'shared';
import { db } from './db';
import { drillAttempts, drills, kifus } from './db/schema';
import {
  ANSWER_COUNT,
  ATTEMPT_NO,
  CORRECT_COUNT,
  DRILL_PAGE_SIZE,
  EXCLUDED_COUNT,
  LAST_ANSWERED_AT,
  drillAttemptOrderBy,
  drillAttemptWhere,
  drillListHaving,
  drillListOrderBy,
  isoOf,
  type DrillAttemptQuery,
  type DrillListQuery,
} from './drill-list-query';
import { stateOfAnswer } from './drill-answer';
import type { Tx } from './tactics';

/** 出題 1 問（クライアントに返す形。**答えは含まない**） */
export interface DrillQuestion {
  id: number;
  kind: 'mate' | 'best';
  /** 出題局面（正規化 SFEN）。盤面はこれだけから描ける */
  sfen: string;
  /** engine の詰み距離（plies）。`kind='mate'` のときだけ。⚠ 詰将棋の「N手詰」ではない */
  matePlies: number | null;
  /** 過去に間違えた問題か（「以前間違えた」のラベルを出す。prd/13 §6.3） */
  wrongBefore: boolean;
}

/** 出題順の段（prd/13 §6.3）。**未出題 > 間違えた > 正解済み** */
const TIER = sql`case
  when count(${drillAttempts.id}) = 0 then 0
  when sum(case when ${drillAttempts.verdict} = 'correct' then 1 else 0 end) = 0 then 1
  else 2 end`;

/**
 * 次の 1 問を選ぶ。段の中は**ランダム**。
 *
 * 🔒 **「自明だった」で除外された問題は出さない**（prd/13 §7）。除外は履歴側の列なので、
 * 出題を作り直しても残る。
 */
export async function pickNextDrill(
  ownerId: number,
  kind?: 'mate' | 'best',
): Promise<DrillQuestion | null> {
  const [row] = await db
    .select({
      id: drills.id,
      kind: drills.kind,
      moveNumber: drills.moveNumber,
      matePlies: drills.matePlies,
      usiMoves: kifus.usiMoves,
      wrongBefore: sql<number>`sum(case when ${drillAttempts.verdict} in ('wrong', 'close') then 1 else 0 end)`.mapWith(
        Number,
      ),
      excluded: sql<number>`sum(case when ${drillAttempts.excluded} then 1 else 0 end)`.mapWith(
        Number,
      ),
      tier: TIER.mapWith(Number),
    })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
    .where(and(eq(kifus.ownerId, ownerId), kind ? eq(drills.kind, kind) : undefined))
    .groupBy(drills.id, drills.kind, drills.moveNumber, drills.matePlies, kifus.usiMoves)
    .having(sql`sum(case when ${drillAttempts.excluded} then 1 else 0 end) = 0`)
    .orderBy(TIER, sql`rand()`)
    .limit(1);

  if (!row) return null;
  const sfen = drillSfen(row.usiMoves, row.moveNumber);
  if (!sfen) return null;
  return {
    id: row.id,
    kind: row.kind,
    sfen,
    matePlies: row.matePlies,
    wrongBefore: row.wrongBefore > 0,
  };
}

/**
 * 出題局面の正規化 SFEN を作る。指し手列が足りなければ `null`
 * （`usiMoves` を作り直した直後などに起こりうる。数字を捏造しない）。
 */
export function drillSfen(usiMoves: string[] | null, moveNumber: number): string | null {
  if (!usiMoves || moveNumber > usiMoves.length) return null;
  const state = buildPositions(usiMoves)[moveNumber];
  return state ? positionSfen(state) : null;
}

/** 採点に要る 1 問ぶん（**答えを含む**。server 内でしか使わない） */
export async function loadDrill(id: number, ownerId: number) {
  const [row] = await db
    .select({
      id: drills.id,
      kifuId: drills.kifuId,
      kind: drills.kind,
      reason: drills.reason,
      moveNumber: drills.moveNumber,
      answerMove: drills.answerMove,
      answerScoreType: drills.answerScoreType,
      answerScoreValue: drills.answerScoreValue,
      answerPv: drills.answerPv,
      candidates: drills.candidates,
      matePlies: drills.matePlies,
      playedMove: drills.playedMove,
      playedLossCp: drills.playedLossCp,
      usiMoves: kifus.usiMoves,
    })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .where(and(eq(drills.id, id), eq(kifus.ownerId, ownerId)));
  return row ?? null;
}

/** 解答を 1 件記録する（prd/13 §6.2） */
export async function recordAttempt(
  tx: Tx | typeof db,
  attempt: {
    drillId: number;
    move: string | null;
    /** 解答の手順（出題局面から・最後が `move`）。表記を作る盤面がこれで決まる（prd/13 §6.2） */
    line?: string[] | null;
    verdict: 'correct' | 'close' | 'wrong' | null;
    lossCp: number | null;
    excluded?: boolean;
  },
): Promise<void> {
  await tx.insert(drillAttempts).values({
    drillId: attempt.drillId,
    move: attempt.move,
    line: attempt.line ?? null,
    verdict: attempt.verdict,
    lossCp: attempt.lossCp,
    excluded: attempt.excluded ?? false,
  });
}

/** 成績（prd/13 §7 の「初版では持たない」に備えた最小の数え方） */
export async function drillCounts(ownerId: number) {
  const [row] = await db
    .select({
      total: sql<number>`count(distinct ${drills.id})`.mapWith(Number),
      answered: sql<number>`count(distinct case when ${drillAttempts.move} is not null then ${drills.id} end)`.mapWith(
        Number,
      ),
      correct: sql<number>`count(distinct case when ${drillAttempts.verdict} = 'correct' then ${drills.id} end)`.mapWith(
        Number,
      ),
    })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
    .where(eq(kifus.ownerId, ownerId));
  return row ?? { total: 0, answered: 0, correct: 0 };
}

/**
 * 一覧から名指しで開いた 1 問（prd/13 §5.4）。**返す形は `/drills/next` と同じ**で、
 * 答えは含まない。🔒 **除外した問題も返す**——出題順（prd/13 §6.3）の除外とは別の話で、
 * 一覧から明示的に開いた問題を「無い」と言うのは筋が通らない。
 */
export async function loadDrillQuestion(
  id: number,
  ownerId: number,
): Promise<DrillQuestion | null> {
  const [row] = await db
    .select({
      id: drills.id,
      kind: drills.kind,
      moveNumber: drills.moveNumber,
      matePlies: drills.matePlies,
      usiMoves: kifus.usiMoves,
      wrongBefore: sql<number>`sum(case when ${drillAttempts.verdict} in ('wrong', 'close') then 1 else 0 end)`.mapWith(
        Number,
      ),
    })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
    .where(and(eq(drills.id, id), eq(kifus.ownerId, ownerId)))
    .groupBy(drills.id, drills.kind, drills.moveNumber, drills.matePlies, kifus.usiMoves);

  if (!row) return null;
  const sfen = drillSfen(row.usiMoves, row.moveNumber);
  if (!sfen) return null;
  return {
    id: row.id,
    kind: row.kind,
    sfen,
    matePlies: row.matePlies,
    wrongBefore: row.wrongBefore > 0,
  };
}

/**
 * 問題の一覧（prd/13 §7.2）。**1 問 1 行**にまとめ、解答状況は履歴側の集計から出す。
 *
 * 🔴 **答えを含む列は返さない**（`answerMove` / `answerPv` / `candidates` / `playedMove`）。
 * ⚠ **棋譜名・手数は未解答の問題でも返す**（決定・2026-09-10。prd/13 §5.4）——伏せるのは
 * 解く画面の規則で、一覧は解く画面ではない。
 */
export async function listDrills(ownerId: number, query: DrillListQuery) {
  const where = and(
    eq(kifus.ownerId, ownerId),
    query.kind ? eq(drills.kind, query.kind) : undefined,
  );
  const having = drillListHaving(query);

  // 件数は**同じ条件で数える**（prd/04 §6.1 と同じ姿勢）。集計に対する条件なので、
  // 絞り込み済みの行を副問い合わせにしてから数える
  const grouped = db
    .select({ id: drills.id })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
    .where(where)
    .groupBy(drills.id)
    .having(having)
    .as('grouped');
  const [totals] = await db.select({ total: count() }).from(grouped);
  const total = totals?.total ?? 0;

  const rows = await db
    .select({
      id: drills.id,
      kind: drills.kind,
      moveNumber: drills.moveNumber,
      matePlies: drills.matePlies,
      kifuId: drills.kifuId,
      title: kifus.title,
      playedAt: kifus.playedAt,
      kifuCreatedAt: kifus.createdAt,
      answers: ANSWER_COUNT.mapWith(Number),
      correct: CORRECT_COUNT.mapWith(Number),
      excludedCount: EXCLUDED_COUNT.mapWith(Number),
      lastAnsweredAt: LAST_ANSWERED_AT,
    })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
    .where(where)
    .groupBy(
      drills.id,
      drills.kind,
      drills.moveNumber,
      drills.matePlies,
      drills.kifuId,
      kifus.title,
      kifus.playedAt,
      kifus.createdAt,
    )
    .having(having)
    .orderBy(...drillListOrderBy(query))
    .limit(DRILL_PAGE_SIZE)
    .offset((query.page - 1) * DRILL_PAGE_SIZE);

  return {
    drills: rows.map(({ excludedCount, lastAnsweredAt, ...row }) => ({
      ...row,
      excluded: excludedCount > 0,
      lastAnsweredAt: isoOf(lastAnsweredAt),
      // 解答状況は 3 段（prd/13 §6.3 の段と同じ読み方）
      status: row.answers === 0 ? ('unanswered' as const)
        : row.correct > 0 ? ('correct' as const)
        : ('wrong' as const),
    })),
    pagination: {
      page: query.page,
      totalPages: Math.ceil(total / DRILL_PAGE_SIZE),
      total,
    },
  };
}

/**
 * 解答履歴の一覧（prd/13 §7.3）。**1 行 1 解答**で新しい順。
 *
 * 🔒 **同じ問題の複数回はまとめない**——間違えた後に正解した経過が読めなくなる。
 * ⚠ **「自明だった」の行（`move` / `verdict` が null）も出す**（prd/13 §6.2）。
 */
export async function listDrillAttempts(ownerId: number, query: DrillAttemptQuery) {
  const where = drillAttemptWhere(ownerId, query);

  const [totals] = await db
    .select({ total: count() })
    .from(drillAttempts)
    .innerJoin(drills, eq(drills.id, drillAttempts.drillId))
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .where(where);
  const total = totals?.total ?? 0;

  const rows = await db
    .select({
      id: drillAttempts.id,
      drillId: drillAttempts.drillId,
      move: drillAttempts.move,
      verdict: drillAttempts.verdict,
      lossCp: drillAttempts.lossCp,
      excluded: drillAttempts.excluded,
      line: drillAttempts.line,
      createdAt: drillAttempts.createdAt,
      kind: drills.kind,
      moveNumber: drills.moveNumber,
      kifuId: drills.kifuId,
      title: kifus.title,
      playedAt: kifus.playedAt,
      usiMoves: kifus.usiMoves,
      // その問題の何回目の解答か（除外だけの行は数えない。prd/13 §6.2）
      attemptNo: ATTEMPT_NO.mapWith(Number),
    })
    .from(drillAttempts)
    .innerJoin(drills, eq(drills.id, drillAttempts.drillId))
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .where(where)
    .orderBy(...drillAttemptOrderBy())
    .limit(DRILL_PAGE_SIZE)
    .offset((query.page - 1) * DRILL_PAGE_SIZE);

  // 日本語表記は**盤面が要る**（`shared` の `board.ts`）。履歴の画面は盤を持たないので
  // server 側で作る。同じ棋譜が並ぶことが多いため局面列は棋譜ごとに 1 度だけ作る
  const positions = new Map<number, BoardState[] | null>();
  const stateOf = (kifuId: number, usiMoves: string[] | null, moveNumber: number) => {
    if (!positions.has(kifuId)) positions.set(kifuId, usiMoves ? buildPositions(usiMoves) : null);
    return positions.get(kifuId)?.[moveNumber] ?? null;
  };

  return {
    attempts: rows.map(({ usiMoves, move, line, ...row }) => {
      const base = move ? stateOf(row.kifuId, usiMoves, row.moveNumber) : null;
      // 🔴 **表記を作る盤面は「その手を指した局面」**（prd/13 §5.4・レビュー `OCL-A1E622FE`）。
      // 詰将棋は指し継ぎなので、出題局面から読むと**駒名が欠ける・別の駒として表示される**
      const state = base && move ? stateOfAnswer(base, line, move, row.kind) : null;
      return {
        ...row,
        move,
        // 盤面を作れない行（`line` を持たない既存の詰将棋・作り直した `usiMoves`）は
        // **USI のまま出す**——復元できない表記を作らない
        moveText: state && move ? usiToJapaneseWithPiece(state, move) : move,
        attemptNo: move ? row.attemptNo : null,
      };
    }),
    pagination: {
      page: query.page,
      totalPages: Math.ceil(total / DRILL_PAGE_SIZE),
      total,
    },
  };
}

/**
 * 「自明だった」の取り消し（prd/13 §7.2）。
 *
 * 🔒 **除外の行そのものを消す**——印を取り消す操作なので、印を残さない。
 * 解答の行（`move` を持つ行）は触らないので、**解答履歴は消えない**。
 */
export async function unexcludeDrill(drillId: number): Promise<void> {
  await db
    .delete(drillAttempts)
    .where(and(eq(drillAttempts.drillId, drillId), eq(drillAttempts.excluded, true)));
}
