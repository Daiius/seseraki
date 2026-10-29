import { intParam, option, pageParam } from './searchParams';

/**
 * 出題（`/drills`）の検索パラメータ（prd/13 §7.8）。ルートから切り出した純ロジック。
 *
 * ルートは `/drills` 1 本で、検索パラメータで画面が決まる（{@link drillScreenOf}）:
 * - 問題の指定（`kifu` / `ply` / `drillKind`）あり → 解く画面（`view` より優先）
 * - 入口（`mode`）だけ → 解く画面。loader が次の 1 問を選び、問題を載せた URL へ置き換える
 * - `view=list` → 問題の一覧（カード）
 * - どれも無い → ホーム（旧形式の `tab` は読まない）
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

/** 入口（prd/13 §6.4・§7.5）。server の `mode` と同じ値 */
export type DrillMode = 'recommend' | 'mate' | 'best' | 'wrong';

/** 一覧の状態（prd/13 §7.7）。`all` は既定なので載せない */
export type DrillListStatus = 'unanswered' | 'wrong' | 'correct' | 'excluded';

export interface DrillsSearch {
  /** 入口（解く画面）。⚠ `from` は棋譜一覧・統計が使っているので使わない（prd/13 §7.8） */
  mode?: DrillMode;
  /** 問題の一覧 */
  view?: 'list';
  /** 一覧の種類の絞り込み */
  kind?: 'mate' | 'best';
  /**
   * 一覧の状態。⚠ 名前は棋譜一覧の `status` と**衝突させない**
   * （検索パラメータの型はルート間で突き合わされる。prd/13 §7.4）
   */
  solved?: DrillListStatus;
  /** 一覧のページ（1 は既定なので載せない） */
  page?: number;
  /**
   * 解く画面で表示している問題。**`kifu` / `ply` / `drillKind` の 3 つで 1 問を指し、3 つ揃っていなければ
   * どれも無いのと同じ**（{@link drillRefOf}）。
   * 🔒 **表示したら常に載せる**——棋譜詳細から戻るボタンで**同じ問題**に戻れるように。
   * 🔒 出題の行の ID では指さない（prd/14 §4.4。一括生成の作り直しで URL が切れる・総数が分かる）。
   * ⚠ 名前は一覧の `kind` と**衝突させない**（`drillKind`）。`ply` は棋譜詳細の `ply` と同じ意味・同じ型
   */
  /** 問題の棋譜の番号（所有者ごと） */
  kifu?: number;
  /** 出題局面の手数（その手を指す前の局面。0 = 初期局面） */
  ply?: number;
  /** 問題の種類 */
  drillKind?: 'mate' | 'best';
}

export const MODES = ['recommend', 'mate', 'best', 'wrong'] as const satisfies readonly DrillMode[];
const KINDS = ['mate', 'best'] as const;
export const STATUSES = ['unanswered', 'wrong', 'correct', 'excluded'] as const satisfies readonly DrillListStatus[];

/** 入口の名前（画面に出す。内部の値は出さない） */
export const MODE_LABEL: Record<DrillMode, string> = {
  recommend: 'おすすめ',
  mate: '詰将棋',
  best: '次の一手',
  wrong: '間違えた問題',
};

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
    mode: option(MODES, search.mode),
    view: search.view === 'list' ? 'list' : undefined,
    kind: option(KINDS, search.kind),
    solved: option(STATUSES, search.solved),
    page: pageParam(search.page),
    ...refSearch(ref ?? undefined),
  };
}

/** 検索パラメータから決まる画面（prd/13 §7.8）。問題の指定は `view` より優先 */
export function drillScreenOf(search: DrillsSearch): 'home' | 'list' | 'solve' {
  if (drillRefOf(search) !== null || search.mode !== undefined) return 'solve';
  if (search.view === 'list') return 'list';
  return 'home';
}

/**
 * 入口から次の 1 問を選んだあと、URL をその問題に置き換える先（prd/13 §7.8）。
 * 置き換えが要らなければ `null`（既に名指し済み / 入口が無い）。
 *
 * ⚠ **問題が既に名指しされているときは置き換えない**——名指しの問題を読み直すたびに URL を
 * 書き換えるとループの元になる。置き換え先は問題を指すので、次の読み込みでは `null` になる。
 */
export function pinnedSearch(search: DrillsSearch, ref: DrillRef): DrillsSearch | null {
  if (search.mode === undefined || drillRefOf(search) !== null) return null;
  return { mode: search.mode, ...refSearch(ref) };
}

/**
 * 入口の次の問題の行き先（「次の問題」・「次は詰将棋」など）。問題の指定を落として loader に次の 1 問を選ばせる
 * （選ばれた問題は `pinnedSearch` で URL に載る）。一覧のつまみは持ち込まない
 */
export function modeSearch(mode: DrillMode): DrillsSearch {
  return { mode };
}

/** 一覧のつまみ（種類・状態・ページ）だけを取り出す */
function listParams(search: DrillsSearch): Pick<DrillsSearch, 'kind' | 'solved' | 'page'> {
  return { kind: search.kind, solved: search.solved, page: search.page };
}

/** 一覧へ戻る行き先。一覧から開いた問題なら、そのときの絞り込みとページに戻る */
export function listSearch(search: DrillsSearch): DrillsSearch {
  return { view: 'list', ...listParams(search) };
}

/**
 * 一覧から 1 問を名指しで開く行き先（入口なし。prd/13 §7.8）。一覧の絞り込みを持ったまま開き、
 * 「一覧に戻る」で同じ一覧へ戻れるようにする（問題の指定が `view` より優先なので解く画面になる）
 */
export function solveFromListSearch(search: DrillsSearch, ref: DrillRef): DrillsSearch {
  return { view: 'list', ...listParams(search), ...refSearch(ref) };
}
