// テスト専用（index.ts からは export しない）。編集の前後で駒の総数が保たれるかを確かめる道具。
import type { BoardState, Hand } from '../board';
import {
  BASE_PIECE_KINDS,
  PIECE_TOTALS,
  unpromoted,
  type BasePieceKind,
  type PieceKind,
  type Side,
} from '../pieces';

/** 駒箱の内訳（`pieceBox` の返り値） */
export type PieceBox = Record<BasePieceKind, number>;

function countHand(
  hand: Hand,
  side: Side,
  used: Record<BasePieceKind, number>,
): void {
  for (const [kind, count] of Object.entries(hand[side])) {
    if (!count) continue;
    used[unpromoted(kind as PieceKind)] += count;
  }
}

/**
 * 駒箱（盤上にも持ち駒にも無い余り駒）の内訳。
 *
 * 総数（歩 18・香桂銀金各 4・角飛玉各 2）から盤上と双方の持ち駒を引く。
 * **成駒は生駒として数える**（と金は歩 1 枚）。0 で下限を打つ（駒の超過は
 * `validatePositionForEngine` の `piece_count_exceeded` が見る）。
 *
 * web の検討盤は駒箱を UI に出さない（prd/12 §3.2・決定 2026-08-28）ので、ここはテストだけが使う。
 */
export function pieceBox(state: BoardState): PieceBox {
  const used: Record<BasePieceKind, number> = {
    P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0, K: 0,
  };
  for (const row of state.board) {
    for (const square of row) {
      if (square) used[unpromoted(square.kind)]++;
    }
  }
  countHand(state.hand, 'sente', used);
  countHand(state.hand, 'gote', used);

  const box = {} as PieceBox;
  for (const kind of BASE_PIECE_KINDS) {
    box[kind] = Math.max(0, PIECE_TOTALS[kind] - used[kind]);
  }
  return box;
}

/** 空の盤（全部が駒箱に入っている状態）。編集の出発点として使う */
export function createEmptyState(): BoardState {
  return {
    board: Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, (): null => null),
    ),
    hand: { sente: {}, gote: {} },
    sideToMove: 'sente',
  };
}
