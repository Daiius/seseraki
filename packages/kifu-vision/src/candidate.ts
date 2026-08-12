/**
 * 「起こりうる手」を先に並べて、読みといちばん整合するものを選ぶ
 *
 * `inferMove` は差分から手を導く。**読めたマスが足りていれば強い**が、
 * 移動先が未確定だと「どの駒がそこへ来たか」が決まらず、成ったかどうかも
 * 決められない（`solveUnknowns` が曖昧として諦めるのはここ）。
 *
 * 向きを逆にすると、その困りかたが消える。合法手はルールで閉じた集合なので、
 * **未確定のマスは「情報が無い」として飛ばせばよい**——読めたマスだけで
 * 候補が 1 つに絞れることが多い。
 *
 * ⚠ **読みの置き換えではない。** 追跡中の盤面が間違っていれば候補も丸ごと
 * 間違う（誤りが自己強化する）。`inferMove` で決まらなかったときの
 * second opinion として使う。
 */

import type { BoardState, Square } from 'shared';
import { generateMoves, type CandidateMove } from './movegen.ts';
import { isUnknown, type VisionSquare } from './uncertain.ts';

export interface CandidateScore {
  move: CandidateMove;
  /** 読めたマスのうち、この手の結果と食い違った数 */
  conflicts: number;
  /** 読めたマスのうち、この手の結果と一致した数 */
  agrees: number;
  /** この手を指した後の盤面 */
  board: Square[][];
}

function applyToBoard(board: Square[][], move: CandidateMove): Square[][] {
  const next = board.map((r) => r.slice());
  if (move.from) next[move.from.row][move.from.col] = null;
  next[move.to.row][move.to.col] = { kind: move.becomes, side: move.side };
  return next;
}

function sameSquare(a: Square, b: Square): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.side === b.side;
}

/**
 * 候補手それぞれについて、読みとどれだけ合うかを数える。
 *
 * ⚠ **未確定のマスは数えない**（一致にも食い違いにも入れない）。
 * 「読めなかった」ことを「違っていた」と混ぜると、正しい候補が沈む。
 *
 * ⚠ 追跡中の盤面に古い読み違えが残っていると、**すべての候補に等しく
 * 食い違いが乗る**。だから「食い違いが 0 か」ではなく「食い違いが最も
 * 少ないのが 1 つに決まるか」で判断する。
 */
export function scoreCandidates(
  before: BoardState,
  read: VisionSquare[][],
  moves: CandidateMove[],
): CandidateScore[] {
  return moves.map((move) => {
    const board = applyToBoard(before.board, move);
    let conflicts = 0;
    let agrees = 0;
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const seen = read[row][col];
        if (isUnknown(seen)) continue;
        if (sameSquare(seen, board[row][col])) agrees++;
        else conflicts++;
      }
    }
    return { move, conflicts, agrees, board };
  });
}

export type PickFailure =
  /** 候補が 1 つも無い（詰んでいるか、盤面が壊れている） */
  | 'no-candidates'
  /** いちばん合う候補が複数あり、決められない */
  | 'ambiguous'
  /** いちばん合う候補でも食い違いが多すぎる。1 手では説明が付かない */
  | 'too-many-conflicts';

export interface PickResult {
  best: CandidateScore | null;
  failure: PickFailure | null;
  /** 同点で並んだ候補（`ambiguous` のとき中身が入る） */
  tied: CandidateScore[];
}

export interface PickOptions {
  /**
   * 採用してよい食い違いの上限。
   *
   * 0 にすると、追跡中の盤面に古い誤りが 1 つでもあると何も選べなくなる。
   * 1 なら「読めているマスが 1 つだけずれている」までは許す。
   */
  maxConflicts?: number;
  /**
   * どちらの手番か分からないときに true。両者の手を候補に入れる。
   *
   * 途中の局面から仕切り直したときは手番が分からない。候補が倍になるが、
   * **狭める方に間違えると正しい手が消える**ので、分からないなら広く取る。
   */
  anySide?: boolean;
  /**
   * 同点になったときの決め手。小さいほど良い候補として並べ替える。
   *
   * 成るか成らないかで割れたときに、**移動先のマスの絵**を見て決めるために使う。
   * ⭐ ここが効くのは「候補が必ず X か +X の 2 つ」だからで、
   * **生駒のテンプレートは必ず持っている**ため、成駒のテンプレートが
   * 1 枚も無くても決められる。
   */
  tieBreak?: (a: CandidateScore, b: CandidateScore) => number;
}

/**
 * 読みといちばん整合する手を 1 つ選ぶ。
 *
 * 決められなければ理由を返す。**曖昧なまま選ぶくらいなら選ばない**——
 * 誤った手を 1 つ通すと、以後の盤面がすべてずれる。
 */
export function pickCandidate(
  before: BoardState,
  read: VisionSquare[][],
  options: PickOptions = {},
): PickResult {
  const maxConflicts = options.maxConflicts ?? 1;
  const moves = options.anySide
    ? [
        ...generateMoves({ ...before, sideToMove: 'sente' }),
        ...generateMoves({ ...before, sideToMove: 'gote' }),
      ]
    : generateMoves(before);
  if (moves.length === 0) return { best: null, failure: 'no-candidates', tied: [] };

  const scored = scoreCandidates(before, read, moves).sort((a, b) => a.conflicts - b.conflicts);
  const least = scored[0].conflicts;
  if (least > maxConflicts) return { best: null, failure: 'too-many-conflicts', tied: [] };

  let tied = scored.filter((s) => s.conflicts === least);
  if (tied.length > 1 && options.tieBreak) {
    tied = [...tied].sort(options.tieBreak);
    // 決め手が本当に差を付けられたときだけ 1 つに絞る
    if (options.tieBreak(tied[0], tied[1]) < 0) return { best: tied[0], failure: null, tied };
  }
  if (tied.length > 1) return { best: null, failure: 'ambiguous', tied };
  return { best: tied[0], failure: null, tied };
}
