/**
 * 出題（`/drills`）の検索パラメータ（prd/13 §7.4）。ルートから切り出した純ロジック。
 */

/**
 * 出題を指す組（prd/14 §4.4）。「42 番の棋譜の 36 手目の局面の次の一手」。
 * server の `DrillRef`（`/api/drills/:kifuNo/:moveNumber/:kind`）と同じ組。
 * `moveNumber` は出題局面（その手を指す前の局面）で、棋譜詳細の `?ply=` と同じ数え方
 */
export interface DrillRef {
  kifuNo: number;
  moveNumber: number;
  kind: 'mate' | 'best';
}

export interface DrillsSearch {
  /** タブ（prd/13 §7.4）。`solve` は既定なので URL に載せない */
  tab?: 'list' | 'history';
  /** 出題の種類で絞る。未指定なら両方から選ぶ。**タブをまたいで効く** */
  kind?: 'mate' | 'best';
  /**
   * 解くタブで表示している問題（`tab` が解くときだけ見る。prd/13 §7.4）。**`kifu` / `ply` / `drillKind` の 3 つで
   * 1 問を指し、3 つ揃っていなければどれも無いのと同じ**（{@link drillRefOf}）。
   * 🔒 **表示したら常に載せる**——棋譜詳細から戻るボタンで**同じ問題**に戻れるように。
   * 未指定なら loader が次の 1 問を選び、それを載せた URL へ置き換える。
   * 🔒 出題の行の ID では指さない（prd/14 §4.4。一括生成の作り直しで URL が切れる・総数が分かる）。
   * ⚠ 名前は絞り込みの `kind` と**衝突させない**（`drillKind`）。`ply` は棋譜詳細の `ply` と同じ意味・同じ型
   */
  /** 問題の棋譜の番号（所有者ごと） */
  kifu?: number;
  /** 出題局面の手数（その手を指す前の局面。0 = 初期局面） */
  ply?: number;
  /** 問題の種類 */
  drillKind?: 'mate' | 'best';
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

/** 整数で `min` 以上の値だけを受ける */
function intParam(raw: unknown, min: number): number | undefined {
  // ⚠ 空文字・null は `Number` で 0 になるので先に落とす
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min ? value : undefined;
}

/** 問題を指す 3 つ組。**揃っていれば**組を、1 つでも欠けていれば null */
export function drillRefOf(search: Pick<DrillsSearch, 'kifu' | 'ply' | 'drillKind'>): DrillRef | null {
  const { kifu, ply, drillKind } = search;
  if (kifu === undefined || ply === undefined || drillKind === undefined) return null;
  return { kifuNo: kifu, moveNumber: ply, kind: drillKind };
}

/** 問題を指す 3 つ組を検索パラメータへ（`undefined` を渡すと落とす） */
function refSearch(ref: DrillRef | undefined): Pick<DrillsSearch, 'kifu' | 'ply' | 'drillKind'> {
  return { kifu: ref?.kifuNo, ply: ref?.moveNumber, drillKind: ref?.kind };
}

export function validateDrillsSearch(search: Record<string, unknown>): DrillsSearch {
  // 🔒 3 つ揃っていなければ**どれも載せない**（欠けた組は問題を指さない。中途半端に残すと
  // 「次の問題を選ぶ」か「名指しの問題を開く」かが曖昧になる）
  const ref = drillRefOf({
    kifu: intParam(search.kifu, 1),
    ply: intParam(search.ply, 0),
    drillKind: option(KINDS, search.drillKind),
  });
  return {
    tab: option(TABS, search.tab),
    kind: option(KINDS, search.kind),
    ...refSearch(ref ?? undefined),
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
 * ⚠ **問題が既に名指しされているときは置き換えない**——名指しの問題を読み直すたびに URL を
 * 書き換えるとループの元になる。置き換え先は問題を指すので、次の読み込みでは `null` になる。
 */
export function pinnedSearch(search: DrillsSearch, ref: DrillRef): DrillsSearch | null {
  if (search.tab !== undefined || drillRefOf(search) !== null) return null;
  return { ...search, ...refSearch(ref) };
}

/**
 * 「次の問題」の行き先。問題を指す組を落として loader に次の 1 問を選ばせる
 * （選ばれた問題は `pinnedSearch` で URL に載る）。種類の絞り込みは保つ。
 */
export function nextDrillSearch(search: DrillsSearch): DrillsSearch {
  return { ...search, ...refSearch(undefined) };
}

/** 一覧・履歴から 1 問を名指しで開く行き先（種類の絞り込みは保つ） */
export function solveDrillSearch(kind: DrillsSearch['kind'], ref: DrillRef): DrillsSearch {
  return { kind, ...refSearch(ref) };
}
