interface EvalPoint {
  moveNumber: number;
  /** 先手視点の評価値（cp）。mate の場合は ±3000 にクランプ */
  value: number;
}

interface EvalGraphProps {
  analyses: {
    moveNumber: number;
    candidates: { rank: number; scoreType: string; scoreValue: number }[];
  }[];
  /** 現在のスライダー位置（ハイライト用） */
  currentMove?: number;
  onClickMove?: (moveNumber: number) => void;
  /** 悪手と判定された手番のセット */
  blunders?: Set<number>;
  /** ユーザーの手番（'sente' | 'gote'）。相手の悪手は透明度を下げる */
  userSide?: 'sente' | 'gote' | null;
}

const CLAMP = 3000;
const HEIGHT = 120;
const PADDING_X = 32;
const PADDING_Y = 8;

function toSenteValue(
  scoreType: string,
  scoreValue: number,
  moveNumber: number,
): number {
  const v = moveNumber % 2 === 1 ? -scoreValue : scoreValue;
  if (scoreType === 'mate') return v > 0 ? CLAMP : -CLAMP;
  return Math.max(-CLAMP, Math.min(CLAMP, v));
}

export function EvalGraph({
  analyses,
  currentMove,
  onClickMove,
  blunders,
  userSide,
}: EvalGraphProps) {
  const points: EvalPoint[] = analyses
    .filter((a) => a.candidates.length > 0)
    .sort((a, b) => a.moveNumber - b.moveNumber)
    .map((a) => {
      const best = a.candidates.find((c) => c.rank === 1)!;
      return {
        moveNumber: a.moveNumber,
        value: toSenteValue(best.scoreType, best.scoreValue, a.moveNumber),
      };
    });

  if (points.length < 2) return null;

  const maxMove = points[points.length - 1].moveNumber;
  const width = Math.max(400, maxMove * 6 + PADDING_X * 2);
  const graphW = width - PADDING_X * 2;
  const graphH = HEIGHT - PADDING_Y * 2;
  const midY = PADDING_Y + graphH / 2;

  const toX = (moveNumber: number) =>
    PADDING_X + (moveNumber / maxMove) * graphW;
  const toY = (value: number) =>
    midY - (value / CLAMP) * (graphH / 2);

  // 塗りつぶし用パス（先手側=上、後手側=下）
  const fillPath =
    `M ${toX(points[0].moveNumber)} ${midY} ` +
    points.map((p) => `L ${toX(p.moveNumber)} ${toY(p.value)}`).join(' ') +
    ` L ${toX(points[points.length - 1].moveNumber)} ${midY} Z`;

  // 線のパス
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(p.moveNumber)} ${toY(p.value)}`)
    .join(' ');

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="w-full min-w-[400px]"
        style={{ height: HEIGHT }}
      >
        {/* 背景 */}
        <rect
          x={PADDING_X}
          y={PADDING_Y}
          width={graphW}
          height={graphH / 2}
          className="fill-base-200"
          opacity={0.5}
        />
        <rect
          x={PADDING_X}
          y={midY}
          width={graphW}
          height={graphH / 2}
          className="fill-base-300"
          opacity={0.5}
        />

        {/* 中央線（0点） */}
        <line
          x1={PADDING_X}
          y1={midY}
          x2={width - PADDING_X}
          y2={midY}
          className="stroke-base-content"
          strokeWidth={0.5}
          opacity={0.3}
        />

        {/* ラベル */}
        <text x={4} y={PADDING_Y + 12} className="fill-base-content" fontSize={10}>
          ▲
        </text>
        <text x={4} y={HEIGHT - PADDING_Y - 4} className="fill-base-content" fontSize={10}>
          △
        </text>

        {/* 塗りつぶし */}
        <path d={fillPath} className="fill-primary" opacity={0.15} />

        {/* 折れ線 */}
        <path
          d={linePath}
          className="stroke-primary"
          fill="none"
          strokeWidth={1.5}
        />

        {/* 現在位置のハイライト */}
        {currentMove !== undefined &&
          points.find((p) => p.moveNumber === currentMove) && (
            <circle
              cx={toX(currentMove)}
              cy={toY(points.find((p) => p.moveNumber === currentMove)!.value)}
              r={4}
              className="fill-primary stroke-base-100"
              strokeWidth={2}
            />
          )}

        {/* 悪手マーカー（先手▲/後手▽、相手の悪手は透明度を下げる） */}
        {blunders &&
          points
            .filter((p) => blunders.has(p.moveNumber - 1))
            .map((p) => {
              const cx = toX(p.moveNumber);
              const cy = toY(p.value);
              const size = 5;
              // blunder の moveNumber は p.moveNumber - 1（指した局面）
              const blunderMoveNumber = p.moveNumber - 1;
              const isSenteMove = blunderMoveNumber % 2 === 0;
              const isUserBlunder = !userSide || (userSide === 'sente' ? isSenteMove : !isSenteMove);
              // 先手=上向き三角(▲)、後手=下向き三角(▽)
              const pts = isSenteMove
                ? `${cx},${cy - size} ${cx - size},${cy + size} ${cx + size},${cy + size}`
                : `${cx},${cy + size} ${cx - size},${cy - size} ${cx + size},${cy - size}`;
              return (
                <polygon
                  key={`blunder-${p.moveNumber}`}
                  points={pts}
                  className="fill-error stroke-base-100"
                  strokeWidth={1}
                  opacity={isUserBlunder ? 1 : 0.35}
                />
              );
            })}

        {/* クリック領域 */}
        {onClickMove &&
          points.map((p) => (
            <rect
              key={p.moveNumber}
              x={toX(p.moveNumber) - graphW / maxMove / 2}
              y={PADDING_Y}
              width={graphW / maxMove}
              height={graphH}
              fill="transparent"
              className="cursor-pointer"
              onClick={() => onClickMove(p.moveNumber)}
            />
          ))}
      </svg>
    </div>
  );
}
