/**
 * 評価値グラフ（`components/EvalGraph.tsx`）に描く点とマーカーの算出。描画には触れない純粋な部分。
 */
import { labelOf, type MoveLabel, type MoveLoss, type Thresholds } from 'shared';
import { toSenteEval } from './usi';

export interface EvalPoint {
  moveNumber: number;
  /** 先手視点の評価値（cp）。mate の場合は ±3000 にクランプ（`toSenteEval`） */
  value: number;
}

export interface EvalGraphAnalysis {
  moveNumber: number;
  candidates: { rank: number; scoreType: string; scoreValue: number }[];
}

/** 解析のある局面の最善手の評価値を、手数の順に先手視点の点にする（候補手の無い局面は飛ばす） */
export function evalPointsOf(analyses: readonly EvalGraphAnalysis[]): EvalPoint[] {
  return analyses
    .filter((a) => a.candidates.length > 0)
    .sort((a, b) => a.moveNumber - b.moveNumber)
    .flatMap((a) => {
      const best = a.candidates.find((c) => c.rank === 1);
      if (!best) return [];
      return [{ moveNumber: a.moveNumber, value: toSenteEval(best.scoreType, best.scoreValue, a.moveNumber) }];
    });
}

export interface EvalMarker {
  loss: MoveLoss;
  label: Extract<MoveLabel, 'blunder' | 'mate'>;
  /** マーカーを置く点 */
  point: EvalPoint;
  isSenteMove: boolean;
  /** 自分の手か（主体側が決まっていなければ全部自分の手として濃く描く） */
  isUserMove: boolean;
}

/**
 * 悪手・詰み系のマーカー。
 * - マーカーは実手後の局面（`moveNumber + 1`）に置く。詰みで終わった棋譜は最終局面の解析が無く
 *   点が存在しないため、その手を指す前の局面に置いて末尾に出す（頓死を見えなくしないため）
 * - 疑問手はグラフに出さない——俯瞰の用途では悪手と詰み系に絞る（prd/05-analysis.md §2.4）
 */
export function evalMarkersOf(
  points: readonly EvalPoint[],
  losses: Iterable<MoveLoss>,
  thresholds: Thresholds,
  userSide: 'sente' | 'gote' | null | undefined,
): EvalMarker[] {
  const pointByMove = new Map(points.map((p) => [p.moveNumber, p]));
  return [...losses].flatMap((loss) => {
    const label = labelOf(loss, thresholds);
    if (label !== 'blunder' && label !== 'mate') return [];
    const point = pointByMove.get(loss.moveNumber + 1) ?? pointByMove.get(loss.moveNumber);
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
  });
}
