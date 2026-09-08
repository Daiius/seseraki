/**
 * 出題の取り出し（prd/13 §6.3 / §7）。
 *
 * 🔴 **答えを含む列（`answerMove` / `candidates` / `playedMove`）は出題時に返さない。**
 * クライアントへ渡した時点で答えが見えているのと同じで、`/drills` を専用ページにした
 * 意味（prd/13 §7）が消える。返すのは**盤面と問いだけ**。
 */
import { and, eq, sql } from 'drizzle-orm';
import { buildPositions, positionSfen } from 'shared';
import { db } from './db';
import { drillAttempts, drills, kifus } from './db/schema';
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
    verdict: 'correct' | 'close' | 'wrong' | null;
    lossCp: number | null;
    excluded?: boolean;
  },
): Promise<void> {
  await tx.insert(drillAttempts).values({
    drillId: attempt.drillId,
    move: attempt.move,
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
