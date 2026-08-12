/**
 * 2 つの配置の差分から指し手を復元する
 *
 * 合法手生成器は要らない。1 手で変わるマスは高々 2 つで、その組み合わせから
 * 手が一意に決まるためである。
 *
 *   移動（取らない）: 移動元が空になり、移動先が埋まる（2 マス）
 *   移動（取る）    : 移動元が空になり、移動先の駒が入れ替わる（2 マス）
 *   打ち            : 移動先が埋まるだけ（1 マス）
 *
 * 成りは移動先の駒が移動元の駒の成駒になっているかで判定できる。
 *
 * ここで導いた手が正しいかは、`shared` の `applyMove()` を適用した結果が
 * 次の配置と一致するかで確かめる（`verifyMove`）。`applyMove` は不正な手でも
 * 例外を投げずに読み飛ばす仕様なので、**呼べたことを成功と見なしてはいけない**。
 */

import type { PieceKind, Side, Square } from 'shared';
import { applyMove, createInitialState } from 'shared';
import { boardsEqual } from './recognize.ts';
import { canMove, canDrop } from './legality.ts';

/** 生駒 → 成駒 */
const PROMOTE_MAP: Partial<Record<PieceKind, PieceKind>> = {
  P: '+P', L: '+L', N: '+N', S: '+S', B: '+B', R: '+R',
};

/** 打てる駒（成駒と玉は打てない） */
const DROPPABLE: PieceKind[] = ['P', 'L', 'N', 'S', 'G', 'B', 'R'];

/** [row][col] → USI 座標。col 0 が 9 筋、row 0 が一段目。 */
export function toUsiSquare(row: number, col: number): string {
  return `${9 - col}${String.fromCharCode(97 + row)}`;
}

export type InferFailure =
  | 'no-change'
  | 'too-many-changes'
  | 'ambiguous'
  | 'illegal-shape'
  | 'promotion-mismatch'
  | 'undroppable'
  /**
   * 駒の動きとして有り得ない。
   *
   * `applyMove` の検算は「その手を指せばその配置になるか」しか見ないので、
   * 認識がずれると「銀が 7d から 8h へ飛ぶ」ような手が通ってしまう。
   * 駒の動きの方から弾く。
   */
  | 'illegal-move'
  /**
   * 駒が消えただけで、どこにも現れていない。
   *
   * そんな手は将棋に無いので、これは**駒がスライドしている途中**の絵である。
   * 移動元が空いてから移動先が埋まるまでの数フレーム、駒はマスの間にあって
   * どのマスにも属さない。
   *
   * 他の失敗と違い、これは「読み取れなかった」のではなく「読むべきでない絵を
   * 読んだ」ことを意味する。呼び出し側はこの区間を**無かったことにして**、
   * 次の区間と比べ直せばよい。
   */
  | 'piece-vanished'
  /**
   * 持っていない駒を打つ手だった。
   *
   * ⚠ `inferMove` 自身はここを判定できない（持ち駒を知らない）。追跡している
   * `BoardState` を持つ側が、導いた手を拒むときに使う名前として置いてある。
   *
   * マウスポインタや演出で駒が湧いて見えると、差分は「空 → 駒」になる。
   * これはちょうど打ちの形なので、持ち駒を見ないと弾けない。
   */
  | 'unheld-drop';

export interface InferredMove {
  usi: string;
  type: 'move' | 'drop';
  /** 指した側（動いた駒の持ち主） */
  side: Side;
  from?: { row: number; col: number };
  to: { row: number; col: number };
  /** 取った駒があれば */
  captured?: Square;
  promoted: boolean;
}

export interface InferResult {
  move: InferredMove | null;
  failure?: InferFailure;
  /** 食い違ったマスの数。1 手なら 1〜2。 */
  changedCells: number;
}

/**
 * 配置の差分から手を 1 つ導く。導けなければ理由を返す。
 *
 * 複数手が合成されている区間ではここが失敗するので、呼び出し側は
 * その区間を細かく探索し直す手がかりにできる。
 */
export function inferMove(before: Square[][], after: Square[][]): InferResult {
  /** 駒 → 空 */
  const vacated: { row: number; col: number; piece: Square }[] = [];
  /** 空 → 駒 */
  const filled: { row: number; col: number; piece: Square }[] = [];
  /** 駒 → 別の駒（取る手） */
  const replaced: { row: number; col: number; before: Square; after: Square }[] = [];

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const b = before[row][col];
      const a = after[row][col];
      if (!b && !a) continue;
      if (b && !a) vacated.push({ row, col, piece: b });
      else if (!b && a) filled.push({ row, col, piece: a });
      else if (b && a && (b.kind !== a.kind || b.side !== a.side)) {
        replaced.push({ row, col, before: b, after: a });
      }
    }
  }

  const changedCells = vacated.length + filled.length + replaced.length;
  if (changedCells === 0) return { move: null, failure: 'no-change', changedCells };
  if (changedCells > 2) return { move: null, failure: 'too-many-changes', changedCells };

  // 打ち: 埋まったマスが 1 つだけ
  if (vacated.length === 0 && replaced.length === 0 && filled.length === 1) {
    const { row, col, piece } = filled[0];
    if (!piece) return { move: null, failure: 'illegal-shape', changedCells };
    if (!DROPPABLE.includes(piece.kind)) {
      // 成駒や玉は打てない。認識間違いか、複数手ぶんが合成されている。
      return { move: null, failure: 'undroppable', changedCells };
    }
    if (!canDrop(piece.kind, { row }, piece.side)) {
      // 歩・香を最奥に、桂を奥 2 段に打つことはできない。
      return { move: null, failure: 'undroppable', changedCells };
    }
    return {
      move: {
        usi: `${piece.kind}*${toUsiSquare(row, col)}`,
        type: 'drop',
        side: piece.side,
        to: { row, col },
        promoted: false,
      },
      changedCells,
    };
  }

  // 移動: 空いたマスが 1 つ、埋まった or 入れ替わったマスが 1 つ
  if (vacated.length !== 1) return { move: null, failure: 'ambiguous', changedCells };
  const from = vacated[0];
  const moving = from.piece;
  if (!moving) return { move: null, failure: 'illegal-shape', changedCells };

  let to: { row: number; col: number; piece: Square };
  let captured: Square = null;
  if (filled.length === 1 && replaced.length === 0) {
    to = filled[0];
  } else if (filled.length === 0 && replaced.length === 1) {
    const r = replaced[0];
    // 取る手なら、元あった駒は相手の駒でなければならない
    if (!r.before || r.before.side === moving.side) {
      return { move: null, failure: 'illegal-shape', changedCells };
    }
    captured = r.before;
    to = { row: r.row, col: r.col, piece: r.after };
  } else if (filled.length === 0 && replaced.length === 0) {
    // 駒が消えただけ。そんな手は無いので、これはスライド途中の絵。
    return { move: null, failure: 'piece-vanished', changedCells };
  } else {
    return { move: null, failure: 'ambiguous', changedCells };
  }

  if (!to.piece || to.piece.side !== moving.side) {
    return { move: null, failure: 'illegal-shape', changedCells };
  }

  // 駒の動きとして有り得るか。ここを見ないと、認識ずれが作った出鱈目な手が
  // applyMove の検算をすり抜ける。
  if (!canMove(before, from, to, moving.kind, moving.side)) {
    return { move: null, failure: 'illegal-move', changedCells };
  }

  // 成りの判定
  let promoted: boolean;
  if (to.piece.kind === moving.kind) {
    promoted = false;
  } else if (PROMOTE_MAP[moving.kind] === to.piece.kind) {
    promoted = true;
  } else {
    // 移動元と移動先で駒の種類が繋がらない。別々の手が重なって見えている。
    return { move: null, failure: 'promotion-mismatch', changedCells };
  }

  return {
    move: {
      usi: `${toUsiSquare(from.row, from.col)}${toUsiSquare(to.row, to.col)}${promoted ? '+' : ''}`,
      type: 'move',
      side: moving.side,
      from: { row: from.row, col: from.col },
      to: { row: to.row, col: to.col },
      captured,
      promoted,
    },
    changedCells,
  };
}

/**
 * 導いた手が本当にその配置変化を生むかを確かめる。
 *
 * `applyMove` は不正な手を黙って読み飛ばすので、返ってきた盤面を
 * 実際に突き合わせるところまでやって初めて検証になる。
 */
export function verifyMove(before: Square[][], usi: string, side: Side, after: Square[][]): boolean {
  const state = { board: before, hand: { sente: {}, gote: {} }, sideToMove: side };
  return boardsEqual(applyMove(state, usi).board, after);
}

/** 手番が交互に進んでいるかを見る（認識の取りこぼしに気付くため） */
export function opposite(side: Side): Side {
  return side === 'sente' ? 'gote' : 'sente';
}

/** 平手初期配置 */
export function initialBoard(): Square[][] {
  return createInitialState().board;
}
