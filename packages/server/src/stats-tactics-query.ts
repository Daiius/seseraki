// 戦型別成績（`GET /api/stats/tactics`）の集計 SQL の組み立て（prd/09）。
// 一覧（`kifu-list-query.ts`）と同じく DB 接続を持たない純粋な組み立てだけを置き、route.ts から使う。
//
// ⚠ **自分の側の判定・取りこぼしの述語は一覧と共有する**（`kifu-list-query.ts` から import）。
// 同じ意味論が 2 か所にあると片方だけ直る。
import { and, desc, eq, inArray, isNull, not, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { NON_SIDE_ATTRIBUTED_LABELS } from 'shared';
import { kifuTactics, kifus } from './db/schema.js';
import {
  alwaysTrue,
  analyzedCondition,
  bySelfSide,
  missedMateCondition,
  ownGamesOnly,
  parseSelfNames,
  periodConditions,
} from './kifu-list-query.js';

export const statsTacticsQuerySchema = z.object({
  // 自分の名前候補（カンマ区切り）。「自分」の定義は web の
  // `VITE_SELF_NAMES` ∪ `VITE_SWARS_USER_ID` が単一の正で、server は設定を持たない
  // （一覧の `outcome` 絞り込みと同じ扱い。prd/09 §4）
  self: z.string().optional(),
  /** 取りこぼしと見なす詰み手数の上限（prd/09 §3.1）。既定 10 */
  mateMax: z.coerce.number().int().min(1).max(99).default(10),
  /** 期間の下限・上限（`YYYY-MM-DD`・両端を含む）。基準は一覧と同じ `playedOrCreatedAt` */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type StatsTacticsQuery = z.infer<typeof statsTacticsQuerySchema>;

/** 引き分けの結果コード（prd/09 §4）。指し直しになるものを勝敗として数えない */
const DRAW_RESULTS = ['DRAW_REPETITION', 'DRAW_IMPASSE'];

/** 条件を満たす行を数える。`sum()` は行が無いと null になるので 0 に寄せる */
function countIf(condition: SQL): SQL<number> {
  return sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`.mapWith(
    Number,
  );
}

/** 自分の側が確定していること（両者一致 / どちらも一致しない対局を外す） */
function selfDetermined(names: string[]): SQL {
  return bySelfSide(names, () => alwaysTrue);
}

/**
 * **対象局**（prd/09 §4）: 自分の側が確定し、かつ勝敗がついた対局。
 * `s.won` / `s.lost` は `%SENTE_WIN%` / `%GOTE_WIN%` の部分一致なので、
 * 引き分け（`DRAW_*`）と `result` が null はここで自動的に落ちる。
 */
function targetGame(names: string[]): SQL {
  return bySelfSide(names, (s) => or(s.won, s.lost)!);
}

/**
 * 期間の絞り込みだけ（除外の内訳を数える母集団）。
 *
 * 🔒 **動画解析はここでも外す**（prd/10 §2.2）。`targetGame` は勝敗のついた対局に絞るので
 * 行の集計からは自動的に落ちるが、**総局数と除外の内訳はこの母集団で数える**ため、
 * ここを外し忘れると動画解析が `ambiguousSelf` に積み上がって総局数が膨らむ。
 */
export function statsTacticsPeriodWhere(query: StatsTacticsQuery): SQL {
  return and(ownGamesOnly(), ...periodConditions(query.from, query.to))!;
}

/** 行の集計対象（期間 かつ 対象局）。名前候補が空なら `1 = 0` で 0 件になる */
export function statsTacticsWhere(query: StatsTacticsQuery): SQL {
  const names = parseSelfNames(query.self);
  return and(
    ownGamesOnly(),
    ...periodConditions(query.from, query.to),
    targetGame(names),
  )!;
}

/**
 * 総局数と除外の内訳（prd/09 §4）。**期間内の全局を 4 つに分割する**ので、
 * 引き分けと結果不明には「自分の側が確定していること」を掛けて二重計上を避ける
 * （優先順は 自分未確定 → 引き分け → 結果不明）。
 *
 * **名前候補が空なら期間内の全局が `ambiguousSelf` に落ちる**（自分が決まらなければ
 * 何も集計できない。一覧が 0 件にするのと同じ立場。prd/09 §6）。
 */
export function statsTacticsSummarySelect(query: StatsTacticsQuery) {
  const names = parseSelfNames(query.self);
  const determined = selfDetermined(names);
  return {
    totalGames: countIf(targetGame(names)),
    ambiguousSelf: countIf(not(determined)),
    draw: countIf(and(determined, inArray(kifus.result, DRAW_RESULTS))!),
    unknownResult: countIf(and(determined, isNull(kifus.result))!),
  };
}

/**
 * `kifus` と `kifu_tactics` の結合条件（prd/09 §6）。
 *
 * ⚠ **生ラベルで数える。`suppressForDisplay` は掛けない**（prd/09 §2.1）。含意ラベルを畳むと
 * `振り飛車` の行がほぼ常に消え、このページの動機そのものが消える。
 *
 * 主軸は「相手が何を採ったか」なので手番固有ラベルは**相手側**に立ったものだけを取り、
 * 帰属が `side` でないラベル（角換わり・相掛かり）は `side` を見ずに 1 行として数える
 * （`side` の意味が変わるため。prd/09 §2.2・§6.1）。ラベル一覧は `shared` の公開 export から取る。
 *
 * 主キーが `(kifuId, side, label)` なので、この条件で拾える行は 1 局 1 ラベルにつき高々 1 行。
 * よって `count(*)` がそのまま局数になる。
 */
export function statsTacticsJoinOn(query: StatsTacticsQuery): SQL {
  const names = parseSelfNames(query.self);
  return and(
    eq(kifuTactics.kifuId, kifus.id),
    or(
      bySelfSide(names, (s) => eq(kifuTactics.side, s.opponent)),
      inArray(kifuTactics.label, [...NON_SIDE_ATTRIBUTED_LABELS]),
    )!,
  )!;
}

/**
 * 行の列（prd/09 §3）。先手時 / 後手時は**ページ全体のフィルタにせず列として並置する**ため、
 * 条件付き集計で 1 クエリに収める（prd/09 §6）。
 *
 * `analyzedLosses` / `missedMateLosses` は勝率とは分母が違う（解析済みの負け局）。
 */
export function statsTacticsRowsSelect(query: StatsTacticsQuery) {
  const names = parseSelfNames(query.self);
  const analyzed = analyzedCondition();
  return {
    label: kifuTactics.label,
    games: sql<number>`count(*)`.mapWith(Number),
    wins: countIf(bySelfSide(names, (s) => s.won)),
    senteGames: countIf(bySelfSide(names, () => alwaysTrue, 'sente')),
    senteWins: countIf(bySelfSide(names, (s) => s.won, 'sente')),
    goteGames: countIf(bySelfSide(names, () => alwaysTrue, 'gote')),
    goteWins: countIf(bySelfSide(names, (s) => s.won, 'gote')),
    analyzedLosses: countIf(and(analyzed, bySelfSide(names, (s) => s.lost))!),
    // 取りこぼし（prd/09 §3.1）。負け条件を内包する述語なので一覧の `missedMate` と同じものを使う
    missedMateLosses: countIf(and(analyzed, missedMateCondition(query.mateMax, names))!),
  };
}

/**
 * 並び。既定は局数降順（prd/09 §2.4）で、同数はラベル名で決めて安定させる。
 *
 * ⚠ **階層は組まない。** `IMPLIES` は `shared` にあるので web 側で組む（prd/09 §6）。
 * 木の形を API の応答に焼き付けない（判定を更新したら木が変わる）。
 */
export function statsTacticsOrderBy(): SQL[] {
  return [desc(sql`count(*)`), sql`${kifuTactics.label} asc`];
}
