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
 * **導出値**として扱う（`pieceBox`）。状態として持つと「盤 + 持ち駒 + 駒箱」の 3 つを
 * 常に整合させ続ける必要があり、フル編集ではそれが破れる。
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
 * | 手番の切り替え | `toggleSideToMove` / `setSideToMove` |
 *
 * ⚠ **環境非依存**（`lib: esnext` / `types: []`）。`structuredClone` などは使わない。
 */
import {
  PROMOTE_MAP,
  UNPROMOTE_MAP,
  withHand,
  withSquares,
  type BoardState,
  type Hand,
  type Piece,
  type PieceKind,
  type Side,
} from './board';

/** 盤上のマス。`state.board[row][col]` の添字そのもの（row 0 = 一段目 / col 0 = 9 筋） */
export interface SquareRef {
  row: number;
  col: number;
}

/** 持ち駒に置ける駒種（玉と成駒は入らない） */
export type HandPieceKind = 'P' | 'L' | 'N' | 'S' | 'G' | 'B' | 'R';

/** 駒箱に入りうる駒種（= 生駒。玉を含む） */
export type BasePieceKind = HandPieceKind | 'K';

/** 駒種ごとの総数（盤上 + 双方の持ち駒 + 駒箱）。成駒は生駒として数える */
export const PIECE_TOTALS: Record<BasePieceKind, number> = {
  P: 18, L: 4, N: 4, S: 4, G: 4, B: 2, R: 2, K: 2,
};

/** 駒箱の内訳（`pieceBox` の返り値） */
export type PieceBox = Record<BasePieceKind, number>;

const BASE_KINDS: readonly BasePieceKind[] = [
  'P', 'L', 'N', 'S', 'G', 'B', 'R', 'K',
];

/**
 * 盤内のマスか。
 * ⚠ `Number.isInteger` が **`NaN` / `Infinity` / 小数を弾く**ので、マスを受け取る関数は
 * ここを通すだけで非有限値から守られる（持ち駒の枚数は `setHandCount` が自前で見る）。
 */
function inBoard(square: SquareRef): boolean {
  const { row, col } = square;
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 && row < 9 && col >= 0 && col < 9
  );
}

/** 成駒なら生駒に戻す。生駒はそのまま */
export function unpromoted(kind: PieceKind): PieceKind {
  return UNPROMOTE_MAP[kind] ?? kind;
}

/** その駒種は成れるか（金と玉は成れない） */
export function canPromote(kind: PieceKind): boolean {
  return PROMOTE_MAP[kind] !== undefined;
}

/** 成り状態を指定した駒種（`promote` 省略時は元のまま。成れない駒種は変わらない） */
function withPromotion(kind: PieceKind, promote?: boolean): PieceKind {
  if (promote === undefined) return kind;
  return promote ? (PROMOTE_MAP[kind] ?? kind) : unpromoted(kind);
}

/** 指定マスの駒（空きマス・盤外は null） */
export function pieceAt(state: BoardState, square: SquareRef): Piece | null {
  return inBoard(square) ? state.board[square.row][square.col] : null;
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
  if (!inBoard(square)) return state;
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
 * - 置き先に駒があれば `placePiece` と同じく駒箱へ戻る
 * - 生駒のまま置く（成った駒を打った形は `setPromoted` で作れる）
 */
export function dropFromHand(
  state: BoardState,
  side: Side,
  kind: HandPieceKind,
  square: SquareRef,
): BoardState {
  if (!inBoard(square)) return state;
  if (handCount(state, side, kind) <= 0) return state;
  return placePiece(addToHand(state, side, kind, -1), square, { kind, side });
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
 */
export function movePiece(
  state: BoardState,
  from: SquareRef,
  to: SquareRef,
  options: { promote?: boolean } = {},
): BoardState {
  const piece = pieceAt(state, from);
  if (!piece || !inBoard(to)) return state;
  if (from.row === to.row && from.col === to.col) return state;

  // どけた駒を先に処理する（盤から消し、動かした側の持ち駒へ入れる）
  const next = state.board[to.row][to.col]
    ? moveToHand(state, to, piece.side)
    : state;

  const kind = withPromotion(piece.kind, options.promote);
  return {
    ...next,
    board: withSquares(next.board, [
      [to.row, to.col, { kind, side: piece.side }],
      [from.row, from.col, null],
    ]),
  };
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

/** 盤上の駒の側を入れ替える（自分の駒 ↔ 相手の駒）。成り状態は保つ */
export function flipPieceSide(
  state: BoardState,
  square: SquareRef,
): BoardState {
  const piece = pieceAt(state, square);
  if (!piece) return state;
  return placePiece(state, square, {
    kind: piece.kind,
    side: piece.side === 'sente' ? 'gote' : 'sente',
  });
}

/** 手番を指定する */
export function setSideToMove(state: BoardState, side: Side): BoardState {
  return state.sideToMove === side ? state : { ...state, sideToMove: side };
}

/** 手番を入れ替える（prd/12 §2.3。手番を問わず評価できる） */
export function toggleSideToMove(state: BoardState): BoardState {
  return setSideToMove(state, state.sideToMove === 'sente' ? 'gote' : 'sente');
}

function countHand(
  hand: Hand,
  side: Side,
  used: Record<BasePieceKind, number>,
): void {
  for (const [kind, count] of Object.entries(hand[side])) {
    if (!count) continue;
    used[unpromoted(kind as PieceKind) as BasePieceKind] += count;
  }
}

/**
 * 駒箱（盤上にも持ち駒にも無い余り駒）の内訳。
 *
 * 総数（歩 18・香桂銀金各 4・角飛玉各 2）から盤上と双方の持ち駒を引く。
 * **成駒は生駒として数える**（と金は歩 1 枚）。
 *
 * ⚠ **0 で下限を打つ。** 駒が多すぎる局面（歩 19 枚など）は「箱の中がマイナス」ではなく
 * `validatePositionForEngine` の `piece_count_exceeded` が見る違反で、駒箱の責務ではない。
 *
 * ⚠ **web の検討盤はもう使わない**（prd/12 §3.2・決定 2026-08-28）。駒台が盤から抜いた駒の
 * 受け皿を兼ねるようになり、駒箱を UI に出す理由が無くなったため。ここに残してあるのは
 * 環境非依存の純関数で、server / MCP（prd/12 §4）が局面の内訳を説明するのに使えるから。
 */
export function pieceBox(state: BoardState): PieceBox {
  const used: Record<BasePieceKind, number> = {
    P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0, K: 0,
  };
  for (const row of state.board) {
    for (const square of row) {
      if (square) used[unpromoted(square.kind) as BasePieceKind]++;
    }
  }
  countHand(state.hand, 'sente', used);
  countHand(state.hand, 'gote', used);

  const box = {} as PieceBox;
  for (const kind of BASE_KINDS) {
    box[kind] = Math.max(0, PIECE_TOTALS[kind] - used[kind]);
  }
  return box;
}

/** 空の盤（全部が駒箱に入っている状態）。編集の出発点として使える */
export function createEmptyState(): BoardState {
  return {
    board: Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, (): null => null),
    ),
    hand: { sente: {}, gote: {} },
    sideToMove: 'sente',
  };
}
