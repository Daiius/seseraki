/**
 * 棋譜一覧（`/`）の絞り込み・並べ替えの許可値と、効いている条件の要約。
 *
 * 要約はフィルタバーを畳んだままの `summary` に出すためのもので、
 * 「なぜ件数が少ないのか」を開かずに読めるようにする（`prd/05-analysis.md` §2.5）。
 */

// 値は server 側の zod スキーマ（`GET /api/kifus`）と揃える
export const STATUSES = ['all', 'analyzed', 'unanalyzed', 'failed'] as const;
export const OUTCOMES = ['all', 'win', 'loss'] as const;
export const SORTS = ['playedAt', 'createdAt', 'title'] as const;
export const ORDERS = ['asc', 'desc'] as const;

export type Status = (typeof STATUSES)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type Sort = (typeof SORTS)[number];
export type Order = (typeof ORDERS)[number];

export const DEFAULT_SORT: Sort = 'playedAt';
export const DEFAULT_ORDER: Order = 'desc';

const STATUS_LABELS: Record<Exclude<Status, 'all'>, string> = {
  analyzed: '解析済み',
  unanalyzed: '未解析',
  failed: '解析失敗',
};

const OUTCOME_LABELS: Record<Exclude<Outcome, 'all'>, string> = {
  win: '勝ち',
  loss: '負け',
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
  from?: string;
  to?: string;
  sort?: Sort;
  order?: Order;
}

/** 絞り込みが効いているか。並べ替えは件数を変えないので含めない */
export function isFiltered({ q, status, outcome, from, to }: KifuListFilters): boolean {
  return Boolean(q || (status && status !== 'all') || (outcome && outcome !== 'all') || from || to);
}

/**
 * 効いている条件を `·` 区切りの 1 行にまとめる。何も効いていなければ空文字。
 * 並べ替えは既定（対局日時の降順）から変わっているときだけ添える。
 */
export function describeFilters({
  q,
  status,
  outcome,
  from,
  to,
  sort = DEFAULT_SORT,
  order = DEFAULT_ORDER,
}: KifuListFilters): string {
  const parts: string[] = [];
  if (q) parts.push(`"${q}"`);
  if (status && status !== 'all') parts.push(STATUS_LABELS[status]);
  if (outcome && outcome !== 'all') parts.push(OUTCOME_LABELS[outcome]);
  // 片側だけの指定も「どちら側が開いているか」が読めるように `〜` を残す
  if (from || to) parts.push(`${from ?? ''}〜${to ?? ''}`);
  if (sort !== DEFAULT_SORT || order !== DEFAULT_ORDER) {
    parts.push(`並び: ${SORT_LABELS[sort]} ${order === 'asc' ? '↑' : '↓'}`);
  }
  return parts.join(' · ');
}
