/**
 * 将棋盤面追跡
 *
 * USI の手を順に適用して各マスの駒を追跡する。
 * USI 座標: 列は 1-9（右から左）、行は a-i（上から下）
 * 内部配列: board[row][col] で row=0 が一段目（上）、col=0 が9筋（左端）
 *
 * 駒の定義は `pieces.ts`、USI の座標・指し手の書式は `usi-move.ts` にある。
 */

import {
  unpromoted,
  withPromotion,
  type HandPieceKind,
  type Piece,
  type PieceKind,
  type Side,
} from './pieces';
import { isOnBoard, usiToIndex, type SquareRef } from './usi-move';

export type Square = Piece | null;

/**
 * KIF の指し手に使う駒名（成香・成桂・成銀は 1 文字の `杏` / `圭` / `全`）。
 * ⚠ 局面の検証の説明文（`position-validation.ts`）は `成香` と書く。KIF の往復の都合なので統一しない。
 */
const PIECE_NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

/**
 * 初期配置を生成
 */
function initialBoard(): Square[][] {
  const board: Square[][] = Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => null),
  );

  const set = (row: number, col: number, kind: PieceKind, side: Side) => {
    board[row][col] = { kind, side };
  };

  // 後手（上側: row 0-2）
  set(0, 0, 'L', 'gote'); set(0, 1, 'N', 'gote'); set(0, 2, 'S', 'gote');
  set(0, 3, 'G', 'gote'); set(0, 4, 'K', 'gote'); set(0, 5, 'G', 'gote');
  set(0, 6, 'S', 'gote'); set(0, 7, 'N', 'gote'); set(0, 8, 'L', 'gote');
  set(1, 1, 'R', 'gote'); set(1, 7, 'B', 'gote');
  for (let c = 0; c < 9; c++) set(2, c, 'P', 'gote');

  // 先手（下側: row 6-8）
  for (let c = 0; c < 9; c++) set(6, c, 'P', 'sente');
  set(7, 1, 'B', 'sente'); set(7, 7, 'R', 'sente');
  set(8, 0, 'L', 'sente'); set(8, 1, 'N', 'sente'); set(8, 2, 'S', 'sente');
  set(8, 3, 'G', 'sente'); set(8, 4, 'K', 'sente'); set(8, 5, 'G', 'sente');
  set(8, 6, 'S', 'sente'); set(8, 7, 'N', 'sente'); set(8, 8, 'L', 'sente');

  return board;
}

export interface Hand {
  sente: Partial<Record<PieceKind, number>>;
  gote: Partial<Record<PieceKind, number>>;
}

/**
 * 局面。**不変（immutable）として扱う。**
 *
 * `applyMove` は変化した行・持ち駒だけを差し替えた新しい state を返し、
 * 変化のない行と駒オブジェクトは元の state と共有する（構造共有）。
 * そのため受け取った側は `board` / `hand` / `Piece` を破壊的に変更してはならない。
 */
export interface BoardState {
  board: Square[][];
  hand: Hand;
  sideToMove: Side;
}

/**
 * 初期盤面を返す
 */
export function createInitialState(): BoardState {
  return {
    board: initialBoard(),
    hand: { sente: {}, gote: {} },
    sideToMove: 'sente',
  };
}

/**
 * 指定マスだけを差し替えた board を返す（変化のない行は元の配列をそのまま共有する）。
 * updates は先頭から順に適用する（同じマスを 2 度指定した場合は後勝ち）。
 */
export function withSquares(
  board: Square[][],
  updates: [row: number, col: number, square: Square][],
): Square[][] {
  const next = [...board];
  for (const [row, col, square] of updates) {
    if (next[row] === board[row]) next[row] = [...board[row]];
    next[row][col] = square;
  }
  return next;
}

/**
 * 片側の持ち駒だけを差し替えた hand を返す
 */
export function withHand(
  hand: Hand,
  side: Side,
  pieces: Partial<Record<PieceKind, number>>,
): Hand {
  return side === 'sente'
    ? { sente: pieces, gote: hand.gote }
    : { sente: hand.sente, gote: pieces };
}

/** 駒をどこから動かすか: 盤上のマス、または `side` の持ち駒 */
export type Origin =
  | { square: SquareRef }
  | { hand: HandPieceKind; side: Side };

/**
 * 駒を動かす・取る・打つ**中核**。新しい盤面を返し、元の盤面は変更しない。
 *
 * 🔒 **USI の再生（`applyMove`）と盤面編集（`movePiece` / `dropFromHand`）はどちらもここを通す。**
 * 別々に持っていたころは、玉を取る・自分の駒の上・同じマスへの移動・持っていない駒の打ちで
 * 挙動が食い違っていた。
 *
 * **手番は触らない。規則（手番・駒の動き方・成れるか）も見ない**——それは呼び出し側の仕事。
 *
 * - 盤上から動かす: 移動元が空・移動元と移動先が同じなら `null`
 * - 持ち駒から打つ: その駒を持っていなければ `null`。**生駒のまま置く**（`promote` は見ない）
 * - 移動先が盤外なら `null`
 * - 移動先に駒があれば、**動かした側の持ち駒へ入る**（成駒は生駒に戻す）。自分の駒でも同じ
 *   （編集では「どけて置き換える」で、どけた駒の行き先を 1 つに決めておく）。
 *   ⚠ **玉は持ち駒にならない**——盤から消える（盤面編集の言葉では駒箱へ戻る）
 * - `promote` は移動後の成り状態（`withPromotion`。省略で元のまま・`true` で成る・`false` で生駒に戻す）
 *
 * 変化した行と、動かした側の持ち駒だけを差し替え、残りは元の state と共有する（`BoardState` の不変契約）。
 */
export function relocate(
  state: BoardState,
  origin: Origin,
  to: SquareRef,
  promote?: boolean,
): BoardState | null {
  if (!isOnBoard(to)) return null;

  let piece: Piece;
  const updates: [row: number, col: number, square: Square][] = [];
  if ('square' in origin) {
    const from = origin.square;
    if (!isOnBoard(from)) return null;
    if (from.row === to.row && from.col === to.col) return null;
    const moving = state.board[from.row][from.col];
    if (!moving) return null;
    piece = { kind: withPromotion(moving.kind, promote), side: moving.side };
    // 移動先 → 移動元の順（移動元と移動先が同じ手は上で弾いているので順序に意味は無い）
    updates.push([to.row, to.col, piece], [from.row, from.col, null]);
  } else {
    if ((state.hand[origin.side][origin.hand] ?? 0) <= 0) return null;
    piece = { kind: origin.hand, side: origin.side };
    updates.push([to.row, to.col, piece]);
  }

  // 動かした側の持ち駒（打った駒を減らし、どけた駒を足す）。変わらなければ元の参照のまま
  const side = piece.side;
  let pieces = state.hand[side];
  const bump = (kind: PieceKind, delta: number) => {
    if (pieces === state.hand[side]) pieces = { ...pieces };
    const n = (pieces[kind] ?? 0) + delta;
    if (n <= 0) delete pieces[kind];
    else pieces[kind] = n;
  };
  if ('hand' in origin) bump(origin.hand, -1);
  const displaced = state.board[to.row][to.col];
  if (displaced && displaced.kind !== 'K') bump(unpromoted(displaced.kind), 1);

  return {
    board: withSquares(state.board, updates),
    hand: pieces === state.hand[side] ? state.hand : withHand(state.hand, side, pieces),
    sideToMove: state.sideToMove,
  };
}

/**
 * USI の手を適用して新しい盤面を返す（元の盤面は変更しない）
 *
 * 変化したマス（移動元・移動先）と手番側の持ち駒だけを差分コピーし、
 * 残りは元の state と共有する（`BoardState` の不変契約が前提）。
 * 駒を動かす中身は `relocate`（盤面編集と共用）。
 */
export function applyMove(state: BoardState, usiMove: string): BoardState {
  const side = state.sideToMove;
  const nextSide: Side = side === 'sente' ? 'gote' : 'sente';

  let next: BoardState | null = null;
  // 駒打ち: "B*5c"
  const dropMatch = usiMove.match(/^([PLNSGBR])\*(\d[a-i])$/);
  // 通常の移動: "7g7f" or "7g7f+"
  const moveMatch = usiMove.match(/^(\d[a-i])(\d[a-i])(\+?)$/);
  if (dropMatch) {
    const [toR, toC] = usiToIndex(dropMatch[2]);
    next = relocate(
      state,
      { hand: dropMatch[1] as HandPieceKind, side },
      { row: toR, col: toC },
    );
  } else if (moveMatch) {
    const [, from, to, promote] = moveMatch;
    const [fromR, fromC] = usiToIndex(from);
    const [toR, toC] = usiToIndex(to);
    next = relocate(
      state,
      { square: { row: fromR, col: fromC } },
      { row: toR, col: toC },
      promote ? true : undefined,
    );
  }

  // パース不能な手・指せない手は盤面を変えずに手番だけ進める
  return next ? { ...next, sideToMove: nextSide } : { ...state, sideToMove: nextSide };
}

/**
 * USI の手列から各局面の盤面状態を生成
 * 返り値: [初期局面, 1手目後, 2手目後, ...]
 */
export function buildPositions(usiMoves: string[]): BoardState[] {
  let state = createInitialState();
  const positions: BoardState[] = [state];
  for (const move of usiMoves) {
    state = applyMove(state, move);
    positions.push(state);
  }
  return positions;
}

/**
 * 盤面上の指定マスの駒名を返す
 */
export function getPieceName(state: BoardState, usiSquare: string): string {
  const [row, col] = usiToIndex(usiSquare);
  const piece = state.board[row][col];
  return piece ? PIECE_NAMES[piece.kind] : '';
}

/**
 * USI の手を駒名付き日本語表記に変換
 * state はその手を指す前の盤面状態
 */
export function usiToJapaneseWithPiece(
  state: BoardState,
  usiMove: string,
): string {
  const COL: Record<string, string> = {
    '1': '１', '2': '２', '3': '３', '4': '４', '5': '５',
    '6': '６', '7': '７', '8': '８', '9': '９',
  };
  const ROW: Record<string, string> = {
    a: '一', b: '二', c: '三', d: '四', e: '五',
    f: '六', g: '七', h: '八', i: '九',
  };
  const ROW_NUM: Record<string, string> = {
    a: '1', b: '2', c: '3', d: '4', e: '5',
    f: '6', g: '7', h: '8', i: '9',
  };
  const PIECE: Record<string, string> = {
    P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛',
  };

  // 駒打ち
  const dropMatch = usiMove.match(/^([PLNSGBR])\*(\d)([a-i])$/);
  if (dropMatch) {
    const [, piece, col, row] = dropMatch;
    return `${COL[col]}${ROW[row]}${PIECE[piece]}打`;
  }

  // 通常移動
  const moveMatch = usiMove.match(/^(\d[a-i])(\d)([a-i])(\+?)$/);
  if (moveMatch) {
    const [, from, toCol, toRow, promote] = moveMatch;
    const pieceName = getPieceName(state, from);
    const dest = `${COL[toCol]}${ROW[toRow]}`;
    const fromCol = from[0];
    const fromRow = ROW_NUM[from[1]];
    const suffix = promote ? '成' : '';
    return `${dest}${pieceName}${suffix}(${fromCol}${fromRow})`;
  }

  return usiMove;
}
