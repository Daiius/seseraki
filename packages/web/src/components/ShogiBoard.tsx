import { useState, useMemo } from 'react';
import clsx from 'clsx';
import {
  buildPositions,
  applyMove,
  usiToJapaneseWithPiece,
  type BoardState,
  type PieceKind,
} from '../lib/board';
import { turnSymbol, formatScore } from '../lib/usi';
import { EvalGraph } from './EvalGraph';

const PIECE_DISPLAY: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

const HAND_ORDER: PieceKind[] = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
const COL_LABELS = [9, 8, 7, 6, 5, 4, 3, 2, 1];
const ROW_LABELS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

interface Analysis {
  id: number;
  moveNumber: number;
  movePlayed: string | null;
  candidates: {
    id: number;
    rank: number;
    move: string;
    scoreType: string;
    scoreValue: number;
    pv: string[] | null;
    depth: number;
  }[];
}

interface Props {
  analyses: Analysis[];
}

function HandDisplay({
  hand,
  side,
}: {
  hand: Partial<Record<PieceKind, number>>;
  side: 'sente' | 'gote';
}) {
  const pieces = HAND_ORDER.flatMap((kind) => {
    const count = hand[kind];
    if (!count) return [];
    return [`${PIECE_DISPLAY[kind]}${count > 1 ? count : ''}`];
  });
  const label = side === 'sente' ? '☗先手' : '☖後手';
  return (
    <div className="text-sm">
      <span className="font-semibold">{label}: </span>
      {pieces.length > 0 ? pieces.join(' ') : 'なし'}
    </div>
  );
}

function BoardGrid({ state }: { state: BoardState }) {
  return (
    <div className="inline-grid grid-cols-[repeat(9,2rem)_1.5rem] grid-rows-[1.25rem_repeat(9,2rem)]">
      {/* 筋番号（1行目） */}
      {COL_LABELS.map((col) => (
        <div
          key={`col-${col}`}
          className="flex items-end justify-center text-xs text-base-content/50"
        >
          {col}
        </div>
      ))}
      <div />
      {/* 盤面 9x9 + 段番号 */}
      {state.board.flatMap((row, rowIdx) => [
        ...row.map((sq, colIdx) => (
          <div
            key={`${rowIdx}-${colIdx}`}
            className="size-8 border border-base-300 flex items-center justify-center text-sm font-bold"
          >
            {sq && (
              <span
                className={clsx(
                  'inline-block',
                  sq.side === 'gote' && 'rotate-180 text-error',
                )}
              >
                {PIECE_DISPLAY[sq.kind]}
              </span>
            )}
          </div>
        )),
        <div
          key={`row-${rowIdx}`}
          className="flex items-center justify-center text-xs text-base-content/50"
        >
          {ROW_LABELS[rowIdx]}
        </div>,
      ])}
    </div>
  );
}

export function ShogiBoard({ analyses }: Props) {
  const sortedAnalyses = useMemo(
    () => [...analyses].sort((a, b) => a.moveNumber - b.moveNumber),
    [analyses],
  );

  const positions = useMemo(() => {
    const moves = sortedAnalyses
      .filter((a) => a.movePlayed)
      .map((a) => a.movePlayed!);
    return buildPositions(moves);
  }, [sortedAnalyses]);

  const totalMoves = positions.length - 1;
  const [moveIndex, setMoveIndex] = useState(0);

  const currentState = positions[moveIndex];
  const currentAnalysis = sortedAnalyses.find(
    (a) => a.moveNumber === moveIndex,
  );

  const best = currentAnalysis?.candidates.find((c) => c.rank === 1);
  const isBestMove =
    best && currentAnalysis?.movePlayed && best.move === currentAnalysis.movePlayed;
  const posEval = best
    ? formatScore(best.scoreType, best.scoreValue, moveIndex)
    : null;

  return (
    <div className="flex flex-col gap-4">
      {/* 手数ナビゲーション */}
      <div className="flex items-center gap-2">
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setMoveIndex(0)}
          disabled={moveIndex === 0}
        >
          ⏮
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setMoveIndex(Math.max(0, moveIndex - 1))}
          disabled={moveIndex === 0}
        >
          ◀
        </button>
        <input
          type="range"
          min={0}
          max={totalMoves}
          value={moveIndex}
          onChange={(e) => setMoveIndex(Number(e.target.value))}
          className="range range-sm flex-1"
        />
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setMoveIndex(Math.min(totalMoves, moveIndex + 1))}
          disabled={moveIndex === totalMoves}
        >
          ▶
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setMoveIndex(totalMoves)}
          disabled={moveIndex === totalMoves}
        >
          ⏭
        </button>
        <span className="text-sm font-mono w-20 text-right">
          {moveIndex} / {totalMoves}
        </span>
      </div>

      {/* 評価値グラフ */}
      <EvalGraph
        analyses={sortedAnalyses}
        currentMove={moveIndex}
        onClickMove={setMoveIndex}
      />

      <div className="flex gap-6 flex-wrap">
        {/* 盤面 */}
        <div className="flex flex-col gap-1">
          <HandDisplay hand={currentState.hand.gote} side="gote" />
          <BoardGrid state={currentState} />
          <HandDisplay hand={currentState.hand.sente} side="sente" />
        </div>

        {/* 評価値・最善手情報 */}
        <div className="flex flex-col gap-3 min-w-64">
          {/* 直前の指し手 */}
          {currentAnalysis?.movePlayed && moveIndex > 0 && (
            <div>
              <div className="text-sm text-base-content/60">指し手</div>
              <div className="text-lg font-bold">
                {turnSymbol(moveIndex - 1)}
                {usiToJapaneseWithPiece(
                  positions[moveIndex - 1],
                  currentAnalysis.movePlayed,
                )}
              </div>
            </div>
          )}

          {/* 局面評価値 */}
          {posEval && (
            <div>
              <div className="text-sm text-base-content/60">
                局面評価値（先手視点）
              </div>
              <div className="text-lg font-semibold">{posEval}</div>
            </div>
          )}

          {/* 最善手との比較 */}
          {best && !isBestMove && currentAnalysis?.movePlayed && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
              <div className="mb-1 text-sm font-semibold text-warning">
                最善手と異なります
              </div>
              <div>
                <span className="text-sm text-base-content/60">最善手: </span>
                <span className="font-bold">
                  {turnSymbol(moveIndex)}
                  {usiToJapaneseWithPiece(currentState, best.move)}
                </span>
              </div>
              <div>
                <span className="text-sm text-base-content/60">評価値: </span>
                {formatScore(best.scoreType, best.scoreValue, moveIndex)}
              </div>
              {best.pv && best.pv.length > 0 && (
                <div className="mt-1">
                  <span className="text-sm text-base-content/60">
                    読み筋:{' '}
                  </span>
                  <span className="font-mono text-xs">
                    {(() => {
                      let st = applyMove(currentState, best.move);
                      return best.pv
                        .map((m: string, j: number) => {
                          const turn = turnSymbol(moveIndex + j);
                          const text = usiToJapaneseWithPiece(st, m);
                          st = applyMove(st, m);
                          return `${turn}${text}`;
                        })
                        .join(' ');
                    })()}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* 候補手一覧 */}
          {currentAnalysis && currentAnalysis.candidates.length > 0 && (
            <div>
              <div className="mb-1 text-sm text-base-content/60">候補手</div>
              <table className="table table-xs">
                <tbody>
                  {currentAnalysis.candidates.map((c) => (
                    <tr
                      key={c.rank}
                      className={clsx(
                        c.move === currentAnalysis.movePlayed && 'bg-base-200',
                      )}
                    >
                      <td className="font-mono">{c.rank}</td>
                      <td className="font-bold">
                        {turnSymbol(moveIndex)}
                        {usiToJapaneseWithPiece(currentState, c.move)}
                      </td>
                      <td>
                        {formatScore(c.scoreType, c.scoreValue, moveIndex)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
