// 出題の一覧（`GET /api/drills`）・次の 1 問（`GET /api/drills/next`）・その問題の解答履歴
// （`GET /api/drills/:kifuNo/:moveNumber/:kind/attempts`）の絞り込み・並べ替え（prd/13 §5.4・§6.4）。
// DB 接続を持たない組み立てだけを置き、`drill-query.ts` から使う（単体テスト可能に保つため）。
import { and, asc, desc, eq, getTableName, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { drillAttempts, drills, kifus } from './db/schema.js';

/** 一覧は 1 ページ 50 件（棋譜一覧と揃える。prd/04 §6.1）。その問題の解答履歴も同じ件数で切る */
export const DRILL_PAGE_SIZE = 50;

/** 一覧の日付軸。棋譜一覧と同じ `coalesce(playedAt, createdAt)`（prd/13 §5.4） */
export const drillPlayedAt = sql`coalesce(${kifus.playedAt}, ${kifus.createdAt})`;

export const drillListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  kind: z.enum(['mate', 'best']).optional(),
  /**
   * 状態（prd/13 §7.7）。`wrong` / `correct` は**最後の記録の判定**で読む（§6.4「間違えた問題」）。
   * `excluded` は「自明だった」で外した問題だけ。それ以外の値では除外した問題を出さない
   */
  status: z.enum(['all', 'unanswered', 'wrong', 'correct', 'excluded']).default('all'),
});

export type DrillListQuery = z.infer<typeof drillListQuerySchema>;

/** 入口（prd/13 §6.4・§7.5） */
export const DRILL_MODES = ['recommend', 'mate', 'best', 'wrong'] as const;
export type DrillMode = (typeof DRILL_MODES)[number];

export const drillNextQuerySchema = z.object({
  mode: z.enum(DRILL_MODES).default('recommend'),
  /**
   * この回（prd/13 §7.6）の開始時刻。これ以降に記録のある問題は選ばない。
   * web は前の `/drills/next` が返した server の時刻（`now`）を渡す——端末の時計のずれで、この回の記録を取りこぼさないため
   */
  // ⚠ `z.coerce.date()` だと RPC の入力の型が Date になり、web から文字列で渡せない
  since: z
    .string()
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .optional(),
});

export type DrillNextQuery = z.infer<typeof drillNextQuerySchema>;

// --- 1 問ごとの集計（prd/13 §6.2・§6.4）---

/**
 * 解答回数。**判定を持つ行（`verdict` が null でない）を数える**（prd/13 §6.2）。
 * 「諦めて答えを見る」の行（`verdict='wrong'`・`move` が null）は解答として数え、
 * 除外だけの行（`verdict` が null）は数えない
 */
export const ANSWER_COUNT = sql<number>`count(case when ${drillAttempts.verdict} is not null then 1 end)`;
/** 「自明だった」の印（prd/13 §7.1）。1 つでも立っていれば除外 */
export const EXCLUDED_COUNT = sql<number>`count(case when ${drillAttempts.excluded} then 1 end)`;
/** 最終解答日時（諦めを含む。除外だけの行は含めない）。未解答なら null */
export const LAST_ANSWERED_AT = sql<
  Date | string | null
>`max(case when ${drillAttempts.verdict} is not null then ${drillAttempts.createdAt} end)`;
/**
 * 最後の記録の判定（prd/13 §6.4）。判定を持つ行のうち最新（同時刻は `id` の大きい方）。未解答なら null。
 * 🔒 「間違えた問題」「正解」はこれで読む——「一度でも正解したか」ではない（2026-10-23 改定）
 */
export const LAST_VERDICT = sql<
  'correct' | 'close' | 'wrong' | null
>`(array_agg(${drillAttempts.verdict} order by ${drillAttempts.createdAt} desc, ${drillAttempts.id} desc) filter (where ${drillAttempts.verdict} is not null))[1]`;

/**
 * 「間違えた問題」（prd/13 §6.4）: 解答があり、最後の判定が正解でない（`close` を含む・諦めは `wrong`）。
 * ⚠ 未解答では `LAST_VERDICT` が null なので、先に解答回数で切る（null との比較を真偽に混ぜない）
 */
export const IS_WRONG = sql`(${ANSWER_COUNT} > 0 and ${LAST_VERDICT} <> 'correct')`;
/** 正解（最後の判定が正解） */
export const IS_CORRECT = sql`(${ANSWER_COUNT} > 0 and ${LAST_VERDICT} = 'correct')`;
/** 間違えてから 1 日経っていない（おすすめに出さない。prd/13 §6.4）。「1 日」は最後の解答からの 24 時間 */
export const IS_RECENT_WRONG = sql`(${IS_WRONG} and ${LAST_ANSWERED_AT} > now() - interval '1 day')`;
/** 未解答 */
export const IS_UNANSWERED = sql`(${ANSWER_COUNT} = 0)`;
/** 除外していない */
export const NOT_EXCLUDED = sql`(${EXCLUDED_COUNT} = 0)`;

/** 状態（prd/13 §7.7）。除外は別の印（`excluded`）で持つ */
export function drillStatusOf(
  answers: number,
  lastVerdict: string | null,
): 'unanswered' | 'wrong' | 'correct' {
  if (answers === 0 || lastVerdict === null) return 'unanswered';
  return lastVerdict === 'correct' ? 'correct' : 'wrong';
}

/**
 * 日時を常に ISO 文字列で返す（`sql` 断片の戻りはドライバ依存で Date とは限らない）。
 *
 * 🔴 `sql` 断片の戻り値には**列の日時変換が適用されない**——node-postgres（drizzle が
 * `timestamptz` の型変換を切っている）は Postgres の文字列表記（`2026-09-10 12:00:00.123456+09`）
 * をそのまま返す。**オフセットは接続のセッションの時刻帯で付く**ので、必ずオフセットごと読む。
 * ⚠ オフセットの無い文字列は **UTC として読む**（`new Date('2026-09-10 12:00:00')` は
 * 実行環境のローカル時刻として解釈され、`TZ=Asia/Tokyo` の server では 9h ずれる。レビュー `OCL-94744330`）。
 */
export function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const trimmed = value.trim();
  const zone = /(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/.exec(trimmed);
  const normalized = trimmed.replace(' ', 'T');
  if (!zone) return new Date(`${normalized}Z`).toISOString();
  // Postgres は分の無いオフセット（`+09`）を返す。ISO 8601 の `+09:00` に揃えてから読む
  const withMinutes = /[+-]\d{2}$/.test(normalized) ? `${normalized}:00` : normalized;
  return new Date(withMinutes).toISOString();
}

/**
 * 一覧の絞り込み。**集計に対する条件なので `having` に置く**
 * （解答状況も除外の印も履歴側の集計から出る。prd/13 §6.2）。
 */
export function drillListHaving(query: DrillListQuery): SQL | undefined {
  if (query.status === 'excluded') return sql`${EXCLUDED_COUNT} > 0`;
  const conditions: SQL[] = [NOT_EXCLUDED];
  if (query.status === 'unanswered') conditions.push(IS_UNANSWERED);
  if (query.status === 'wrong') conditions.push(IS_WRONG);
  if (query.status === 'correct') conditions.push(IS_CORRECT);
  return and(...conditions);
}

/**
 * 一覧の並び。**対局日の新しい順だけ**（prd/13 §7.7。出題順の並びは外した）。
 * 同値は `drills.id` を副キーに添える（ページ間で行が重複・欠落しないため）
 */
export function drillListOrderBy(): SQL[] {
  return [desc(drillPlayedAt), desc(drills.id)];
}

/**
 * 次の 1 問の選び方（prd/13 §6.4）。`where`（行の条件）・`having`（集計の条件）・並びの組。
 *
 * - 🔒 **除外した問題はどの入口にも出さない**
 * - 🔒 **この回（`since` 以降）に記録した問題は出さない**（§7.6）。除外だけの行は記録に数えない
 * - おすすめ: ① 間違えてから 1 日以上 ② 直近 30 日の対局の未解答 ③ その他の未解答 ④ 正解済み（最後の解答が古い順）。
 *   空でない段から選び、段の中はランダム（④だけ古い順）。間違えた直後（1 日未満）はどの段にも入らない
 * - 詰将棋 / 次の一手: その種類の未解答（ランダム）
 * - 間違えた問題: 種類混在・最後の解答が古い順（1 日の待ちは掛けない）
 */
export function drillNextPlan(query: DrillNextQuery): {
  where: SQL | undefined;
  having: SQL | undefined;
  orderBy: SQL[];
} {
  const since = query.since
    ? sql`count(case when ${drillAttempts.verdict} is not null and ${drillAttempts.createdAt} >= ${query.since.toISOString()} then 1 end) = 0`
    : undefined;
  const random = sql`random()`;
  switch (query.mode) {
    case 'mate':
    case 'best':
      return {
        where: eq(drills.kind, query.mode),
        having: and(NOT_EXCLUDED, since, IS_UNANSWERED),
        orderBy: [random],
      };
    case 'wrong':
      return {
        where: undefined,
        having: and(NOT_EXCLUDED, since, IS_WRONG),
        orderBy: [asc(LAST_ANSWERED_AT), random],
      };
    case 'recommend':
      return {
        where: undefined,
        having: and(NOT_EXCLUDED, since, sql`not ${IS_RECENT_WRONG}`),
        orderBy: [
          sql`case
            when ${IS_WRONG} then 0
            when ${IS_UNANSWERED} and ${drillPlayedAt} >= now() - interval '30 days' then 1
            when ${IS_UNANSWERED} then 2
            else 3 end`,
          // ④（正解済み）だけ最後の解答が古い順。ほかの段では null で揃い、ランダムに落ちる
          sql`case when ${IS_CORRECT} then ${LAST_ANSWERED_AT} end asc`,
          random,
        ],
      };
  }
}

/**
 * その解答が**その問題の何回目か**（prd/13 §7.7）。除外だけの行（`verdict` が null）は数えない（諦めは数える）。
 *
 * 🔴 **`alias()` したテーブルを `sql` テンプレートに差し込まない**（実際に踏んだ）。
 * 選択リストの中では**別名だけが出力されて元のテーブル名が消える**ため、
 * `Table 'prior_attempts' doesn't exist` で 500 になる。
 * 🔒 **識別子はスキーマから組み立てる**——手書きの文字列にすると列名を変えたときに黙って壊れる。
 * ⚠ **外側の参照も明示的に修飾する**。修飾を落とすと副問い合わせの内側の同名列に解決され、
 * **相関が消えて常に真になる**（エラーにならないまま数字だけが狂う）。
 */
export const ATTEMPT_NO = sql<number>`${sql.raw(
  (() => {
    const table = getTableName(drillAttempts);
    const outer = (column: { name: string }) => `"${table}"."${column.name}"`;
    const inner = (column: { name: string }) => `"prior"."${column.name}"`;
    return `(select count(*) from "${table}" "prior"
      where ${inner(drillAttempts.drillId)} = ${outer(drillAttempts.drillId)}
        and ${inner(drillAttempts.verdict)} is not null
        and ${inner(drillAttempts.id)} <= ${outer(drillAttempts.id)})`;
  })(),
)}`;

/** 解答履歴の並び。**新しい順**で、同値は `id` 降順 */
export function drillAttemptOrderBy(): SQL[] {
  return [desc(drillAttempts.createdAt), desc(drillAttempts.id)];
}
