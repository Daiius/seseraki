/**
 * タッチターゲットの寸法（prd/05-analysis.md §2.1）。
 *
 * モバイルの誤タップ対策として Apple HIG 44pt / WCAG 2.2 SC 2.5.5(AAA) の 44px を狙い、
 * ターゲット間は Material の 8dp 以上を取る。ただし 44px×5 + 8px×4 = 252px は、
 * navbar の padding とロゴを足すと 320px 幅（iPhone SE 等の下限）に収まらない。
 * そこで 375px 未満だけ「40px ターゲット / 間隔 4px / ロゴ縮小」へ落とす
 * （40px は WCAG 2.2 SC 2.5.8(AA) の下限 24px は十分上回る。溢れて押せなくなるより良い）。
 * デスクトップ幅（sm 以上）はポインタ操作なので btn-sm（32px）のまま。
 *
 * 🔒 **表示サイズの設定（`lib/displaySize.ts` の `controlSize`）には連動させない。**
 * あちらは棋譜の手送りと検討の操作を 32px まで縮められるようにする設定で、
 * **その例外を支えている安全策が「取り返しのつかない操作は縮まない側に置く」こと**
 * （prd/05 §2.1）。ここを一緒に縮めると、削除・再解析の的が小さくなったうえに
 * 「隔離してあるから 32px を許す」という論の足が外れる。**設定に関わらず常に 44px。**
 *
 * ⚠ ここは**ヘッダー（`routes/__root.tsx` の ☰）と棋譜詳細（`routes/kifus/$id.tsx` の ⋯）の
 * 両方が使う**。片方だけ直して基準がずれるのを防ぐため、寸法と理由をこの 1 箇所に置く。
 * 盤の操作ボタン（設定に連動する側）も末尾に置く（{@link controlButtonsOf}）。
 */
import type { ControlSize } from './displaySize';

/** アイコンのみのボタン（ヘッダーの操作・ドロップダウンのトリガー） */
export const ICON_BTN = 'btn btn-ghost btn-sm btn-square max-sm:size-11 max-[374px]:size-10';

/**
 * ドロップダウンのメニュー項目。上のボタンと同じ 44px の当たり判定を持たせる。
 *
 * ⚠ **幅では出し分けない**——メニューは開いている間だけ出る一時的な面で、
 * 幅ごとに高さが変わると出現位置の見当が付けにくい。
 * ⚠ **`menu-sm` を併用しない**（項目の高さを 44px 未満へ引き戻すため）。
 */
export const MENU_ITEM = 'min-h-11 gap-3';

/**
 * メニューの器（`<ul>`）。項目間は 4px（`gap-1`）。
 * Material の 8px はメニュー内では隙間が目立ちすぎ、44px の高さが既に十分な
 * 当たり判定を与えているので、区切りが分かる最小限に留める。
 * 背景はページ本体（base-100）と同じ色にしない——影だけでは境目が見えず、ダークでは同化する。
 */
export const MENU_LIST = 'dropdown-content menu bg-base-200 rounded-box z-20 mt-1 gap-1 p-2 shadow-lg';

/* ---------- 盤の操作ボタン（表示サイズの設定に連動する側） ---------- */

/*
  棋譜の操作行（`BoardControls`）・検討盤の操作パネル・読み筋の再生ボタンのクラス。

  🔒 **上の定数（ヘッダー・メニュー）とは逆に、表示サイズの設定 `controlSize: 'compact'` で縮む**
  （prd/05 §2.1 の例外。`lib/displaySize.ts`）。手送りと検討の操作は取り返しのつく操作なので、
  縦のスペースを評価値・読み筋へ回すために 32px まで縮めてよい。
  🔒 **棋譜の操作行と検討盤の操作パネルは同じ設定で同時に切り替える**（要望 2026-08-31）。
  検討盤の操作パネルは棋譜の操作行のすぐ上に並ぶので、片方だけ小さいと段差になる。
  ⚠ **新しい設定は増やさない**——「操作ボタン」は利用者から見て 1 つの概念で、
  棋譜用と検討用で別々に選びたい理由が無い。
  compact は **md 以上の見た目を全幅に広げる**だけ（`btn-sm` = 32px・幅 2rem）。
  タップの的は 44px から縮むが、それを承知で縦を稼ぐための選択肢なので、
  ここで下限を作り直すと設定の意味が無くなる。
*/

/** 操作系のボタン。モバイル 44px（375px 未満は 40px）・デスクトップは小さく */
const CONTROL_TOUCH = 'btn max-md:h-11 max-md:min-h-11 max-[374px]:h-10 max-[374px]:min-h-10 md:btn-sm';
const CONTROL_TOUCH_COMPACT = 'btn btn-sm';

/** {@link controlButtonsOf} の返り値。どれも枠（`btn-outline` など）は呼び出し側で足す */
export interface ControlButtons {
  /** 文字のボタン（読み筋の再生など） */
  touch: string;
  /**
   * アイコンだけのボタン。🔒 **正方形にする**——高さだけ 44px にしても幅が潰れればタップの的は小さいままで、
   * prd/05 §2.1 の 44px 基準を満たさない。高さと同じ幅を明示して `px-0` で内側の余白を消す。
   * 🔒 **`shrink-0`**——幅の決まらない要素と同じ行に並んでも、このボタンから先に潰れないようにする
   */
  icon: string;
  /**
   * 文字（`成` / `☗先手`）を入れる小さなボタン。**幅は下限だけ決めて内容で伸ばす**——
   * `不成` や手番の記号はアイコンより広く、固定幅だと収まらない
   */
  glyph: string;
  /**
   * ◀ ▶ 用。モバイルは `flex-1` を維持してスライダーが消えたぶんの幅を吸う（伸縮そのまま）。
   * md 以上は `flex-none` に切り替わるので、そこだけ他のアイコンボタンと同じ正方形にする
   */
  iconFlex: string;
  /**
   * 評価する（コントローラー行の 7 つ目。prd/12 §3.2・決定 2026-09-01）。
   * モバイルは他のアイコンボタンと同じ正方形（`px-0` + 固定幅）、md 以上はラベル「評価」を
   * 添えるぶん幅を内容ぶんに戻す（情報行の「この局面を探す」と同じ流儀）。
   * ⚠ **`max-md:` / `md:` の対で書く**（裸の `w-*` を `md:w-*` で上書きする形は、同じプロパティを
   * 同じ詳細度で 2 回書くことになり Tailwind の生成順に依存する。互いに排他な variant の対にすれば依存しない）
   */
  eval: string;
}

const CONTROL_BUTTONS: Record<ControlSize, ControlButtons> = {
  normal: {
    touch: CONTROL_TOUCH,
    icon: `${CONTROL_TOUCH} shrink-0 px-0 max-md:w-11 max-[374px]:w-10 md:w-8`,
    glyph: `${CONTROL_TOUCH} shrink-0 px-2 gap-1 max-md:min-w-11 max-[374px]:min-w-10 md:min-w-8`,
    iconFlex: `${CONTROL_TOUCH} flex-1 md:flex-none md:shrink-0 md:px-0 md:w-8`,
    eval: `${CONTROL_TOUCH} shrink-0 gap-1 max-md:px-0 max-md:w-11 max-[374px]:w-10 md:w-auto md:px-3`,
  },
  compact: {
    touch: CONTROL_TOUCH_COMPACT,
    icon: `${CONTROL_TOUCH_COMPACT} shrink-0 px-0 w-8`,
    glyph: `${CONTROL_TOUCH_COMPACT} shrink-0 px-2 gap-1 min-w-8`,
    iconFlex: `${CONTROL_TOUCH_COMPACT} flex-1 md:flex-none md:shrink-0 md:px-0 md:w-8`,
    eval: `${CONTROL_TOUCH_COMPACT} shrink-0 gap-1 max-md:px-0 max-md:w-8 md:w-auto md:px-3`,
  },
};

/**
 * 盤の操作ボタンのクラス一式を、表示サイズの設定（`controlSize`）から決める。
 * ⚠ **props で配らず、使う側が `useDisplaySize` を読んで渡す**——操作ボタンは `BoardControls`・
 * 検討盤の操作パネル・評価結果（読み筋の再生）に分かれており、見た目の設定を中継させるためだけに
 * props を増やすと途中の階層すべてが表示サイズを知ることになる
 */
export function controlButtonsOf(controlSize: ControlSize): ControlButtons {
  return CONTROL_BUTTONS[controlSize];
}
