import clsx from 'clsx';
import type { BoardState, HandPieceKind, PieceKind, SquareRef } from 'shared';

/**
 * 盤の見た目（9x9 + 筋段のラベル）と持ち駒表示。
 *
 * 🔒 **盤の見た目は 1 箇所に保つ。** 棋譜詳細（`ShogiBoard` → `StudyBoard`）と
 * 局面検索（`routes/positions.tsx`）の両方がここを使う。複製しない。
 *
 * ⚠ `ShogiBoard` から切り出したのは、検討盤（`StudyBoard`）が盤を描くため。
 * `ShogiBoard` に置いたままだと `ShogiBoard → StudyBoard → ShogiBoard` の循環 import になる。
 *
 * マスの寸法は CSS（`app.css` の `--sq`）が**幅と高さから算出**する（prd/12 §3.3）。
 * **持ち駒も同じ寸法**にして、そのままタップして打てるようにする（prd/12 §3.2）。
 * ここには固定寸法を書かない。
 */

export const PIECE_DISPLAY: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

export const HAND_ORDER: HandPieceKind[] = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];

const COL_LABELS = [9, 8, 7, 6, 5, 4, 3, 2, 1];
const ROW_LABELS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function HandDisplay({
  hand,
  side,
  name,
  flipped = false,
  onPieceClick,
  selected,
  onTrayClick,
}: {
  hand: Partial<Record<PieceKind, number>>;
  side: 'sente' | 'gote';
  name?: string | null;
  /** 盤の反転。反転中は先手の駒を 180 度回す（盤の駒と同じ規則） */
  flipped?: boolean;
  /**
   * 持ち駒を叩いたときに呼ぶ（検討盤のタップ 2 段。prd/12 §3.1）。
   * ⚠ **渡さなければ表示専用**（駒はボタンにならない）。局面検索（`/positions`）は
   * 渡さないので、寸法が揃うだけで叩けはしない。
   */
  onPieceClick?: (kind: HandPieceKind) => void;
  /** 選択中の持ち駒。盤の選択マスと同じ見せ方で強調する */
  selected?: HandPieceKind | null;
  /**
   * 駒台の**空き部分**（受け皿）を叩いたときに呼ぶ。盤の駒を選んでいる間だけ渡す想定で、
   * **渡したときだけ受け皿として光る**（prd/12 §3.2）。
   *
   * 🔒 選んでいないときは渡さない——余計な装飾を出さないため、また空き部分を叩いても
   * 何も起きないため（そこから選択が始まったりはしない）。
   */
  onTrayClick?: () => void;
}) {
  const pieces = HAND_ORDER.flatMap((kind) => {
    const count = hand[kind];
    return count ? [{ kind, count }] : [];
  });
  const symbol = side === 'sente' ? '☗' : '☖';
  const label = name ?? (side === 'sente' ? '先手' : '後手');
  // 盤の駒と同じ規則: 相手側（反転中は先手側）の駒を 180 度回して赤くする
  const rotate = flipped ? side === 'sente' : side === 'gote';

  /*
    🔒 **行の高さは中身によらず 1 マスぶん**（`.shogi-hand-row`）。受け皿は名前と駒の間の
    空き部分を占め、`self-stretch` で行いっぱいに伸ばすだけなので、**足しても行の高さは
    変わらない**（prd/05 §2.1・盤ごと下の操作ボタンがずれない）。
    持ち駒が無いときの「なし」もこの中に置く——**そこが一番自然な着地点**だから。
  */
  const trayClass = clsx(
    'flex-1 self-stretch flex items-center justify-end rounded px-1',
    onTrayClick && 'bg-secondary/20 ring-1 ring-secondary/60 ring-inset',
  );
  const trayContent =
    pieces.length === 0 ? <span className="text-base-content/50">なし</span> : null;

  return (
    <div className="shogi-hand-row text-sm lg:text-base flex items-center gap-1 no-tap-select">
      <span className="font-semibold whitespace-nowrap">{symbol}{label}</span>
      {onTrayClick ? (
        <button
          type="button"
          className={trayClass}
          aria-label={`${label}の駒台へ置く`}
          title="選んでいる駒をこの駒台へ移す"
          onClick={onTrayClick}
        >
          {trayContent}
        </button>
      ) : (
        <div className={trayClass}>{trayContent}</div>
      )}
      <div className="flex items-center">
        {pieces.map(({ kind, count }) => {
          const isSelected = selected === kind;
          const className = clsx(
            'shogi-hand-piece relative flex items-center justify-center font-bold rounded',
            isSelected && 'bg-secondary/40 ring-2 ring-secondary ring-inset',
          );
          const content = (
            <>
              <span className={clsx('inline-block', rotate && 'rotate-180 text-error')}>
                {PIECE_DISPLAY[kind]}
              </span>
              {/* 枚数は右上に上付きで重ねる。1 枚なら出さない（盤の駒と同じ密度に保つ） */}
              {count > 1 && (
                <span className="shogi-hand-count absolute right-0 top-0 font-mono text-base-content/70">
                  {count}
                </span>
              )}
            </>
          );
          if (!onPieceClick) {
            return (
              <div key={kind} className={className}>
                {content}
              </div>
            );
          }
          return (
            <button
              type="button"
              key={kind}
              className={className}
              aria-label={`${label}の持ち駒 ${PIECE_DISPLAY[kind]}${count}枚`}
              onClick={() => onPieceClick(kind)}
            >
              {content}
            </button>
          );
        })}
      </div>
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
