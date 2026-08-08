/**
 * 棋譜一覧（`/`）の絞り込み・並べ替えの許可値と、効いている条件の要約。
 *
 * 要約はフィルタバーを畳んだままの `summary` に出すためのもので、
 * 「なぜ件数が少ないのか」を開かずに読めるようにする（`prd/05-analysis.md` §2.5）。
 */

import { NON_SIDE_ATTRIBUTED_LABELS, STORED_TACTIC_LABELS } from 'shared';

// 値は server 側の zod スキーマ（`GET /api/kifus`）と揃える
export const STATUSES = ['all', 'analyzed', 'unanalyzed', 'failed'] as const;
// `decided` は「勝敗がついた」。分析ページの対象局（prd/09 §4）と同じ母集団を指し、
// 表からのドリルダウンで件数が一致するようにするために要る（指摘 OCL-35520A6B）
export const OUTCOMES = ['all', 'win', 'loss', 'decided'] as const;
export const TACTIC_SIDES = ['self', 'opponent', 'any'] as const;
export const SORTS = ['playedAt', 'createdAt', 'title'] as const;
export const ORDERS = ['asc', 'desc'] as const;

export type Status = (typeof STATUSES)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type TacticSide = (typeof TACTIC_SIDES)[number];
export type Sort = (typeof SORTS)[number];
export type Order = (typeof ORDERS)[number];

export const DEFAULT_SORT: Sort = 'playedAt';
export const DEFAULT_ORDER: Order = 'desc';
export const DEFAULT_TACTIC_SIDE: TacticSide = 'any';

/**
 * 戦型セレクトの選択肢。**語彙は `shared` から取る**（判定にラベルが増えたら自動で増える）。
 * 役割ラベルは保存されないので `STORED_TACTIC_LABELS` の時点で除かれている（prd/09 §6.1）。
 */
export const TACTIC_OPTIONS: readonly string[] = STORED_TACTIC_LABELS;

/**
 * そのラベルで「自分 / 相手」の絞り込みが意味を持つか。
 *
 * ⚠ **帰属が `side` でないラベル（角換わり・相掛かり）では持たない**（prd/03 §2.1.1）。
 * 角換わりの `side` は「持ち込んだ側」で双方がその戦型、相掛かりは `both` の 1 行しか無いので、
 * 側で絞ると別の問いになる。server も同じ判断で `side` を見ずに絞る（prd/09 §6.1）ので、
 * UI はトグルを無効化し、要約でも側を書かない。
 */
export function tacticSideApplies(tactic: string | undefined): boolean {
  return Boolean(tactic) && !NON_SIDE_ATTRIBUTED_LABELS.includes(tactic!);
}

const STATUS_LABELS: Record<Exclude<Status, 'all'>, string> = {
  analyzed: '解析済み',
  unanalyzed: '未解析',
  failed: '解析失敗',
};

const OUTCOME_LABELS: Record<Exclude<Outcome, 'all'>, string> = {
  win: '勝ち',
  loss: '負け',
  decided: '勝敗あり',
};

const TACTIC_SIDE_LABELS: Record<Exclude<TacticSide, 'any'>, string> = {
  self: '自分',
  opponent: '相手',
};

const SORT_LABELS: Record<Sort, string> = {
  playedAt: '対局日時',
  createdAt: '登録日時',
  title: 'タイトル',
};

export interface KifuListFilters {
  q?: string;
  status?: Status;
  outcome?: Outcome;
  tactic?: string;
  tacticSide?: TacticSide;
  /** 詰み手数の上限。指定時は「その手数以下の詰みを逃して落とした局」だけ（prd/09 §3.1） */
  missedMate?: number;
  from?: string;
  to?: string;
  sort?: Sort;
  order?: Order;
}

/** 絞り込みが効いているか。並べ替えは件数を変えないので含めない */
export function isFiltered({
  q,
  status,
  outcome,
  tactic,
  missedMate,
  from,
  to,
}: KifuListFilters): boolean {
  return Boolean(
    q ||
      (status && status !== 'all') ||
      (outcome && outcome !== 'all') ||
      tactic ||
      missedMate ||
      from ||
      to,
  );
}

/**
 * 効いている条件を `·` 区切りの 1 行にまとめる。何も効いていなければ空文字。
 * 並べ替えは既定（対局日時の降順）から変わっているときだけ添える。
 */
export function describeFilters({
  q,
  status,
  outcome,
  tactic,
  tacticSide = DEFAULT_TACTIC_SIDE,
  missedMate,
  from,
  to,
  sort = DEFAULT_SORT,
  order = DEFAULT_ORDER,
}: KifuListFilters): string {
  const parts: string[] = [];
  if (q) parts.push(`"${q}"`);
  if (status && status !== 'all') parts.push(STATUS_LABELS[status]);
  if (outcome && outcome !== 'all') parts.push(OUTCOME_LABELS[outcome]);
  if (tactic) {
    // 側で絞れないラベルは側を書かない（server も side を見ずに絞るため。要約が嘘にならないように）
    const side =
      tacticSide !== 'any' && tacticSideApplies(tactic)
        ? `${TACTIC_SIDE_LABELS[tacticSide]}: `
        : '';
    parts.push(`${side}${tactic}`);
  }
  if (missedMate) parts.push(`${missedMate}手詰以下の取りこぼし`);
  // 片側だけの指定も「どちら側が開いているか」が読めるように `〜` を残す
  if (from || to) parts.push(`${from ?? ''}〜${to ?? ''}`);
  if (sort !== DEFAULT_SORT || order !== DEFAULT_ORDER) {
    parts.push(`並び: ${SORT_LABELS[sort]} ${order === 'asc' ? '↑' : '↓'}`);
  }
  return parts.join(' · ');
}
