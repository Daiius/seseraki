/**
 * USI の座標と指し手（座標の変換・指し手の書式・解釈）。
 *
 * 🔒 **USI の座標・指し手の書式の定義はここ 1 か所。** 盤面の追跡・局面の検証・詰み筋の分類・
 * ブラウザ解析の報告の検証はすべてここから引く。
 *
 * - USI 座標: 筋は `1`-`9`（右から左）、段は `a`-`i`（上から下）
 * - 内部の盤: `board[row][col]` で row 0 = 一段目（上）、col 0 = 9 筋（左端）
 *
 * ⚠ **環境非依存**（`lib: esnext` / `types: []`）。
 */
import { isHandPieceKind, type HandPieceKind } from './pieces';

/** 盤上のマス。`state.board[row][col]` の添字そのもの（row 0 = 一段目 / col 0 = 9 筋） */
export interface SquareRef {
  row: number;
  col: number;
}

/**
 * 盤内のマスか。
 * ⚠ `Number.isInteger` が **`NaN` / `Infinity` / 小数を弾く**ので、マスを受け取る関数は
 * ここを通すだけで非有限値から守られる。
 */
export function isOnBoard(square: SquareRef): boolean {
  const { row, col } = square;
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 && row < 9 && col >= 0 && col < 9
  );
}

/** USI の指し手の書式（移動 `7g7f` / 成り `7g7f+` / 打ち `P*5e`） */
export const USI_MOVE_PATTERN = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;

/** USI の指し手の書式か（`resign` などの特別な語は含まない） */
export function isUsiMove(move: string): boolean {
  return USI_MOVE_PATTERN.test(move);
}

/**
 * USI 座標（例 `7g`）→ `[row, col]`。
 * ⚠ **書式は見ない**（`USI_MOVE_PATTERN` などで確かめた座標を渡す）。
 */
export function usiToIndex(usi: string): [row: number, col: number] {
  return [usi.charCodeAt(1) - 97, 9 - Number(usi[0])];
}

/** `[row, col]` → USI 座標（例 `7g`） */
export function indexToUsi(row: number, col: number): string {
  return `${9 - col}${String.fromCharCode(97 + row)}`;
}

/** 解釈した USI の指し手 */
export type UsiMove =
  | { type: 'drop'; piece: HandPieceKind; to: SquareRef }
  | { type: 'move'; from: SquareRef; to: SquareRef; promote: boolean };

const DROP = /^([PLNSGBR])\*([1-9][a-i])$/;
const MOVE = /^([1-9][a-i])([1-9][a-i])(\+?)$/;

function squareOf(usi: string): SquareRef {
  const [row, col] = usiToIndex(usi);
  return { row, col };
}

/** USI の指し手を解釈する。書式に合わなければ `null` */
export function parseUsiMove(move: string): UsiMove | null {
  const drop = DROP.exec(move);
  if (drop && isHandPieceKind(drop[1])) {
    return { type: 'drop', piece: drop[1], to: squareOf(drop[2]) };
  }
  const board = MOVE.exec(move);
  if (board) {
    return {
      type: 'move',
      from: squareOf(board[1]),
      to: squareOf(board[2]),
      promote: board[3] === '+',
    };
  }
  return null;
}
