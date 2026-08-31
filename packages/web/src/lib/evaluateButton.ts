/**
 * コントローラー行の「評価する」ボタンの見た目判断（prd/12 §3.2・決定 2026-09-01）。
 *
 * 🔒 **コンポーネントに `if` を散らさない。** `disabled` / `busy` / `title` の 3 つは
 * それぞれ別の条件から決まるが、書く場所が JSX に散ると「評価中の title だけ直し忘れる」
 * ような静かな崩れ方をする。1 つの純関数にまとめてテストする。
 *
 * 🔴 **押せない理由をボタンの見た目に背負わせるのは「評価中」だけ**（決定・2026-09-01）。
 * キュー満杯・失敗・不正局面はボタンを押せるままにし、理由は評価結果ブロックの alert が言う
 * （`StudyBoard.tsx` の `EvalResultView`）。「棋譜の自動解析が走っている間は押せない」という
 * 制約も作らない——差し込み評価（解析の合間に気になる局面だけ評価する）が動機そのものなので、
 * それを妨げる disabled 条件を足してはいけない。
 */

/** title の元になる状況。`studying` / `grading` が false なら常に棋譜側の文面になる */
export interface EvaluateButtonInput {
  /** 検討中か（false なら棋譜再生中・棋譜側の読み筋を辿っている最中） */
  studying: boolean;
  /** 直前の手の採点対象があるか（`lastMoveGradeTarget` が非 null。棋譜側では常に false） */
  grading: boolean;
  /** 評価要求が実行中か */
  evaluating: boolean;
}

export interface EvaluateButtonViewState {
  /** ボタンを押せなくするか（評価中のときだけ true） */
  disabled: boolean;
  /** アイコンをスピナーに差し替えるか（`disabled` と常に同じ値。意味の違う名前で呼べるようにする） */
  busy: boolean;
  /** 状況に応じた文面（`aria-label` は固定文言なのでここでは扱わない） */
  title: string;
}

const TITLE_KIFU = 'この局面をエンジンに評価させる';
const TITLE_GRADING = 'この局面を評価し、直前の手が最善とどれだけ離れていたかも出す';
const TITLE_EVALUATING = '評価しています';

/**
 * ボタンの見た目を決める（prd/12 §3.2・決定 2026-09-01）。
 *
 * title は 3 段:
 * - **評価中**（`evaluating`）: 何が起きているかを言う。他の 2 つより優先する
 *   （評価中は `studying` / `grading` の値に関わらずボタンが押せないため）。
 * - **検討中で採点対象がある**（`studying && grading`）: 直前の手の採点まで出ることを言う。
 * - **それ以外**（棋譜再生中・棋譜側の読み筋を辿っている最中・検討中でも採点対象が無いとき）:
 *   局面評価だけを言う汎用の文面。
 */
export function evaluateButtonViewState({
  studying,
  grading,
  evaluating,
}: EvaluateButtonInput): EvaluateButtonViewState {
  if (evaluating) {
    return { disabled: true, busy: true, title: TITLE_EVALUATING };
  }
  if (studying && grading) {
    return { disabled: false, busy: false, title: TITLE_GRADING };
  }
  return { disabled: false, busy: false, title: TITLE_KIFU };
}
