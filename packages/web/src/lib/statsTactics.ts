/**
 * 分析ページ（`/stats`）の表示ロジック（prd/09 §2.3・§2.4・§3・§4・§5）。
 *
 * server は**平坦な行**を返し、階層・並べ替え・率の整形はここで行う（prd/09 §6）。
 * 木の形を API の応答に焼き付けないため、`IMPLIES` は `shared` から読む
 * （判定を更新したら木も自動で変わる）。
 *
 * ⚠ **ここに集計は無い。** 局数・勝率・取りこぼしはすべて server の SQL が出したもので、
 * この層は並べ替えと整形しかしない（生ラベルで数える約束が web 側で崩れないように）。
 */

import { IMPLIES, type Attribution } from 'shared';

/** `GET /api/stats/tactics` が返す 1 行（prd/09 §6） */
export interface StatsTacticRow {
  label: string;
  attribution: Attribution;
  games: number;
  wins: number;
  senteGames: number;
  senteWins: number;
  goteGames: number;
  goteWins: number;
  /** 解析済みの負け局（取りこぼしの分母。勝率とは分母が違う。prd/09 §3.1） */
  analyzedLosses: number;
  missedMateLosses: number;
}

/** 階層の深さを付けた表示用の行。インデントに使う */
export interface StatsTreeRow extends StatsTacticRow {
  depth: number;
}

/** 除外の内訳（prd/09 §4） */
export interface StatsExcluded {
  ambiguousSelf: number;
  draw: number;
  unknownResult: number;
}

export const STATS_SORTS = ['games', 'winRate'] as const;
export const STATS_ORDERS = ['asc', 'desc'] as const;
export type StatsSort = (typeof STATS_SORTS)[number];
export type StatsOrder = (typeof STATS_ORDERS)[number];

export const DEFAULT_STATS_SORT: StatsSort = 'games';
export const DEFAULT_STATS_ORDER: StatsOrder = 'desc';

/**
 * これ未満の局数の行を淡色にする目安（prd/09 §2.4）。
 *
 * ⚠ **表示だけの定数で、集計にも並びにも効かない。** 行を隠したりまとめたりはしない
 * （n=1 で 100% の行が上に来るのを防ぐのは既定の並び＝局数降順の役目）。
 */
export const LOW_SAMPLE_GAMES = 5;

/** 率。分母が 0 なら `null`（「0%」と「該当なし」は違う） */
export function rate(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** 率の表示。該当なしは `−`（ハイフンではなく全角のダッシュ） */
export function formatRate(value: number | null): string {
  return value === null ? '−' : `${(value * 100).toFixed(1)}%`;
}

/**
 * `IMPLIES` を上へ辿り、**行として存在する最も近い祖先**を返す。
 *
 * 中間のラベルが行に無いことがある（相手側に `石田流` は立ったが `三間飛車` の行が
 * 期間の絞り込みで落ちた等）。そのとき `石田流` を根に置くと `振り飛車` との包含関係が
 * 表から読めなくなるので、存在する祖先まで繰り上げて繋ぐ。
 */
export function nearestPresentAncestor(
  label: string,
  present: ReadonlySet<string>,
): string | null {
  const queue = [...(IMPLIES[label] ?? [])];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (present.has(current)) return current;
    for (const next of IMPLIES[current] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return null;
}

/** 並べ替えの基準値。勝率は分母 0 を `-1` に寄せて末尾へ送る（行の勝率は分母 > 0 だが念のため） */
function sortValue(row: StatsTacticRow, sort: StatsSort): number {
  return sort === 'games' ? row.games : (rate(row.wins, row.games) ?? -1);
}

/**
 * 同順位はラベルの昇順で決めて安定させる（server の既定の並びと同じ考え方）。
 *
 * ⚠ **`localeCompare` を使わない。** ロケール依存の並びは環境で変わりうるので、
 * 「同じデータなら同じ順序」を優先してコードポイント順にする。
 */
function compareRows(sort: StatsSort, order: StatsOrder) {
  const sign = order === 'desc' ? -1 : 1;
  return (a: StatsTacticRow, b: StatsTacticRow): number => {
    const diff = (sortValue(a, sort) - sortValue(b, sort)) * sign;
    if (diff !== 0) return diff;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  };
}

/**
 * 平坦な行を `IMPLIES` の親子に組み、深さ付きの表示順に並べ直す（prd/09 §2.3・§2.4）。
 *
 * **親の局数は子を含む包含関係であり、子の合計ではない**（生ラベルで数えているため）。
 * 並べ替えは**階層内**（兄弟どうし）で行い、親子関係は並べ替えても崩れない。
 */
export function buildTacticTree(
  rows: readonly StatsTacticRow[],
  sort: StatsSort = DEFAULT_STATS_SORT,
  order: StatsOrder = DEFAULT_STATS_ORDER,
): StatsTreeRow[] {
  const present = new Set(rows.map((r) => r.label));
  const children = new Map<string | null, StatsTacticRow[]>();
  for (const row of rows) {
    const parent = nearestPresentAncestor(row.label, present);
    const siblings = children.get(parent);
    if (siblings) siblings.push(row);
    else children.set(parent, [row]);
  }

  const compare = compareRows(sort, order);
  const emitted = new Set<string>();
  const out: StatsTreeRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const row of [...(children.get(parent) ?? [])].sort(compare)) {
      if (emitted.has(row.label)) continue;
      emitted.add(row.label);
      out.push({ ...row, depth });
      walk(row.label, depth + 1);
    }
  };
  walk(null, 0);

  // `IMPLIES` に循環があると根から辿り着けない行が出る（現状の定義には無いが、
  // **行が黙って消えると集計を誤読する**ので根に出して気づけるようにする）
  const orphans = rows.filter((r) => !emitted.has(r.label)).sort(compare);
  return [...out, ...orphans.map((r) => ({ ...r, depth: 0 }))];
}

/**
 * 除外の内訳（prd/09 §4）。0 件の理由は書かない（読むべきものだけを出す）。
 * 何も除外されていなければ空文字。
 */
export function describeExcluded(excluded: StatsExcluded): string {
  const parts: string[] = [];
  if (excluded.ambiguousSelf > 0) parts.push(`自分未確定 ${excluded.ambiguousSelf}`);
  if (excluded.draw > 0) parts.push(`引き分け ${excluded.draw}`);
  if (excluded.unknownResult > 0) parts.push(`結果不明 ${excluded.unknownResult}`);
  return parts.join('・');
}

/** 除外の合計。「対象 N 局 / 除外 M 局」の M */
export function totalExcluded(excluded: StatsExcluded): number {
  return excluded.ambiguousSelf + excluded.draw + excluded.unknownResult;
}

export const PERIOD_PRESETS = ['all', '1y', '3m'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  all: '全期間',
  '1y': '直近 1 年',
  '3m': '直近 3 ヶ月',
};

export interface PeriodRange {
  from?: string;
  to?: string;
}

/** `YYYY-MM-DD`（ローカル日付。`<input type="date">` と同じ見え方にする） */
function toIsoDate(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * プリセットを `from` / `to` に落とす（prd/09 §5）。
 *
 * **「直近」の解釈は web が持つ**（server は日付の両端だけを受ける。prd/09 §6.0）。
 * 上端は開けたままにする——未来日の対局は無いので `to` を今日に閉じても件数は変わらず、
 * 日付をまたいだときに URL が古くなるだけになる。
 */
export function periodRange(preset: PeriodPreset, today: Date): PeriodRange {
  if (preset === 'all') return {};
  const from = new Date(today);
  if (preset === '1y') from.setFullYear(from.getFullYear() - 1);
  else from.setMonth(from.getMonth() - 3);
  return { from: toIsoDate(from) };
}

/**
 * 現在の `from` / `to` がどのプリセットに当たるか。当たらなければ `null`（＝カスタム）。
 * URL 直入力やカスタム入力のあとでも、セレクトの表示が実際の条件と食い違わないようにする。
 */
export function presetOf(range: PeriodRange, today: Date): PeriodPreset | null {
  for (const preset of PERIOD_PRESETS) {
    const candidate = periodRange(preset, today);
    if (candidate.from === range.from && candidate.to === range.to) return preset;
  }
  return null;
}
