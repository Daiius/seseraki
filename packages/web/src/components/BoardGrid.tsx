import clsx from 'clsx';
import type { BoardState, PieceKind, SquareRef } from 'shared';

/**
 * 盤の見た目（9x9 + 筋段のラベル）と持ち駒表示。
 *
 * 🔒 **盤の見た目は 1 箇所に保つ。** 棋譜詳細（`ShogiBoard` → `StudyBoard`）と
 * 局面検索（`routes/positions.tsx`）の両方がここを使う。複製しない。
 *
 * ⚠ `ShogiBoard` から切り出したのは、検討盤（`StudyBoard`）が盤を描くため。
 * `ShogiBoard` に置いたままだと `ShogiBoard → StudyBoard → ShogiBoard` の循環 import になる。
 *
 * マスの寸法は CSS（`app.css` の `.shogi-board`）が**幅と高さから算出**する
 * （prd/12 §3.3）。ここには固定寸法を書かない。
 */

export const PIECE_DISPLAY: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

export const HAND_ORDER: PieceKind[] = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];

const COL_LABELS = [9, 8, 7, 6, 5, 4, 3, 2, 1];
const ROW_LABELS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function HandDisplay({
  hand,
  side,
  name,
}: {
  hand: Partial<Record<PieceKind, number>>;
  side: 'sente' | 'gote';
  name?: string | null;
}) {
  const pieces = HAND_ORDER.flatMap((kind) => {
    const count = hand[kind];
    if (!count) return [];
    return [`${PIECE_DISPLAY[kind]}${count > 1 ? count : ''}`];
  });
  const symbol = side === 'sente' ? '☗' : '☖';
  const label = name ?? (side === 'sente' ? '先手' : '後手');
  return (
    <div className="text-sm lg:text-base flex items-center">
      <span className="font-semibold">{symbol}{label}</span>
      <span className="ml-auto">{pieces.length > 0 ? pieces.join(' ') : 'なし'}</span>
    </div>
  );
}

export function BoardGrid({
  state,
  lastMoveTo,
  flipped,
  onSquareClick,
  selected,
}: {
  state: BoardState;
  lastMoveTo: [number, number] | null;
  flipped: boolean;
  /**
   * マスを叩いたときに呼ぶ（検討盤のタップ 2 段。prd/12 §3.1）。
   * ⚠ **渡さなければ従来どおりの表示専用**（マスはボタンにならない）。局面検索
   * （`/positions`）は渡さないので挙動が変わらない。
   */
  onSquareClick?: (square: SquareRef) => void;
  /** 選択中のマス（タップ 1 段目）。行き先を選ぶまで強調する */
  selected?: SquareRef | null;
}) {
  const colLabels = flipped ? [...COL_LABELS].reverse() : COL_LABELS;
  const rowLabels = flipped ? [...ROW_LABELS].reverse() : ROW_LABELS;
  const rowOrder = flipped ? [8, 7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const colOrder = flipped ? [8, 7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7, 8];

  return (
    <div className="shogi-board">
      {/* 筋番号（1行目） */}
      {colLabels.map((col) => (
        <div
          key={`col-${col}`}
          className="shogi-label flex items-end justify-center text-base-content/50"
        >
          {col}
        </div>
      ))}
      <div />
      {/* 盤面 9x9 + 段番号 */}
      {rowOrder.flatMap((rowIdx, ri) => [
        ...colOrder.map((colIdx) => {
          const sq = state.board[rowIdx][colIdx];
          const isLastMove = lastMoveTo !== null && lastMoveTo[0] === rowIdx && lastMoveTo[1] === colIdx;
          const isSelected = selected != null && selected.row === rowIdx && selected.col === colIdx;
          const className = clsx(
            'shogi-square border border-base-300 flex items-center justify-center font-bold',
            isLastMove && 'bg-primary/15',
            // 選択中は最後手の強調より優先させる（今まさに操作している場所なので）
            isSelected && 'bg-secondary/40 ring-2 ring-secondary ring-inset',
          );
          const content = sq && (
            <span
              className={clsx(
                'inline-block',
                (flipped ? sq.side === 'sente' : sq.side === 'gote') && 'rotate-180 text-error',
              )}
            >
              {PIECE_DISPLAY[sq.kind]}
            </span>
          );
          const key = `${rowIdx}-${colIdx}`;
          if (!onSquareClick) {
            return (
              <div key={key} className={className}>
                {content}
              </div>
            );
          }
          return (
            <button
              type="button"
              key={key}
              className={className}
              aria-label={`${9 - colIdx}${ROW_LABELS[rowIdx]}`}
              onClick={() => onSquareClick({ row: rowIdx, col: colIdx })}
            >
              {content}
            </button>
          );
        }),
        <div
          key={`row-${ri}`}
          className="shogi-label flex items-center justify-center text-base-content/50"
        >
          {rowLabels[ri]}
        </div>,
      ])}
    </div>
  );
}
