/**
 * 棋譜詳細の盤（`components/ShogiBoard.tsx`）に表示する局面の導出。描画には触れない純粋な部分。
 *
 * 盤は「本筋の手数（`moveIndex`）」と「候補手の読み筋をどこまで辿ったか（分岐）」の 2 つで決まる。
 */
import { applyMove, type BoardState } from 'shared';

/**
 * 直前の実手の解析の手数（= その手を指す前の局面）。
 * `moveIndex` N の盤面 = N 手指した後の局面で、この局面に至った手の解析は moveNumber N-1。
 * 初期局面（0）では 0 に丸める（初期局面からの候補手）
 */
export function evalMoveNumberOf(moveIndex: number): number {
  return moveIndex > 0 ? moveIndex - 1 : 0;
}

export interface KifuDisplay {
  /** 分岐を辿っているか（読み筋を 1 手以上進めている） */
  branchActive: boolean;
  /** 進めた手数（今の読み筋の長さで頭打ちにした値） */
  branchDepth: number;
  /** 盤に出す局面 */
  state: BoardState;
  /** 直前の手（初期局面では null） */
  lastMove: string | null;
  /** 直前の手を指す前の局面（符号を日本語にするのに使う。初期局面では null） */
  lastMovePreState: BoardState | null;
  /** 直前の手を指した局面の手数（手番の記号に使う） */
  lastMoveNumber: number;
}

/**
 * 表示する局面と直前の手を決める。
 *
 * 🔴 **進めた手数は今の読み筋の長さで頭打ちにする。** 分岐を開いたまま解析が進むと（quick → full・再解析）、
 * 同じ順位の読み筋が短くなることがある。頭打ちにしないと存在しない手を `applyMove` に渡して落ちる
 */
export function displayOf({
  positions,
  usiMoves,
  moveIndex,
  branchPv,
  branchDepth: storedBranchDepth,
}: {
  /** 本筋の全局面（`positions[n]` = n 手指した後） */
  positions: readonly BoardState[];
  usiMoves: readonly string[];
  moveIndex: number;
  /** 辿っている候補手の読み筋。分岐していなければ null */
  branchPv: readonly string[] | null;
  /** 読み筋を進めた手数（画面の状態。短くなった読み筋より長いことがある） */
  branchDepth: number;
}): KifuDisplay {
  const branchDepth = Math.min(storedBranchDepth, branchPv?.length ?? 0);
  if (branchPv !== null && branchDepth > 0) {
    // 分岐は直前の実手を指す前の局面から読み筋を辿る
    const from = evalMoveNumberOf(moveIndex);
    let state = positions[from];
    let preState = state;
    for (let i = 0; i < branchDepth; i++) {
      preState = state;
      state = applyMove(state, branchPv[i]);
    }
    return {
      branchActive: true,
      branchDepth,
      state,
      lastMove: branchPv[branchDepth - 1],
      lastMovePreState: preState,
      lastMoveNumber: from + (branchDepth - 1),
    };
  }
  const state = positions[moveIndex];
  if (moveIndex === 0) {
    return { branchActive: false, branchDepth, state, lastMove: null, lastMovePreState: null, lastMoveNumber: 0 };
  }
  return {
    branchActive: false,
    branchDepth,
    state,
    lastMove: usiMoves[moveIndex - 1],
    lastMovePreState: positions[moveIndex - 1],
    lastMoveNumber: moveIndex - 1,
  };
}
