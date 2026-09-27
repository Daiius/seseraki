/**
 * 出題（`/drills`）の検索パラメータ（prd/13 §7.4）。ルートから切り出した純ロジック。
 */
export interface DrillsSearch {
  /** タブ（prd/13 §7.4）。`solve` は既定なので URL に載せない */
  tab?: 'list' | 'history';
  /** 出題の種類で絞る。未指定なら両方から選ぶ。**タブをまたいで効く** */
  kind?: 'mate' | 'best';
  /**
   * 解くタブで表示している問題（`tab` が解くときだけ見る。prd/13 §7.4）。
   * 🔒 **表示したら常に載せる**——棋譜詳細から戻るボタンで**同じ問題**に戻れるように。
   * 未指定なら loader が次の 1 問を選び、その id を載せた URL へ置き換える
   */
  drill?: number;
  /** 一覧・履歴のページ（1 は既定なので載せない） */
  page?: number;
  /** 一覧の解答状況（`all` は既定）。⚠ 名前は棋譜一覧の `status` と**衝突させない**
   * （検索パラメータの型はルート間で突き合わされる） */
  solved?: 'unanswered' | 'wrong' | 'correct';
  /** 一覧で除外した問題だけを見る（既定は隠す） */
  excluded?: 'only';
  /** 一覧の並び（`played` は既定）。⚠ 棋譜一覧の `sort` と衝突させない */
  sortBy?: 'status';
  /** 履歴の判定（`all` は既定） */
  verdict?: 'correct' | 'close' | 'wrong' | 'excluded';
}

const TABS = ['list', 'history'] as const;
const KINDS = ['mate', 'best'] as const;
export const STATUSES = ['unanswered', 'wrong', 'correct'] as const;
export const VERDICTS = ['correct', 'close', 'wrong', 'excluded'] as const;

/** 許可値でなければ落とす（URL 直入力の未知の値は既定に戻す） */
export function option<T extends string>(values: readonly T[], raw: unknown): T | undefined {
  return values.find((v) => v === raw);
}

/** 正の整数だけを受ける。1 は既定なので URL に載せない */
function pageParam(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 1 ? value : undefined;
}

function idParam(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function validateDrillsSearch(search: Record<string, unknown>): DrillsSearch {
  return {
    tab: option(TABS, search.tab),
    kind: option(KINDS, search.kind),
    drill: idParam(search.drill),
    page: pageParam(search.page),
    solved: option(STATUSES, search.solved),
    excluded: search.excluded === 'only' ? 'only' : undefined,
    sortBy: search.sortBy === 'status' ? 'status' : undefined,
    verdict: option(VERDICTS, search.verdict),
  };
}

/**
 * 解くタブで次の 1 問を選んだあと、URL をその問題に置き換える先（prd/13 §7.4）。
 * 置き換えが要らなければ `null`（既に名指し済み / 解くタブでない）。
 *
 * ⚠ **`drill` が既にあるときは置き換えない**——名指しの問題を読み直すたびに URL を
 * 書き換えるとループの元になる。置き換え先は `drill` を持つので、次の読み込みでは `null` になる。
 */
export function pinnedSearch(search: DrillsSearch, drillId: number): DrillsSearch | null {
  if (search.tab !== undefined || search.drill !== undefined) return null;
  return { ...search, drill: drillId };
}

/**
 * 「次の問題」の行き先。`drill` を落として loader に次の 1 問を選ばせる
 * （選ばれた問題は `pinnedSearch` で URL に載る）。種類の絞り込みは保つ。
 */
export function nextDrillSearch(search: DrillsSearch): DrillsSearch {
  return { ...search, drill: undefined };
}
