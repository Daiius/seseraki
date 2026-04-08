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
  sente?: string | null;
  gote?: string | null;
}

function HandDisplay({
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
    <div className="text-sm flex items-center">
      <span className="font-semibold">{symbol}{label}</span>
      <span className="ml-auto">{pieces.length > 0 ? pieces.join(' ') : 'なし'}</span>
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

export function ShogiBoard({ analyses, sente, gote }: Props) {
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

  // moveIndex N の盤面 = N 手指した後の局面
  // この局面に至った手の解析 = moveNumber N-1 の解析結果
  // moveIndex 0 の場合は moveNumber 0（初期局面からの候補手）
  const prevAnalysis = sortedAnalyses.find(
    (a) => a.moveNumber === (moveIndex > 0 ? moveIndex - 1 : 0),
  );

  const best = prevAnalysis?.candidates.find((c) => c.rank === 1);
  const isBestMove =
    best && prevAnalysis?.movePlayed && best.move === prevAnalysis.movePlayed;
  const evalMoveNumber = moveIndex > 0 ? moveIndex - 1 : 0;
  const posEval = best
    ? formatScore(best.scoreType, best.scoreValue, evalMoveNumber)
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

      <div className="flex gap-6 flex-wrap">
        {/* 盤面 */}
        <div className="flex flex-col gap-1">
          <HandDisplay hand={currentState.hand.gote} side="gote" name={gote} />
          <BoardGrid state={currentState} />
          <HandDisplay hand={currentState.hand.sente} side="sente" name={sente} />
        </div>

        {/* 評価値・候補手情報 */}
        <div className="flex flex-col gap-3 min-w-64">
          {/* 直前の指し手（1つ前の局面の movePlayed がこの局面への手） */}
          {moveIndex > 0 && (() => {
            const prevAnalysis = sortedAnalyses.find(
              (a) => a.moveNumber === moveIndex - 1,
            );
            if (!prevAnalysis?.movePlayed) return null;
            return (
              <div>
                <div className="text-sm text-base-content/60">指し手</div>
                <div className="text-lg font-bold">
                  {turnSymbol(moveIndex - 1)}
                  {usiToJapaneseWithPiece(
                    positions[moveIndex - 1],
                    prevAnalysis.movePlayed,
                  )}
                </div>
              </div>
            );
          })()}

          {/* 局面評価値 */}
          {posEval && (
            <div>
              <div className="text-sm text-base-content/60">
                局面評価値（先手視点）
              </div>
              <div className="text-lg font-semibold">{posEval}</div>
            </div>
          )}

          {/* 候補手一覧（読み筋付き） */}
          {prevAnalysis && prevAnalysis.candidates.length > 0 && (
            <div>
              <div className="mb-1 text-sm text-base-content/60">候補手</div>
              <div className="flex flex-col gap-2">
                {prevAnalysis.candidates.map((c) => {
                  const isPlayed = c.move === prevAnalysis.movePlayed;
                  const isNotBest = c.rank === 1 && prevAnalysis.movePlayed && !isPlayed;
                  const prevState = positions[moveIndex > 0 ? moveIndex - 1 : 0];
                  return (
                    <div
                      key={c.rank}
                      className={clsx(
                        'rounded-lg p-2 text-sm',
                        isPlayed && 'bg-base-200',
                        isNotBest && 'border border-warning/30',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-base-content/50">
                          {c.rank}
                        </span>
                        <span className="font-bold">
                          {turnSymbol(evalMoveNumber)}
                          {usiToJapaneseWithPiece(prevState, c.move)}
                        </span>
                        <span className="text-base-content/70">
                          {formatScore(c.scoreType, c.scoreValue, evalMoveNumber)}
                        </span>
                        <span className="text-xs text-base-content/40">
                          d{c.depth}
                        </span>
                        {isPlayed && (
                          <span className="text-xs text-success">実手</span>
                        )}
                        {isNotBest && (
                          <span className="text-xs text-warning">※</span>
                        )}
                      </div>
                      {c.pv && c.pv.length > 0 && (
                        <div className="mt-1 font-mono text-xs text-base-content/60 pl-5">
                          {(() => {
                            let st = applyMove(prevState, c.move);
                            return c.pv!
                              .map((m: string, j: number) => {
                                const turn = turnSymbol(evalMoveNumber + j);
                                const text = usiToJapaneseWithPiece(st, m);
                                st = applyMove(st, m);
                                return `${turn}${text}`;
                              })
                              .join(' ');
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 評価値グラフ */}
      <EvalGraph
        analyses={sortedAnalyses}
        currentMove={moveIndex}
        onClickMove={setMoveIndex}
      />
    </div>
  );
}
