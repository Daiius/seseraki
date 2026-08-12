/**
 * 差分が大きすぎるとき、間の局面を探して手をつなぐ
 *
 * 一定間隔で読むと、その間に 2 手以上進んでいることがある。差分は 3 マス以上に
 * なり、1 手として説明が付かない（`too-many-changes`）。実測では 1 局ぶんを
 * 通したときこれが 669 件出て、失敗の大半を占めた。
 *
 * ここで諦めて仕切り直すと**間の手を丸ごと失う**。代わりに 2 つの時刻の間を
 * 二分して中間の局面を読み、「1 手で説明が付く」ところまで細かくしていけば、
 * 落とした手を拾い直せる。
 *
 * 見に行くのは繋がらなかった区間だけなので、解説で静止している大半の時間帯には
 * 追加のデコードが要らない。
 */

import type { Square } from 'shared';
import { inferMove, verifyMove, type InferredMove } from './moves.ts';
import { boardsEqual } from './recognize.ts';

export interface BridgeOptions {
  /** これより短い間隔まで詰めても繋がらなければ諦める（秒） */
  minGapSec?: number;
  /** 二分を繰り返す上限 */
  maxDepth?: number;
}

export interface BridgeStep {
  time: number;
  move: InferredMove;
  board: Square[][];
}

/**
 * `fromBoard`（時刻 fromTime）から `toBoard`（時刻 toTime）までを、
 * 1 手ずつの列に分解する。分解できなければ null。
 *
 * @param readBoard その時刻の配置を読む。読めなければ null を返すこと。
 */
export function bridgeGap(
  fromTime: number,
  toTime: number,
  fromBoard: Square[][],
  toBoard: Square[][],
  toTimeOfBoard: number,
  readBoard: (t: number) => Square[][] | null,
  options: BridgeOptions = {},
  depth = 0,
): BridgeStep[] | null {
  const minGap = options.minGapSec ?? 0.2;
  const maxDepth = options.maxDepth ?? 6;

  if (boardsEqual(fromBoard, toBoard)) return [];

  // そのまま 1 手で繋がるか
  const direct = inferMove(fromBoard, toBoard);
  if (direct.move && verifyMove(fromBoard, direct.move.usi, direct.move.side, toBoard)) {
    return [{ time: toTimeOfBoard, move: direct.move, board: toBoard }];
  }

  if (depth >= maxDepth || toTime - fromTime <= minGap) return null;

  const mid = (fromTime + toTime) / 2;
  const midBoard = readBoard(mid);
  if (!midBoard) return null;

  // 🔴 中間が端のどちらかと同じでも、**諦めてはいけない**。
  // それは「二分しても進まない」のではなく「割った位置が外れていて、変化が
  // 片側に寄っている」だけ。変化のある側だけを詰め直せば、そこに手が見つかる。
  //
  // ⚠ ここで null を返していたせいで、二分探索は**実質的に働いていなかった**
  // （28 回試して拾えた手 4 件）。手と手の間隔は 1 秒足らずのことがあり、
  // 2 手ぶんの変化が 1 サンプルに収まると、中間はたいてい端のどちらかに寄る。
  if (boardsEqual(midBoard, fromBoard)) {
    return bridgeGap(mid, toTime, fromBoard, toBoard, toTimeOfBoard, readBoard, options, depth + 1);
  }
  if (boardsEqual(midBoard, toBoard)) {
    return bridgeGap(fromTime, mid, fromBoard, toBoard, toTimeOfBoard, readBoard, options, depth + 1);
  }

  const left = bridgeGap(fromTime, mid, fromBoard, midBoard, mid, readBoard, options, depth + 1);
  if (!left) return null;
  const right = bridgeGap(mid, toTime, midBoard, toBoard, toTimeOfBoard, readBoard, options, depth + 1);
  if (!right) return null;

  return [...left, ...right];
}
