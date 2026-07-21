import { useEffect, useState } from 'react';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { LinePath, AreaClosed } from '@visx/shape';
import {
  formatLoss,
  labelOf,
  labelText,
  type MoveLoss,
  type Thresholds,
} from '../lib/cpl';

interface EvalPoint {
  moveNumber: number;
  /** 先手視点の評価値（cp）。mate の場合は ±3000 にクランプ */
  value: number;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 47.99rem)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 47.99rem)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

interface EvalGraphProps {
  analyses: {
    moveNumber: number;
    candidates: { rank: number; scoreType: string; scoreValue: number }[];
  }[];
  /** 現在のスライダー位置（ハイライト用） */
  currentMove?: number;
  onClickMove?: (moveNumber: number) => void;
  /** 実手ごとの CPL（キーは実手を指す前の局面）。悪手・詰み系マーカーの元 */
  losses?: Map<number, MoveLoss>;
  thresholds?: Thresholds;
  /** ユーザーの手番（'sente' | 'gote'）。相手の悪手は透明度を下げる */
  userSide?: 'sente' | 'gote' | null;
  /**
   * 分岐モード中の分岐手評価値プロット。
   * moveNumber はプロット位置（分岐手を指した後の局面番号）、value は
   * 先手視点に変換済みの評価値（cp、mate は ±3000 にクランプ）。
   * 視点変換は分岐元の解析局面の手番を基準にすべきでプロット位置の手番ではないため、
   * 呼び出し側で計算した値を渡してもらう。
   */
  branch?: {
    moveNumber: number;
    value: number;
  } | null;
}

const CLAMP = 3000;
/**
 * 詰み系マーカーの色。**短手数ほど真っ赤**、長手数ほど通常の悪手マーカー（`--color-error`）の赤に
 * 近づける（prd/05-analysis.md §2.4）。長手数の詰みは気づくのが困難なので、短手数の見逃しほど
 * 強く目立たせる。飽和手数に強い根拠は無く「これ以上は気づけなくて当然」の目安（表示の濃淡であって
 * 判定の閾値ではないため、多少ずれても判定結果は変わらない）。
 */
const MATE_VIVID = 'oklch(0.62 0.28 27)';
const MATE_MOVES_SATURATE = 17;
function mateColor(moves: number): string {
  const t = Math.max(
    0,
    Math.min(1, (MATE_MOVES_SATURATE - moves) / (MATE_MOVES_SATURATE - 1)),
  );
  return `color-mix(in oklab, ${MATE_VIVID} ${Math.round(t * 100)}%, var(--color-error))`;
}
const HEIGHT_DESKTOP = 120;
const HEIGHT_MOBILE = 180;
const PADDING_X_DESKTOP = 32;
const PADDING_X_MOBILE = 14;
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
  losses,
  thresholds,
  userSide,
  branch,
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

  const pointByMove = new Map(points.map((p) => [p.moveNumber, p]));
  // マーカーは実手後の局面（moveNumber + 1）に置く。詰みで終わった棋譜は最終局面の解析が無く
  // 点が存在しないため、その手を指す前の局面に置いて末尾に出す（頓死を見えなくしないため）。
  // 疑問手はグラフに出さない——俯瞰の用途では悪手と詰み系に絞る（prd/05-analysis.md §2.4）。
  const markers =
    losses && thresholds
      ? [...losses.values()].flatMap((loss) => {
          const label = labelOf(loss, thresholds);
          if (label !== 'blunder' && label !== 'mate') return [];
          const point =
            pointByMove.get(loss.moveNumber + 1) ?? pointByMove.get(loss.moveNumber);
          if (!point) return [];
          const isSenteMove = loss.moveNumber % 2 === 0;
          return [
            {
              loss,
              label,
              point,
              isSenteMove,
              isUserMove: !userSide || (userSide === 'sente' ? isSenteMove : !isSenteMove),
            },
          ];
        })
      : [];

  const isMobile = useIsMobile();
  const HEIGHT = isMobile ? HEIGHT_MOBILE : HEIGHT_DESKTOP;
  const PADDING_X = isMobile ? PADDING_X_MOBILE : PADDING_X_DESKTOP;
  // 手あたりの最低密度（px/手）。コンテナがこれで足りれば幅いっぱいに追従し、
  // 足りない（＝非常に長い棋譜）ときだけ下限幅まで広げて横スクロールさせる。
  const minSpacing = isMobile ? 2 : 6;

  if (points.length < 2) return null;

  const maxMove = points[points.length - 1].moveNumber;
  const minWidth = maxMove * minSpacing + PADDING_X * 2;

  return (
    <div className="w-full overflow-x-auto">
      {/* ParentSize は既定でラッパーが height:100% になり、親に高さがないと 0 に潰れて
          SVG がレイアウト高さを持たず下の要素と重なる。高さを固定して領域を確保する。 */}
      <ParentSize parentSizeStyles={{ width: '100%', height: HEIGHT }}>
        {({ width: avail }) => {
          // ParentSize はマウント直後に 0 を返すことがある。レイアウトジャンプを避けるため
          // 高さだけ確保したプレースホルダを描く。
          if (avail === 0) return <div style={{ height: HEIGHT }} />;

          const width = Math.max(minWidth, avail);
          const graphW = width - PADDING_X * 2;
          const graphH = HEIGHT - PADDING_Y * 2;

          const xScale = scaleLinear<number>({
            domain: [0, maxMove],
            range: [PADDING_X, width - PADDING_X],
          });
          const yScale = scaleLinear<number>({
            domain: [CLAMP, -CLAMP],
            range: [PADDING_Y, HEIGHT - PADDING_Y],
          });
          const toX = (moveNumber: number) => xScale(moveNumber);
          const toY = (value: number) => yScale(value);
          const midY = yScale(0);

          return (
            <svg width={width} height={HEIGHT} className="block max-w-none">
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

              {/* 塗りつぶし（評価値0の中央線を基準に上下へ）。
                  AreaClosed は y0 未指定だと yScale.range()[0]（＝上端）を基準に閉じるため、
                  中央線基準にするには y0 を明示する必要がある。 */}
              <AreaClosed<EvalPoint>
                data={points}
                x={(p) => toX(p.moveNumber)}
                y={(p) => toY(p.value)}
                y0={() => midY}
                yScale={yScale}
                className="fill-primary"
                opacity={0.15}
              />

              {/* 折れ線 */}
              <LinePath<EvalPoint>
                data={points}
                x={(p) => toX(p.moveNumber)}
                y={(p) => toY(p.value)}
                className="stroke-primary"
                strokeWidth={1.5}
                fill="none"
              />

              {/* 現在位置のハイライト */}
              {currentMove !== undefined && (
                <line
                  x1={toX(currentMove)}
                  x2={toX(currentMove)}
                  y1={PADDING_Y}
                  y2={HEIGHT - PADDING_Y}
                  className="stroke-primary"
                  strokeWidth={1}
                  opacity={0.6}
                />
              )}
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

              {/*
                視覚要素の意味を三分離する（prd/05-analysis.md §2.4）:
                形（× / ▲▽）= 詰み系か悪手か / 色の赤さ = 詰み手数 / 透明度 = 自分か相手か。
              */}
              {markers.map(({ loss, label, point, isSenteMove, isUserMove }) => {
                const cx = toX(point.moveNumber);
                const cy = toY(point.value);
                const size = 5;
                const title = `${loss.moveNumber + 1}手目 ${labelText(loss, label)}${
                  formatLoss(loss) ? `（${formatLoss(loss)}）` : ''
                }`;

                if (label === 'mate' && loss.mate) {
                  const stroke = mateColor(loss.mate.moves);
                  const cross = [
                    [cx - size, cy - size, cx + size, cy + size],
                    [cx - size, cy + size, cx + size, cy - size],
                  ];
                  return (
                    <g key={`mark-${loss.moveNumber}`} opacity={isUserMove ? 1 : 0.35}>
                      <title>{title}</title>
                      {/* 折れ線に重なっても形が読めるよう背景色で縁取ってから色を乗せる */}
                      {cross.map(([x1, y1, x2, y2], i) => (
                        <line
                          key={`halo-${i}`}
                          x1={x1} y1={y1} x2={x2} y2={y2}
                          className="stroke-base-100"
                          strokeWidth={5}
                          strokeLinecap="round"
                        />
                      ))}
                      {cross.map(([x1, y1, x2, y2], i) => (
                        <line
                          key={`cross-${i}`}
                          x1={x1} y1={y1} x2={x2} y2={y2}
                          stroke={stroke}
                          strokeWidth={2.5}
                          strokeLinecap="round"
                        />
                      ))}
                    </g>
                  );
                }

                // 先手=上向き三角(▲)、後手=下向き三角(▽)
                const pts = isSenteMove
                  ? `${cx},${cy - size} ${cx - size},${cy + size} ${cx + size},${cy + size}`
                  : `${cx},${cy + size} ${cx - size},${cy - size} ${cx + size},${cy - size}`;
                return (
                  <polygon
                    key={`mark-${loss.moveNumber}`}
                    points={pts}
                    className="fill-error stroke-base-100"
                    strokeWidth={1}
                    opacity={isUserMove ? 1 : 0.35}
                  >
                    <title>{title}</title>
                  </polygon>
                );
              })}

              {/* 分岐手の評価値プロット */}
              {branch && (() => {
                const bx = toX(branch.moveNumber);
                const by = toY(branch.value);
                const fork = points.find((p) => p.moveNumber === branch.moveNumber - 1);
                return (
                  <g>
                    {fork && (
                      <line
                        x1={toX(fork.moveNumber)}
                        y1={toY(fork.value)}
                        x2={bx}
                        y2={by}
                        className="stroke-success"
                        strokeWidth={1.5}
                        strokeDasharray="3 2"
                        opacity={0.8}
                      />
                    )}
                    <circle
                      cx={bx}
                      cy={by}
                      r={4}
                      className="fill-success stroke-base-100"
                      strokeWidth={2}
                    />
                    <text
                      x={bx + 6}
                      y={by + 3}
                      fontSize={9}
                      className="fill-success"
                    >
                      分岐
                    </text>
                  </g>
                );
              })()}

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
          );
        }}
      </ParentSize>
    </div>
  );
}
