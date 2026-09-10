// 出題の一覧（`GET /api/drills`）と解答履歴（`GET /api/drills/attempts`）の
// 絞り込み・並べ替え（prd/13 §5.4）。
// DB 接続を持たない組み立てだけを置き、`drill-query.ts` から使う（単体テスト可能に保つため）。
import { and, asc, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { drillAttempts, drills, kifus } from './db/schema.js';

/** 一覧・履歴とも 1 ページ 50 件（棋譜一覧と揃える。prd/04 §6.1） */
export const DRILL_PAGE_SIZE = 50;

/** 一覧の日付軸。棋譜一覧と同じ `coalesce(playedAt, createdAt)`（prd/13 §5.4） */
export const drillPlayedAt = sql`coalesce(${kifus.playedAt}, ${kifus.createdAt})`;

export const drillListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  kind: z.enum(['mate', 'best']).optional(),
  /** 解答状況。`wrong` は**まだ正解していない**問題（prd/13 §6.3 の 2 段目と同じ母集団） */
  status: z.enum(['all', 'unanswered', 'wrong', 'correct']).default('all'),
  /** 「自明だった」で外した問題（prd/13 §7.2）。既定では出さない */
  excluded: z.enum(['hide', 'only']).default('hide'),
  /** `played` は対局日の降順（既定）、`status` は出題順の段（prd/13 §6.3） */
  sort: z.enum(['played', 'status']).default('played'),
});

export type DrillListQuery = z.infer<typeof drillListQuerySchema>;

export const drillAttemptQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  kind: z.enum(['mate', 'best']).optional(),
  /** `excluded` は「自明だった」の行（`move` / `verdict` が null。prd/13 §6.2） */
  verdict: z.enum(['all', 'correct', 'close', 'wrong', 'excluded']).default('all'),
});

export type DrillAttemptQuery = z.infer<typeof drillAttemptQuerySchema>;

// --- 一覧の集計（1 問 1 行にまとめる。prd/13 §7.2）---

/** 解答回数。**除外だけの行（`move` が null）は数えない**（prd/13 §6.2） */
export const ANSWER_COUNT = sql<number>`count(case when ${drillAttempts.move} is not null then 1 end)`;
/** 正解した回数 */
export const CORRECT_COUNT = sql<number>`count(case when ${drillAttempts.verdict} = 'correct' then 1 end)`;
/** 「自明だった」の印（prd/13 §7.1）。1 つでも立っていれば除外 */
export const EXCLUDED_COUNT = sql<number>`count(case when ${drillAttempts.excluded} then 1 end)`;
/** 最終解答日時。未解答なら null */
export const LAST_ANSWERED_AT = sql<
  Date | string | null
>`max(case when ${drillAttempts.move} is not null then ${drillAttempts.createdAt} end)`;

/** 出題順の段（prd/13 §6.3）。**未出題 > 間違えた > 正解済み** */
export const DRILL_TIER = sql`case
  when ${ANSWER_COUNT} = 0 then 0
  when ${CORRECT_COUNT} = 0 then 1
  else 2 end`;

/**
 * 一覧の絞り込み。**集計に対する条件なので `having` に置く**
 * （解答状況も除外の印も履歴側の集計から出る。prd/13 §6.2）。
 */
export function drillListHaving(query: DrillListQuery): SQL | undefined {
  const conditions: SQL[] = [
    query.excluded === 'only' ? sql`${EXCLUDED_COUNT} > 0` : sql`${EXCLUDED_COUNT} = 0`,
  ];
  if (query.status === 'unanswered') conditions.push(sql`${ANSWER_COUNT} = 0`);
  if (query.status === 'wrong') {
    conditions.push(sql`${ANSWER_COUNT} > 0`, sql`${CORRECT_COUNT} = 0`);
  }
  if (query.status === 'correct') conditions.push(sql`${CORRECT_COUNT} > 0`);
  return and(...conditions);
}

/** 一覧の並び。**同値は `drills.id` を副キーに添える**（ページ間で行が重複・欠落しないため） */
export function drillListOrderBy(query: DrillListQuery): SQL[] {
  const tail = [desc(drillPlayedAt), desc(drills.id)];
  return query.sort === 'status' ? [asc(DRILL_TIER), ...tail] : tail;
}

/** 履歴の絞り込み（prd/13 §7.3） */
export function drillAttemptWhere(ownerId: number, query: DrillAttemptQuery): SQL | undefined {
  return and(
    eq(kifus.ownerId, ownerId),
    query.kind ? eq(drills.kind, query.kind) : undefined,
    query.verdict === 'excluded'
      ? eq(drillAttempts.excluded, true)
      : query.verdict === 'all'
        ? undefined
        : and(eq(drillAttempts.verdict, query.verdict), isNotNull(drillAttempts.move)),
  );
}

/** 履歴の並び。**新しい順**で、同値は `id` 降順（prd/13 §5.4） */
export function drillAttemptOrderBy(): SQL[] {
  return [desc(drillAttempts.createdAt), desc(drillAttempts.id)];
}
