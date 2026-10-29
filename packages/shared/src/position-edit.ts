/**
 * 検討盤のフル編集（prd/12 §3.2・M2a）。
 *
 * `BoardState` を受けて**新しい `BoardState` を返す純関数**だけを置く。
 *
 * 🔒 **合法性は問わない**（prd/12 §2.5）。駒の動き方も手番も見ない——検討盤は
 * 「銀が 1 つ横にいたら」のような**到達不能な仮想局面**を作るための道具で、
 * 合法手生成器は作らない方針。エンジンに渡せるかどうかの検証は評価の直前に
 * `validatePositionForEngine`（`position-validation.ts`）が別途行う。
 *
 * 🔒 **`BoardState` は不変**（`board.ts` の `BoardState` のコメント）。ここの関数は
 * 変化した行・持ち駒だけを差し替え、残りは元の state と共有する（構造共有）。
 * **元の state は決して書き換えない**（undo スタックが壊れるため）。
 *
 * 🔒 **駒箱は状態として持たない。** 盤上にも持ち駒にも無い駒が駒箱にある、という
 * 導出値でしかない。状態として持つと「盤 + 持ち駒 + 駒箱」の 3 つを常に整合させ続ける
 * 必要があり、フル編集ではそれが破れる。web の検討盤は駒箱を UI に出さない（prd/12 §3.2・決定 2026-08-28）。
 * 内訳を数える `pieceBox` はテストが駒の総数を確かめるのに使うだけなので `test-fixtures/` に置いた。
 *
 * 🔒 **不正な入力では state をそのまま返す**（例外を投げない）。UI は駒の無いマスや
 * 盤外を指してきうるし、投げると M2b が全操作を try/catch で包むことになる。
 * 「変化しなかった」ことは `next === prev` の同一性で判定できる。
 *
 * M2b（検討盤 UI）は**これらを組み合わせるだけ**で済むように、次の粒度で切ってある:
 *
 * | UI の操作 | 関数 |
 * |---|---|
 * | 駒を選ぶ → 空きマスを選ぶ | `movePiece` |
 * | 駒を選ぶ → 駒のあるマスを選ぶ（重ねる） | `movePiece`（どけた駒は動かした側の持ち駒へ） |
 * | 成 / 不成の切り替え | `setPromoted` |
 * | 盤から取り除く（駒箱へ戻す） | `removePiece` |
 * | 盤の駒を持ち駒へ | `moveToHand` |
 * | 持ち駒を盤へ打つ | `dropFromHand` |
 * | 駒箱から盤へ置く | `placePiece` |
 * | 持ち駒の増減 | `addToHand` / `setHandCount` |
 * | 手番の切り替え | `toggleSideToMove` |
 *
 * ⚠ **環境非依存**（`lib: esnext` / `types: []`）。`structuredClone` などは使わない。
 */
import {
  relocate,
  withHand,
  withSquares,
  type BoardState,
} from './board';
import {
  unpromoted,
  withPromotion,
  type HandPieceKind,
  type Piece,
  type PieceKind,
  type Side,
} from './pieces';
import { isOnBoard, type SquareRef } from './usi-move';

/** 指定マスの駒（空きマス・盤外は null） */
export function pieceAt(state: BoardState, square: SquareRef): Piece | null {
  return isOnBoard(square) ? state.board[square.row][square.col] : null;
}

/** 持ち駒の枚数（持っていなければ 0） */
export function handCount(
  state: BoardState,
  side: Side,
  kind: HandPieceKind,
): number {
  return state.hand[side][kind] ?? 0;
}

/**
 * 片側の持ち駒を `count` 枚にする。
 *
 * `count <= 0` は「持っていない」状態にする（キー自体を落とす）——`applyMove` が
 * 0 枚になったキーを消すのと同じ形に揃え、SFEN の書き出しを一意に保つため。
 */
export function setHandCount(
  state: BoardState,
  side: Side,
  kind: HandPieceKind,
  count: number,
): BoardState {
  // 🔒 **非有限値は受け取らない**（レビュー指摘 `OCL-F71E8296`）。`Math.max` / `Math.trunc` は
  // `NaN` / `Infinity` をそのまま通すので、持ち駒に入ると `positionSfen` が
  // `InfinityP` のような読めない SFEN を書き出す。不正な入力は state をそのまま返す。
  if (!Number.isFinite(count)) return state;
  const current = handCount(state, side, kind);
  const next = Math.max(0, Math.trunc(count));
  if (next === current) return state;
  const pieces: Partial<Record<PieceKind, number>> = { ...state.hand[side] };
  if (next === 0) delete pieces[kind];
  else pieces[kind] = next;
  return { ...state, hand: withHand(state.hand, side, pieces) };
}

/** 持ち駒を `delta` 枚増やす（負なら減らす）。0 枚未満にはしない */
export function addToHand(
  state: BoardState,
  side: Side,
  kind: HandPieceKind,
  delta = 1,
): BoardState {
  // `delta` が非有限なら足し算の結果も非有限になる。`setHandCount` でも止まるが、
  // 「不正な入力はここで断つ」ことを呼び出し口で示しておく
  if (!Number.isFinite(delta)) return state;
  return setHandCount(state, side, kind, handCount(state, side, kind) + delta);
}

/**
 * 盤上の駒を取り除く（= 駒箱へ戻す）。持ち駒には触らない。
 * 空きマス・盤外なら state をそのまま返す。
 */
export function removePiece(state: BoardState, square: SquareRef): BoardState {
  if (!pieceAt(state, square)) return state;
  return {
    ...state,
    board: withSquares(state.board, [[square.row, square.col, null]]),
  };
}

/**
 * 駒箱から盤へ置く（持ち駒には触らない）。
 *
 * 置き先に駒があれば**駒箱へ戻る**（持ち駒には行かない）——駒箱からの出し入れは
 * 「その形にする」操作であって、取った・取られたではないため。
 */
export function placePiece(
  state: BoardState,
  square: SquareRef,
  piece: Piece,
): BoardState {
  if (!isOnBoard(square)) return state;
  return {
    ...state,
    board: withSquares(state.board, [[square.row, square.col, piece]]),
  };
}

/**
 * 盤上の駒を持ち駒へ移す。**成駒は生駒に戻す**（持ち駒に成りは無い）。
 *
 * `side` を省くとその駒の持ち主が持つ。相手に取られた形にしたいときは `side` を渡す。
 * ⚠ **玉は持ち駒にできない**ので、盤から取り除くだけ（= 駒箱へ）にする。
 */
export function moveToHand(
  state: BoardState,
  square: SquareRef,
  side?: Side,
): BoardState {
  const piece = pieceAt(state, square);
  if (!piece) return state;
  const removed = removePiece(state, square);
  const kind = unpromoted(piece.kind);
  if (kind === 'K') return removed;
  return addToHand(removed, side ?? piece.side, kind as HandPieceKind, 1);
}

/**
 * 持ち駒を盤へ打つ。持ち駒を 1 枚減らして置く。
 *
 * - 持っていない駒種なら **state をそのまま返す**（駒を増やさない）
 * - 置き先に駒があれば、`movePiece` と同じく**打った側の持ち駒**へ入る（成駒は生駒に戻す。玉は駒箱へ）
 * - 生駒のまま置く（成った駒を打った形は `setPromoted` で作れる）
 *
 * 中身は `applyMove` と共用の `relocate`（`board.ts`）。
 */
export function dropFromHand(
  state: BoardState,
  side: Side,
  kind: HandPieceKind,
  square: SquareRef,
): BoardState {
  return relocate(state, { hand: kind, side }, square) ?? state;
}

/**
 * 盤上の駒を任意のマスへ動かす（**合法性は問わない**）。
 *
 * - 移動先に駒があれば、**動かした駒の持ち主の持ち駒**へ入る（成駒は生駒に戻す）。
 *   自分の駒に重ねた場合も同じ扱いにする——編集操作としては「そのマスの駒をどけて
 *   置き換える」であり、どけた駒の行き先は 1 つに決めておく方が予測しやすい。
 *   ⚠ 玉は持ち駒にできないので駒箱へ戻る（`moveToHand` と同じ）。
 * - `promote` を渡すと移動後の成り状態を指定する（`true` = 成る / `false` = 成らない）。
 *   省略すると元の駒のまま動く。成れない駒種に `true` を渡しても成らない。
 * - 移動元が空・盤外、または移動元と移動先が同じなら state をそのまま返す。
 *
 * 中身は `applyMove` と共用の `relocate`（`board.ts`）。手番は触らない。
 */
export function movePiece(
  state: BoardState,
  from: SquareRef,
  to: SquareRef,
  options: { promote?: boolean } = {},
): BoardState {
  return relocate(state, { square: from }, to, options.promote) ?? state;
}

/**
 * 盤上の駒の成り状態を切り替える。
 * 成れない駒種（金・玉）は何も起きない。空きマス・盤外も state をそのまま返す。
 */
export function setPromoted(
  state: BoardState,
  square: SquareRef,
  promoted: boolean,
): BoardState {
  const piece = pieceAt(state, square);
  if (!piece) return state;
  const kind = withPromotion(piece.kind, promoted);
  if (kind === piece.kind) return state;
  return placePiece(state, square, { kind, side: piece.side });
}

/** 手番を入れ替える（prd/12 §2.3。手番を問わず評価できる） */
export function toggleSideToMove(state: BoardState): BoardState {
  return { ...state, sideToMove: state.sideToMove === 'sente' ? 'gote' : 'sente' };
}
