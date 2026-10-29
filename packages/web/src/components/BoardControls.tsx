import clsx from 'clsx';
import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CpuChipIcon,
  FlipIcon,
} from './icons';
import type { StudyControls } from './StudyBoard';
import { useDisplaySize } from '../lib/displaySize';
import { evaluateButtonViewState } from '../lib/evaluateButton';

/** 操作ボタンの高さ（`StudyBoard.tsx` の `TOUCH_BTN` と同じ流儀）。モバイル 44px（375px 未満は 40px）、md 以上は 32px。 */
const TOUCH_BTN =
  'btn max-md:h-11 max-md:min-h-11 max-[374px]:h-10 max-[374px]:min-h-10 md:btn-sm';
const TOUCH_BTN_COMPACT = 'btn btn-sm';

/**
 * アイコンのみのボタンを正方形にする（`StudyBoard.tsx` の `ICON_BTN` と同じ流儀）。
 * 高さと同じ幅を明示し `px-0` で内側パディングを消す。`shrink-0` で、行が窮屈でも
 * このボタンから先に潰れないようにする（同じ行の ◀ ▶ が `flex-1` で伸縮を引き受ける）。
 */
const ICON_BTN = `${TOUCH_BTN} shrink-0 px-0 max-md:w-11 max-[374px]:w-10 md:w-8`;
const ICON_BTN_COMPACT = `${TOUCH_BTN_COMPACT} shrink-0 px-0 w-8`;

/**
 * ◀ ▶ 用。モバイルは `flex-1` を維持してスライダーが消えたぶんの幅を吸う（伸縮そのまま）。
 * md 以上は `flex-none` に切り替わるので、そこだけ他のアイコンボタンと同じ正方形にする。
 */
const ICON_BTN_FLEX = `${TOUCH_BTN} flex-1 md:flex-none md:shrink-0 md:px-0 md:w-8`;
const ICON_BTN_FLEX_COMPACT = `${TOUCH_BTN_COMPACT} flex-1 md:flex-none md:shrink-0 md:px-0 md:w-8`;

/**
 * 評価する（コントローラー行の 7 つ目。prd/12 §3.2・決定 2026-09-01）。
 * モバイルは他のアイコンボタンと同じ正方形（`px-0` + 固定幅）、md 以上はラベル「評価」を
 * 添えるぶん幅を内容ぶんに戻す（情報行の「この局面を探す」と同じ流儀）。
 * ⚠ **`max-md:` / `md:` の対で書く**（`ICON_BTN` と同じ理由。裸の `w-*` を `md:w-*` で
 * 上書きする形は、同じプロパティを同じ詳細度で 2 回書くことになり Tailwind の生成順に
 * 依存する。互いに排他な variant の対にすれば依存しない）。
 */
const EVAL_BTN = `${TOUCH_BTN} shrink-0 gap-1 max-md:px-0 max-md:w-11 max-[374px]:w-10 md:w-auto md:px-3`;
const EVAL_BTN_COMPACT = `${TOUCH_BTN_COMPACT} shrink-0 gap-1 max-md:px-0 max-md:w-8 md:w-auto md:px-3`;

/**
 * 盤の下のコントローラー行（≪ ◀ slider ▶ ≫ + 盤面反転 + 評価する。prd/05 §2.1）。
 *
 * 🔴 **検討中はボタンの意味が切り替わる**（prd/12 §3.1・決定 2026-08-28）:
 *
 * | ボタン | 棋譜を見ているとき | 検討中 |
 * |---|---|---|
 * | ≪ | 最初へ | 検討の起点まで戻す |
 * | ◀ | 1 手戻る | 検討を 1 手戻す（undo） |
 * | ▶ | 1 手進む | 戻したのをやり直す（redo） |
 * | ≫ | 最後へ | 検討の最後まで進む |
 * | スライダー | 手数移動 | 無効 |
 * | 評価する | 表示中の局面を評価 | 表示中の局面を評価（検討していなくても押せる） |
 *
 * 「検討中」バッジが出ていれば棋譜と違う状態にいることは分かるので、**専用ボタンを
 * 増やすより既存の操作子に意味を持たせる**（ユーザ判断）。
 * ⚠ **起点まで戻しても検討からは抜けない**——抜けると同じ ◀ が 1 回のタップで
 * 「undo」から「棋譜の手送り」へ意味を変えることになり分かりにくい。
 * 検討の出口は「棋譜に戻る」だけ。
 *
 * 🔴 **「評価する」は検討中でなくても押せる 7 つ目**（決定・2026-09-01）。以前は検討中だけ
 * 出す操作パネルのボタンだったが、**局面さえあれば評価は意味を持つ**（検討セッションが無いと
 * 意味を持たない「棋譜に戻る」「成 / 不成」とは違う）。押しても検討モードには入らない
 * （`StudyControls.evaluate` は手順を積まない。prd/12 §3.2）。
 *
 * ⚠ `ShogiBoard` から切り出したのは、`/dev-gallery` が**実物と同じ行**を出せるように
 * するため（複製すると、片方だけ直して嘘をつく）。表示サイズの設定もここに入れているので、
 * `/dev-gallery` でも同じ高さで確かめられる。
 *
 * **ボタンの高さは設定で切り替わる**（`lib/displaySize.ts`）:
 * 既定は `md:btn-sm`（モバイルは daisyUI の既定サイズ = 連打しやすい大きさ、md 以上で小さく）、
 * `compact` はモバイルでも `btn-sm`。縦のスペースを評価値・読み筋へ回すための選択肢。
 *
 * 🔒 **アイコンのみのボタンは正方形にする**（`StudyBoard.tsx` の `ICON_BTN` と同じ流儀・
 * prd/05 §2.1 の 44px 基準。基準を割る変更ではなく、daisyUI 既定の水平パディング任せで
 * 横長（実測 52px 前後）になっていたのを揃える方向）。既定 44px / 375px 未満 40px /
 * md 以上 32px（`compact` は全幅 32px）。
 * ⚠ **◀ ▶ は `flex-1 md:flex-none` を維持する**——モバイルはスライダーが消えたぶんの
 * 幅を吸う役目があるので、正方形固定にするのは md 以上（`flex-none` に切り替わってから）だけ。
 * ⚠ **「評価する」だけ md 以上で正方形から外れる**——アイコン + ラベル「評価」を横に並べる
 * ぶん、内容ぶんの幅に戻す（他の 6 つとは違う枠。情報行の「この局面を探す」と同じ流儀）。
 */
export function BoardControls({
  study,
  moveIndex,
  totalMoves,
  branchActive,
  onGoTo,
  onFlip,
}: {
  study: StudyControls;
  moveIndex: number;
  totalMoves: number;
  /** 分岐（読み筋）を辿っている最中か。端でも「本筋へ復帰」があるので押せる */
  branchActive: boolean;
  /** 棋譜の手数を動かす（本筋へ復帰も兼ねる） */
  onGoTo: (moveIndex: number) => void;
  onFlip: () => void;
}) {
  const atStart = !branchActive && moveIndex === 0;
  const atEnd = !branchActive && moveIndex === totalMoves;
  const { displaySize } = useDisplaySize();
  const compact = displaySize.controlSize === 'compact';
  const iconBtn = compact ? ICON_BTN_COMPACT : ICON_BTN;
  const iconBtnFlex = compact ? ICON_BTN_FLEX_COMPACT : ICON_BTN_FLEX;
  const evalBtn = compact ? EVAL_BTN_COMPACT : EVAL_BTN;
  // 見た目の判断（disabled / busy / title）は純関数（`lib/evaluateButton.ts`）に切り出してある
  const evalView = evaluateButtonViewState({
    studying: study.studying,
    grading: study.grading,
    evaluating: study.evaluating,
  });

  return (
    <div className="flex items-center gap-2 max-w-3xl no-tap-select">
      <button
        className={clsx(iconBtn, 'btn-outline')}
        onClick={study.studying ? study.undoAll : () => onGoTo(0)}
        disabled={study.studying ? !study.canUndo : atStart}
        title={study.studying ? '検討の最初へ (Home)' : '最初へ (Home)'}
      >
        <ChevronDoubleLeftIcon />
      </button>
      <button
        className={clsx(iconBtnFlex, 'btn-outline')}
        onClick={study.studying ? study.undo : () => onGoTo(Math.max(0, moveIndex - 1))}
        disabled={study.studying ? !study.canUndo : atStart}
        title={study.studying ? '検討を1手戻す (←)' : '戻る (←)'}
      >
        <ChevronLeftIcon />
      </button>
      <input
        type="range"
        min={0}
        max={totalMoves}
        value={moveIndex}
        onChange={(e) => onGoTo(Number(e.target.value))}
        // 検討中は棋譜の手数を動かさない（検討の出口は「棋譜に戻る」だけ）
        disabled={study.studying}
        className="range range-sm flex-1 hidden md:block"
        aria-label="手数"
      />
      <button
        className={clsx(iconBtnFlex, 'btn-outline')}
        onClick={
          study.studying ? study.redo : () => onGoTo(Math.min(totalMoves, moveIndex + 1))
        }
        disabled={study.studying ? !study.canRedo : atEnd}
        title={study.studying ? '戻したのをやり直す (→)' : '進む (→)'}
      >
        <ChevronRightIcon />
      </button>
      <button
        className={clsx(iconBtn, 'btn-outline')}
        onClick={study.studying ? study.redoAll : () => onGoTo(totalMoves)}
        disabled={study.studying ? !study.canRedo : atEnd}
        title={study.studying ? '検討の最後へ (End)' : '最後へ (End)'}
      >
        <ChevronDoubleRightIcon />
      </button>
      <button className={clsx(iconBtn, 'btn-outline')} onClick={onFlip} title="盤面反転">
        <FlipIcon />
      </button>
      {/*
        評価する（7 つ目・決定 2026-09-01）。🔒 **枠は他の 6 つと揃える（`btn-outline`）。
        この 1 つだけ塗らない**——手送りの行で 1 つだけ目立たせると主従が入れ替わる。
        `aria-label` は固定文言（状況で変わるのは `title` だけ）。
        ⚠ **評価中はアイコンをスピナーに差し替える。ボタンの寸法は変えない**——
        アイコン / スピナーを同じ `size-5` の枠に収め、md 以上のラベルは常に出したままにする
        （差し替えで行が動かないように）。
      */}
      <button
        type="button"
        className={clsx(evalBtn, 'btn-outline')}
        onClick={study.evaluate}
        disabled={evalView.disabled}
        aria-busy={evalView.busy}
        aria-label="この局面を評価する"
        title={evalView.title}
      >
        <span className="size-5 shrink-0 flex items-center justify-center">
          {evalView.busy ? (
            <span className="loading loading-spinner loading-xs" aria-hidden="true" />
          ) : (
            <CpuChipIcon />
          )}
        </span>
        <span className="hidden md:inline">評価</span>
      </button>
    </div>
  );
}
