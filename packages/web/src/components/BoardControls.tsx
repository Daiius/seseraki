import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FlipIcon,
} from './icons';
import type { StudyControls } from './StudyBoard';
import { useDisplaySize } from '../lib/displaySize';

/**
 * 盤の下のコントローラー行（≪ ◀ slider ▶ ≫ + 盤面反転。prd/05 §2.1）。
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
 *
 * 「検討中」バッジが出ていれば棋譜と違う状態にいることは分かるので、**専用ボタンを
 * 増やすより既存の操作子に意味を持たせる**（ユーザ判断）。
 * ⚠ **起点まで戻しても検討からは抜けない**——抜けると同じ ◀ が 1 回のタップで
 * 「undo」から「棋譜の手送り」へ意味を変えることになり分かりにくい。
 * 検討の出口は「棋譜に戻る」だけ。
 *
 * ⚠ `ShogiBoard` から切り出したのは、`/dev-gallery` が**実物と同じ行**を出せるように
 * するため（複製すると、片方だけ直して嘘をつく）。表示サイズの設定もここに入れているので、
 * `/dev-gallery` でも同じ高さで確かめられる。
 *
 * **ボタンの高さは設定で切り替わる**（`lib/displaySize.ts`）:
 * 既定は `md:btn-sm`（モバイルは daisyUI の既定サイズ = 連打しやすい大きさ、md 以上で小さく）、
 * `compact` はモバイルでも `btn-sm`。縦のスペースを評価値・読み筋へ回すための選択肢。
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
  // ⚠ クラス名は**リテラルで**書く（Tailwind はソースを走査して拾うので、組み立てると消える）
  const btnSize = displaySize.controlSize === 'compact' ? 'btn-sm' : 'md:btn-sm';

  return (
    <div className="flex items-center gap-2 max-w-3xl no-tap-select">
      <button
        className={`btn btn-outline ${btnSize}`}
        onClick={study.studying ? study.undoAll : () => onGoTo(0)}
        disabled={study.studying ? !study.canUndo : atStart}
        title={study.studying ? '検討の最初へ (Home)' : '最初へ (Home)'}
      >
        <ChevronDoubleLeftIcon />
      </button>
      <button
        className={`btn btn-outline flex-1 md:flex-none ${btnSize}`}
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
        className={`btn btn-outline flex-1 md:flex-none ${btnSize}`}
        onClick={
          study.studying ? study.redo : () => onGoTo(Math.min(totalMoves, moveIndex + 1))
        }
        disabled={study.studying ? !study.canRedo : atEnd}
        title={study.studying ? '戻したのをやり直す (→)' : '進む (→)'}
      >
        <ChevronRightIcon />
      </button>
      <button
        className={`btn btn-outline ${btnSize}`}
        onClick={study.studying ? study.redoAll : () => onGoTo(totalMoves)}
        disabled={study.studying ? !study.canRedo : atEnd}
        title={study.studying ? '検討の最後へ (End)' : '最後へ (End)'}
      >
        <ChevronDoubleRightIcon />
      </button>
      <button className={`btn btn-outline ${btnSize}`} onClick={onFlip} title="盤面反転">
        <FlipIcon />
      </button>
    </div>
  );
}
