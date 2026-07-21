import { useRef, useState, type ReactNode, type Ref } from 'react';
import clsx from 'clsx';
import {
  applyMove,
  usiToJapaneseWithPiece,
  type BoardState,
  type PieceKind,
} from '../lib/board';
import { turnSymbol, formatScore, detectBlunders, toSenteEval } from '../lib/usi';
import { resolveUserSide } from '../lib/self';
import { EvalGraph } from './EvalGraph';

const PIECE_DISPLAY: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

const HAND_ORDER: PieceKind[] = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
const COL_LABELS = [9, 8, 7, 6, 5, 4, 3, 2, 1];
const ROW_LABELS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

const ICON_PROPS = {
  xmlns: 'http://www.w3.org/2000/svg',
  fill: 'none',
  viewBox: '0 0 24 24',
  strokeWidth: 2,
  stroke: 'currentColor',
  className: 'size-5',
} as const;

const IconChevronDoubleLeft = () => (
  <svg {...ICON_PROPS}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M18.75 19.5l-7.5-7.5 7.5-7.5m-6 15L5.25 12l7.5-7.5" />
  </svg>
);
const IconChevronLeft = () => (
  <svg {...ICON_PROPS}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
  </svg>
);
const IconChevronRight = () => (
  <svg {...ICON_PROPS}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
  </svg>
);
const IconChevronDoubleRight = () => (
  <svg {...ICON_PROPS}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 4.5l7.5 7.5-7.5 7.5m-6-15l7.5 7.5-7.5 7.5" />
  </svg>
);
const IconFlip = () => (
  <svg {...ICON_PROPS}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
  </svg>
);

interface Analysis {
  id: number;
  moveNumber: number;
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
  usiMoves: string[];
  /** usiMoves から構築済みの全局面（ページ側で 1 度だけ構築して渡す） */
  positions: BoardState[];
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
    <div className="text-sm lg:text-base flex items-center">
      <span className="font-semibold">{symbol}{label}</span>
      <span className="ml-auto">{pieces.length > 0 ? pieces.join(' ') : 'なし'}</span>
    </div>
  );
}

/** USI の手から移動先の [row, col] を取得 */
function lastMoveDestination(usiMove: string): [number, number] | null {
  // 駒打ち: "B*5c" → "5c"
  const dropMatch = usiMove.match(/^[PLNSGBR]\*(\d[a-i])$/);
  if (dropMatch) {
    const col = 9 - Number(dropMatch[1][0]);
    const row = dropMatch[1].charCodeAt(1) - 97;
    return [row, col];
  }
  // 通常の移動: "7g7f" or "7g7f+" → "7f"
  const moveMatch = usiMove.match(/^\d[a-i](\d[a-i])\+?$/);
  if (moveMatch) {
    const col = 9 - Number(moveMatch[1][0]);
    const row = moveMatch[1].charCodeAt(1) - 97;
    return [row, col];
  }
  return null;
}

function BoardGrid({ state, lastMoveTo, flipped }: { state: BoardState; lastMoveTo: [number, number] | null; flipped: boolean }) {
  const colLabels = flipped ? [...COL_LABELS].reverse() : COL_LABELS;
  const rowLabels = flipped ? [...ROW_LABELS].reverse() : ROW_LABELS;
  const rowOrder = flipped ? [8, 7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const colOrder = flipped ? [8, 7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7, 8];

  return (
    <div className="inline-grid grid-cols-[repeat(9,2rem)_1.25rem] grid-rows-[1rem_repeat(9,2rem)] md:grid-cols-[repeat(9,2.5rem)_1.5rem] md:grid-rows-[1.25rem_repeat(9,2.5rem)] lg:grid-cols-[repeat(9,3rem)_1.75rem] lg:grid-rows-[1.5rem_repeat(9,3rem)] xl:grid-cols-[repeat(9,3.5rem)_2rem] xl:grid-rows-[1.75rem_repeat(9,3.5rem)]">
      {/* 筋番号（1行目） */}
      {colLabels.map((col) => (
        <div
          key={`col-${col}`}
          className="flex items-end justify-center text-[10px] md:text-xs lg:text-sm text-base-content/50"
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
          return (
            <div
              key={`${rowIdx}-${colIdx}`}
              className={clsx(
                'size-8 md:size-10 lg:size-12 xl:size-14 border border-base-300 flex items-center justify-center text-sm md:text-base lg:text-lg xl:text-xl font-bold',
                isLastMove && 'bg-primary/15',
              )}
            >
              {sq && (
                <span
                  className={clsx(
                    'inline-block',
                    (flipped ? sq.side === 'sente' : sq.side === 'gote') && 'rotate-180 text-error',
                  )}
                >
                  {PIECE_DISPLAY[sq.kind]}
                </span>
              )}
            </div>
          );
        }),
        <div
          key={`row-${ri}`}
          className="flex items-center justify-center text-[10px] md:text-xs lg:text-sm text-base-content/50"
        >
          {rowLabels[ri]}
        </div>,
      ])}
    </div>
  );
}

export function ShogiBoard({ usiMoves, positions, analyses, sente, gote }: Props) {
  const sortedAnalyses = [...analyses].sort((a, b) => a.moveNumber - b.moveNumber);
  const blunders = detectBlunders(sortedAnalyses, usiMoves);
  const { side: userSide, ambiguous: userAmbiguous } = resolveUserSide(sente, gote);

  const totalMoves = positions.length - 1;
  const [moveIndex, setMoveIndex] = useState(0);
  const [flipped, setFlipped] = useState(userSide === 'gote');
  const [branchRank, setBranchRank] = useState<number | null>(null);
  const [branchDepth, setBranchDepth] = useState(0);
  const candidateListRef = useRef<HTMLDivElement>(null);

  const goToMain = (newIndex: number) => {
    setMoveIndex(newIndex);
    setBranchRank(null);
    setBranchDepth(0);
    // 本筋を進めたら、開いている候補手 details は内容が変わるので自動で閉じる
    candidateListRef.current
      ?.querySelectorAll<HTMLDetailsElement>('details[open]')
      .forEach((d) => {
        d.open = false;
      });
  };

  // moveIndex N の盤面 = N 手指した後の局面
  // この局面に至った手の解析 = moveNumber N-1 の解析結果
  // moveIndex 0 の場合は moveNumber 0（初期局面からの候補手）
  const prevAnalysis = sortedAnalyses.find(
    (a) => a.moveNumber === (moveIndex > 0 ? moveIndex - 1 : 0),
  );

  // 現在の局面（moveIndex）の解析 → 実手後の局面評価値
  const currentAnalysis = sortedAnalyses.find(
    (a) => a.moveNumber === moveIndex,
  );
  const currentBest = currentAnalysis?.candidates.find((c) => c.rank === 1);
  const posEval = currentBest
    ? formatScore(currentBest.scoreType, currentBest.scoreValue, moveIndex)
    : null;

  const evalMoveNumber = moveIndex > 0 ? moveIndex - 1 : 0;

  // 分岐モード判定と分岐用データの算出
  const branchCandidate = branchRank !== null
    ? prevAnalysis?.candidates.find((c) => c.rank === branchRank) ?? null
    : null;
  const branchPv = branchCandidate?.pv ?? null;
  const branchActive = branchRank !== null
    && branchDepth > 0
    && branchPv !== null
    && branchPv.length > 0;

  // 表示用：盤面・直前手・直前手前局面・直前手の手番
  let displayState: BoardState;
  let displayedMove: string | undefined;
  let displayedMovePreState: BoardState | undefined;
  let displayedMoveNum = 0;

  if (branchActive && branchPv) {
    const base = positions[evalMoveNumber];
    let st = base;
    let preSt = base;
    for (let i = 0; i < branchDepth; i++) {
      preSt = st;
      st = applyMove(st, branchPv[i]);
    }
    displayState = st;
    displayedMove = branchPv[branchDepth - 1];
    displayedMovePreState = preSt;
    displayedMoveNum = evalMoveNumber + (branchDepth - 1);
  } else {
    displayState = positions[moveIndex];
    if (moveIndex > 0) {
      displayedMove = usiMoves[moveIndex - 1];
      displayedMovePreState = positions[moveIndex - 1];
      displayedMoveNum = moveIndex - 1;
    }
  }

  const lastMoveTo = displayedMove ? lastMoveDestination(displayedMove) : null;

  const posEvalText = branchActive && branchCandidate
    ? formatScore(branchCandidate.scoreType, branchCandidate.scoreValue, evalMoveNumber)
    : posEval;

  const onBranchForward = (rank: number, pv: string[]) => {
    if (branchRank === rank) {
      setBranchDepth(Math.min(branchDepth + 1, pv.length));
    } else {
      setBranchRank(rank);
      setBranchDepth(1);
    }
  };

  const onBranchBack = (rank: number) => {
    if (branchRank !== rank) return;
    const next = branchDepth - 1;
    if (next <= 0) {
      setBranchRank(null);
      setBranchDepth(0);
    } else {
      setBranchDepth(next);
    }
  };

  return (
    <div className="flex flex-col">
      {userAmbiguous && (
        <div className="alert alert-warning mb-2 text-sm">
          両対局者とも自分の名前候補に一致しています（先手={sente} / 後手={gote}）。
          自分視点の表示（盤の向き・悪手ハイライト等）は無効化しました。
        </div>
      )}
      {/* スクロール時に上端へ固定するグループ: 盤面 + コンパクト行 + コントローラー */}
      <div className="sticky top-0 z-10 bg-base-100 shadow-sm flex flex-col gap-3 pb-2">
      {/* 盤面 */}
      <div className="flex flex-col gap-1 max-w-fit mx-auto md:mx-0">
        <HandDisplay
          hand={flipped ? displayState.hand.sente : displayState.hand.gote}
          side={flipped ? 'sente' : 'gote'}
          name={flipped ? sente : gote}
        />
        <BoardGrid state={displayState} lastMoveTo={lastMoveTo} flipped={flipped} />
        <HandDisplay
          hand={flipped ? displayState.hand.gote : displayState.hand.sente}
          side={flipped ? 'gote' : 'sente'}
          name={flipped ? gote : sente}
        />
      </div>

      {/* コンパクト情報行: 指し手 | 評価値 | 手数/N + 分岐バッジ */}
      <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap text-sm max-w-3xl">
        {displayedMove && displayedMovePreState ? (
          <span className="font-bold text-base whitespace-nowrap">
            {turnSymbol(displayedMoveNum)}
            {usiToJapaneseWithPiece(displayedMovePreState, displayedMove)}
          </span>
        ) : (
          <span className="text-base-content/40 whitespace-nowrap">初期局面</span>
        )}
        {posEvalText && (
          <span
            className={clsx(
              'font-semibold whitespace-nowrap',
              branchActive && 'text-base-content/50',
            )}
          >
            {posEvalText}
          </span>
        )}
        <div className="ml-auto flex items-baseline gap-2 whitespace-nowrap">
          <span className="font-mono text-base-content/60">
            {moveIndex} / {totalMoves}
          </span>
          {branchActive && (
            <span className="badge badge-sm badge-primary">分岐</span>
          )}
        </div>
      </div>

      {/* コントローラー行 */}
      <div className="flex items-center gap-2 max-w-3xl">
        <button
          className="btn btn-outline md:btn-sm"
          onClick={() => goToMain(0)}
          disabled={!branchActive && moveIndex === 0}
          title="最初へ"
        >
          <IconChevronDoubleLeft />
        </button>
        <button
          className="btn btn-outline flex-1 md:btn-sm md:flex-none"
          onClick={() => goToMain(Math.max(0, moveIndex - 1))}
          disabled={!branchActive && moveIndex === 0}
          title="戻る"
        >
          <IconChevronLeft />
        </button>
        <input
          type="range"
          min={0}
          max={totalMoves}
          value={moveIndex}
          onChange={(e) => goToMain(Number(e.target.value))}
          className="range range-sm flex-1 hidden md:block"
        />
        <button
          className="btn btn-outline flex-1 md:btn-sm md:flex-none"
          onClick={() => goToMain(Math.min(totalMoves, moveIndex + 1))}
          disabled={!branchActive && moveIndex === totalMoves}
          title="進む"
        >
          <IconChevronRight />
        </button>
        <button
          className="btn btn-outline md:btn-sm"
          onClick={() => goToMain(totalMoves)}
          disabled={!branchActive && moveIndex === totalMoves}
          title="最後へ"
        >
          <IconChevronDoubleRight />
        </button>
        <button
          className="btn btn-outline md:btn-sm"
          onClick={() => setFlipped(!flipped)}
          title="盤面反転"
        >
          <IconFlip />
        </button>
      </div>
      </div>

      {/* スクロール領域: 候補手 + 評価値グラフ */}
      <div className="flex flex-col gap-3 pt-3">
        {/* 候補手一覧（読み筋付き） */}
        {prevAnalysis && prevAnalysis.candidates.length > 0 && (
          <div className="max-w-3xl">
            <CandidateList
              ref={candidateListRef}
              candidates={prevAnalysis.candidates}
              played={moveIndex > 0 ? usiMoves[moveIndex - 1] : undefined}
              evalMoveNumber={evalMoveNumber}
              positions={positions}
              moveIndex={moveIndex}
              isBlunder={blunders.has(evalMoveNumber)}
              branchRank={branchRank}
              branchDepth={branchDepth}
              onBranchForward={onBranchForward}
              onBranchBack={onBranchBack}
            />
          </div>
        )}

        {/* 評価値グラフ */}
        <EvalGraph
          analyses={sortedAnalyses}
          currentMove={moveIndex}
          onClickMove={goToMain}
          blunders={blunders}
          userSide={userSide}
          branch={
            branchActive && branchCandidate
              ? {
                  moveNumber: evalMoveNumber + 1,
                  value: toSenteEval(
                    branchCandidate.scoreType,
                    branchCandidate.scoreValue,
                    evalMoveNumber,
                  ),
                }
              : null
          }
        />
      </div>
    </div>
  );
}

function CandidateList({
  ref,
  candidates,
  played,
  evalMoveNumber,
  positions,
  moveIndex,
  isBlunder,
  branchRank,
  branchDepth,
  onBranchForward,
  onBranchBack,
}: {
  ref?: Ref<HTMLDivElement>;
  candidates: Analysis['candidates'];
  played: string | undefined;
  evalMoveNumber: number;
  positions: BoardState[];
  moveIndex: number;
  isBlunder: boolean;
  branchRank: number | null;
  branchDepth: number;
  onBranchForward: (rank: number, pv: string[]) => void;
  onBranchBack: (rank: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const INITIAL_COUNT = 3;
  const hasMore = candidates.length > INITIAL_COUNT;
  const visible = expanded ? candidates : candidates.slice(0, INITIAL_COUNT);

  return (
    <div ref={ref}>
      <div className="mb-1 text-sm text-base-content/60">候補手</div>
      <div className="flex flex-col gap-2">
        {visible.map((c) => {
          const isPlayed = played && c.move === played;
          const isNotBest = c.rank === 1 && played && !isPlayed;
          const prevState = positions[moveIndex > 0 ? moveIndex - 1 : 0];
          const isActiveBranch = branchRank === c.rank && branchDepth > 0;
          const pvLen = c.pv?.length ?? 0;
          const hasPv = pvLen > 0;
          return (
            <details
              name="candidates"
              key={c.rank}
              className={clsx(
                'group rounded-lg p-2 text-sm',
                isPlayed && 'bg-base-200',
                isNotBest && (isBlunder ? 'border border-error/30' : 'border border-warning/30'),
                isActiveBranch && 'border-l-4 border-l-primary pl-3',
              )}
            >
              <summary className="flex items-center gap-2 list-none cursor-pointer md:cursor-default [&::-webkit-details-marker]:hidden">
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
                  isBlunder
                    ? <span className="text-xs text-error">{turnSymbol(evalMoveNumber)}</span>
                    : <span className="text-xs text-warning">※</span>
                )}
                {hasPv && (
                  <span className="ml-auto text-xs text-base-content/40 md:hidden">
                    PV{pvLen} <span className="inline-block transition-transform group-open:rotate-180">▼</span>
                  </span>
                )}
              </summary>
              {hasPv && c.pv && (
                <>
                  <div className="mt-1 font-mono text-xs text-base-content/60 pl-5">
                    {(() => {
                      let st = prevState;
                      const activeIdx = isActiveBranch ? branchDepth - 1 : -1;
                      const nodes: ReactNode[] = [];
                      for (let j = 0; j < c.pv.length; j++) {
                        const turn = turnSymbol(evalMoveNumber + j);
                        const text = `${turn}${usiToJapaneseWithPiece(st, c.pv[j])}`;
                        if (j > 0) nodes.push(' ');
                        if (j === activeIdx) {
                          nodes.push(
                            <strong key={j} className="text-base-content font-bold">
                              {text}
                            </strong>,
                          );
                        } else {
                          nodes.push(<span key={j}>{text}</span>);
                        }
                        st = applyMove(st, c.pv[j]);
                      }
                      return nodes;
                    })()}
                  </div>
                  <div className="mt-2 flex items-center gap-2 pl-5">
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => onBranchBack(c.rank)}
                      disabled={!isActiveBranch}
                      title="分岐を戻る"
                    >
                      <IconChevronLeft />
                    </button>
                    <span className="text-sm font-mono text-base-content/60 w-12 text-center">
                      {isActiveBranch ? branchDepth : 0}/{pvLen}
                    </span>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => onBranchForward(c.rank, c.pv!)}
                      disabled={isActiveBranch && branchDepth >= pvLen}
                      title="分岐を進む"
                    >
                      <IconChevronRight />
                    </button>
                  </div>
                </>
              )}
            </details>
          );
        })}
      </div>
      {hasMore && (
        <button
          className="btn btn-ghost btn-xs w-full mt-1"
          onClick={() => setExpanded(!expanded)}
        >
          <span className={clsx('transition-transform', expanded && 'rotate-180')}>
            ▼
          </span>
        </button>
      )}
    </div>
  );
}
