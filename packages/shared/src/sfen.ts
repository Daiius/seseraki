/**
 * SFEN の読み書き（prd/12 §2.5）。
 *
 * 書き出しは局面索引が既に持っている（`position.ts` の `positionSfen`）。ここに置くのは
 * **読み込み**だけ。
 *
 * - 検討モードの局面は web が作って SFEN 文字列で server へ送る。server は
 *   エンジンに渡す前に検証する（`position-validation.ts`）ため、盤面へ戻す必要がある。
 * - USI の `position sfen …` は手数まで含む 4 フィールドを要求する。局面キー（`positionSfen`）は
 *   手数を持たないので、エンジンに渡す側が手数を補う（`usi/named-evaluation.ts`）。
 *
 * ⚠ **環境非依存**（`lib: esnext` / `types: []`）。
 */
import type { BoardState, Hand, Square } from './board';
import type { PieceKind, Side } from './pieces';

/** SFEN の駒文字（大文字）→ 駒種。成りは `+` を前置して表す */
const CHAR_PIECE: Record<string, PieceKind> = {
  P: 'P', L: 'L', N: 'N', S: 'S', G: 'G', B: 'B', R: 'R', K: 'K',
};

/** 持ち駒に置ける駒種（玉と成駒は入らない） */
const HAND_PIECE: Record<string, PieceKind> = {
  P: 'P', L: 'L', N: 'N', S: 'S', G: 'G', B: 'B', R: 'R',
};

/** 1 段（9 マス）を読む。読めなければ null */
function parseRank(rank: string): Square[] | null {
  const row: Square[] = [];
  let promoted = false;
  for (const char of rank) {
    if (char === '+') {
      // `+` の直後は駒文字でなければならない（`++P` や `+3` は読めない）
      if (promoted) return null;
      promoted = true;
      continue;
    }
    if (char >= '1' && char <= '9') {
      if (promoted) return null;
      for (let i = 0; i < Number(char); i++) row.push(null);
      continue;
    }
    const upper = char.toUpperCase();
    const base = CHAR_PIECE[upper];
    if (!base) return null;
    // 玉は成れない
    if (promoted && (base === 'K' || base === 'G')) return null;
    const kind = (promoted ? `+${base}` : base) as PieceKind;
    promoted = false;
    row.push({ kind, side: char === upper ? 'sente' : 'gote' });
  }
  if (promoted) return null;
  return row.length === 9 ? row : null;
}

/** 持ち駒フィールドを読む。読めなければ null */
function parseHands(field: string): Hand | null {
  const hand: Hand = { sente: {}, gote: {} };
  if (field === '-') return hand;
  let count = '';
  for (const char of field) {
    if (char >= '0' && char <= '9') {
      // 先頭 0 の枚数（`0P` / `01P`）は書き手の異常を示すので受け取らない
      if (count === '' && char === '0') return null;
      count += char;
      continue;
    }
    const upper = char.toUpperCase();
    const kind = HAND_PIECE[upper];
    if (!kind) return null;
    const side: Side = char === upper ? 'sente' : 'gote';
    const n = count === '' ? 1 : Number(count);
    count = '';
    hand[side][kind] = (hand[side][kind] ?? 0) + n;
  }
  return count === '' ? hand : null;
}

/**
 * SFEN 文字列を盤面へ戻す。読めなければ `null`。
 *
 * 手数フィールド（4 番目）は**あってもなくてもよく、値は使わない**。局面キーは手数を
 * 持たない 3 フィールド（`positionSfen`）なので、どちらの形でも受け取れるようにする。
 *
 * ⚠ ここが見るのは**書式**だけ。駒数や二歩といった中身の検証は
 * `validatePositionForEngine`（`position-validation.ts`）の担当。
 */
export function parseSfen(sfen: string): BoardState | null {
  const fields = sfen.trim().split(/\s+/);
  if (fields.length < 3 || fields.length > 4) return null;
  const [boardField, turnField, handField] = fields;

  const ranks = boardField.split('/');
  if (ranks.length !== 9) return null;
  const board: Square[][] = [];
  for (const rank of ranks) {
    const row = parseRank(rank);
    if (!row) return null;
    board.push(row);
  }

  if (turnField !== 'b' && turnField !== 'w') return null;
  const hand = parseHands(handField);
  if (!hand) return null;

  return { board, hand, sideToMove: turnField === 'b' ? 'sente' : 'gote' };
}
