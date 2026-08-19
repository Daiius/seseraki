/**
 * 検討局面の検証（prd/12 §2.5）。
 *
 * 🔒 **合法手生成器は作らない。** 検討盤はフル編集（到達不能な仮想局面も許す）を採るので、
 * 合法性は問わない。ここが見るのは「**エンジンをクラッシュ・ハングさせない**」ための最小限だけ:
 *
 * - 両玉の存在
 * - 二歩
 * - 行き所のない駒（1 段目の歩・香 / 1〜2 段目の桂。後手は上下逆）
 * - 駒数上限（歩 18・香桂銀金各 4・角飛玉各 2）
 * - 手番側が相手玉を即取れる状態
 *
 * ⚠ **これを通ってもエンジンが落ちる・返ってこない可能性は残る。** その場合は当該ジョブを
 * `failed` で完了させ、worker はエンジンを再起動して次へ進む（prd/12 §2.5）。
 *
 * ⚠ **環境非依存**（`lib: esnext` / `types: []`）。
 */
import type { BoardState, PieceKind, Side, Square } from './board';

/** 違反の種別。文言に依らず機械的に扱えるようにコードで持つ */
export type PositionViolationCode =
  | 'missing_king'
  | 'too_many_kings'
  | 'two_pawns'
  | 'stuck_piece'
  | 'piece_count_exceeded'
  | 'invalid_hand_piece'
  | 'king_capturable'
  | 'malformed_move'
  | 'no_such_piece';

export interface PositionViolation {
  code: PositionViolationCode;
  /** そのまま画面・LLM に出せる日本語の説明 */
  message: string;
}

export type PositionValidation =
  | { ok: true }
  | { ok: false; violations: PositionViolation[] };

/** 成駒 → 生駒。枚数を数えるときは成りを元に戻して数える */
const UNPROMOTED: Record<PieceKind, PieceKind> = {
  P: 'P', L: 'L', N: 'N', S: 'S', G: 'G', B: 'B', R: 'R', K: 'K',
  '+P': 'P', '+L': 'L', '+N': 'N', '+S': 'S', '+B': 'B', '+R': 'R',
};

/** 駒種ごとの総数（盤上 + 双方の持ち駒）の上限 */
const PIECE_LIMIT: Record<PieceKind, number> = {
  P: 18, L: 4, N: 4, S: 4, G: 4, B: 2, R: 2, K: 2,
  // 成駒は生駒に戻して数えるのでここは使わない（型を埋めるためだけに置く）
  '+P': 18, '+L': 4, '+N': 4, '+S': 4, '+B': 2, '+R': 2,
};

const PIECE_NAME: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '成香', '+N': '成桂', '+S': '成銀', '+B': '馬', '+R': '龍',
};

const SIDE_NAME: Record<Side, string> = { sente: '先手', gote: '後手' };

type Offset = readonly [row: number, col: number];

/** 先手から見た 1 マス移動（後手は行方向を反転する） */
const STEPS: Partial<Record<PieceKind, readonly Offset[]>> = {
  P: [[-1, 0]],
  N: [[-2, -1], [-2, 1]],
  S: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]],
  G: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]],
  K: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
  '+B': [[-1, 0], [1, 0], [0, -1], [0, 1]],
  '+R': [[-1, -1], [-1, 1], [1, -1], [1, 1]],
};
// 成金 4 種は金と同じ動き
STEPS['+P'] = STEPS.G;
STEPS['+L'] = STEPS.G;
STEPS['+N'] = STEPS.G;
STEPS['+S'] = STEPS.G;

/** 先手から見た走り（後手は行方向を反転する） */
const SLIDES: Partial<Record<PieceKind, readonly Offset[]>> = {
  L: [[-1, 0]],
  B: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  R: [[-1, 0], [1, 0], [0, -1], [0, 1]],
  '+B': [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  '+R': [[-1, 0], [1, 0], [0, -1], [0, 1]],
};

function inBoard(row: number, col: number): boolean {
  return row >= 0 && row < 9 && col >= 0 && col < 9;
}

/** 後手の駒は前後が逆になる（盤の座標は先手から見た向きで固定） */
function forward(offset: Offset, side: Side): Offset {
  return side === 'sente' ? offset : [-offset[0], offset[1]];
}

/**
 * `[row, col]` の駒が `[toRow, toCol]` を利いているか。
 *
 * ⚠ **利きだけを見る**（自陣の駒があるマスも「利いている」と数える）。ここでの用途は
 * 玉のマスに利きが届いているかの判定なので、それで足りる。
 */
function attacks(
  state: BoardState,
  row: number,
  col: number,
  toRow: number,
  toCol: number,
): boolean {
  const piece = state.board[row][col];
  if (!piece) return false;

  for (const offset of STEPS[piece.kind] ?? []) {
    const [dr, dc] = forward(offset, piece.side);
    if (row + dr === toRow && col + dc === toCol) return true;
  }

  for (const offset of SLIDES[piece.kind] ?? []) {
    const [dr, dc] = forward(offset, piece.side);
    let r = row + dr;
    let c = col + dc;
    while (inBoard(r, c)) {
      if (r === toRow && c === toCol) return true;
      // 駒に当たったらそこで止まる（その駒のマスまでは利いている）
      if (state.board[r][c]) break;
      r += dr;
      c += dc;
    }
  }

  return false;
}

/** `side` の駒が `[toRow, toCol]` を利いているか */
export function isAttackedBy(
  state: BoardState,
  side: Side,
  toRow: number,
  toCol: number,
): boolean {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = state.board[row][col];
      if (piece?.side !== side) continue;
      if (attacks(state, row, col, toRow, toCol)) return true;
    }
  }
  return false;
}

function findKing(state: BoardState, side: Side): [row: number, col: number] | null {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = state.board[row][col];
      if (piece && piece.side === side && piece.kind === 'K') return [row, col];
    }
  }
  return null;
}

/** 玉の枚数を数える（盤上のみ。持ち駒の玉は `invalid_hand_piece` で弾く） */
function countKings(state: BoardState, side: Side): number {
  let n = 0;
  for (const row of state.board) {
    for (const square of row) {
      if (square && square.side === side && square.kind === 'K') n++;
    }
  }
  return n;
}

/** 二歩（同じ筋に生の歩が 2 枚以上）を見つける */
function findTwoPawns(state: BoardState, side: Side): boolean {
  for (let col = 0; col < 9; col++) {
    let pawns = 0;
    for (let row = 0; row < 9; row++) {
      const piece = state.board[row][col];
      if (piece && piece.side === side && piece.kind === 'P') pawns++;
    }
    if (pawns >= 2) return true;
  }
  return false;
}

/**
 * 行き所のない駒か。
 * 先手は 1 段目（row 0）の歩・香と 1〜2 段目（row 0..1）の桂。後手は上下逆。
 */
function isStuck(square: NonNullable<Square>, row: number): boolean {
  // 先手から見た「敵陣の最奥から数えた段数」（0 = 最奥）
  const depth = square.side === 'sente' ? row : 8 - row;
  if (square.kind === 'P' || square.kind === 'L') return depth === 0;
  if (square.kind === 'N') return depth <= 1;
  return false;
}

/**
 * エンジンに渡してよい局面かを検証する。
 *
 * 失敗は server が 4xx で返す（エンジンには渡さない。prd/12 §2.5）。
 */
export function validatePositionForEngine(state: BoardState): PositionValidation {
  const violations: PositionViolation[] = [];

  // --- 両玉の存在 ---
  for (const side of ['sente', 'gote'] as const) {
    const kings = countKings(state, side);
    if (kings === 0) {
      violations.push({
        code: 'missing_king',
        message: `${SIDE_NAME[side]}の玉がありません`,
      });
    } else if (kings > 1) {
      violations.push({
        code: 'too_many_kings',
        message: `${SIDE_NAME[side]}の玉が ${kings} 枚あります`,
      });
    }
  }

  // --- 二歩 ---
  for (const side of ['sente', 'gote'] as const) {
    if (findTwoPawns(state, side)) {
      violations.push({
        code: 'two_pawns',
        message: `${SIDE_NAME[side]}に二歩があります`,
      });
    }
  }

  // --- 行き所のない駒 / 駒数の集計 ---
  const counts: Partial<Record<PieceKind, number>> = {};
  const stuck = new Set<string>();
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const square = state.board[row][col];
      if (!square) continue;
      const base = UNPROMOTED[square.kind];
      counts[base] = (counts[base] ?? 0) + 1;
      if (isStuck(square, row)) {
        stuck.add(`${square.side}:${square.kind}`);
      }
    }
  }
  for (const key of stuck) {
    const [side, kind] = key.split(':') as [Side, PieceKind];
    violations.push({
      code: 'stuck_piece',
      message: `${SIDE_NAME[side]}の${PIECE_NAME[kind]}に行き所がありません`,
    });
  }

  // --- 持ち駒（玉・成駒は入らない）と駒数上限 ---
  for (const side of ['sente', 'gote'] as const) {
    for (const [kind, n] of Object.entries(state.hand[side]) as [
      PieceKind,
      number,
    ][]) {
      if (n <= 0) continue;
      if (kind === 'K' || kind.startsWith('+')) {
        violations.push({
          code: 'invalid_hand_piece',
          message: `${SIDE_NAME[side]}の持ち駒に${PIECE_NAME[kind]}は置けません`,
        });
        continue;
      }
      counts[kind] = (counts[kind] ?? 0) + n;
    }
  }
  for (const [kind, n] of Object.entries(counts) as [PieceKind, number][]) {
    if (n > PIECE_LIMIT[kind]) {
      violations.push({
        code: 'piece_count_exceeded',
        message: `${PIECE_NAME[kind]}が ${n} 枚あります（上限 ${PIECE_LIMIT[kind]} 枚）`,
      });
    }
  }

  // --- 手番側が相手玉を即取れる状態 ---
  // 玉を取る手を読ませるとエンジンの前提（玉は盤上に在り続ける）が壊れる。
  // 玉が無い側については判定できないので飛ばす（`missing_king` で既に弾いている）。
  const opponent: Side = state.sideToMove === 'sente' ? 'gote' : 'sente';
  const king = findKing(state, opponent);
  if (king && isAttackedBy(state, state.sideToMove, king[0], king[1])) {
    violations.push({
      code: 'king_capturable',
      message: `${SIDE_NAME[opponent]}の玉が取られる状態です（手番は${SIDE_NAME[state.sideToMove]}）`,
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** USI の指し手の書式（移動 `7g7f` / 成り `7g7f+` / 打ち `P*5e`） */
const USI_MOVE = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;

/** USI 座標（例 `7g`）→ `[row, col]`。盤の内部表現は `board.ts` と同じ向き */
function usiToIndex(usi: string): [row: number, col: number] {
  return [usi.charCodeAt(1) - 97, 9 - Number(usi[0])];
}

/**
 * 名指し評価（prd/12 §2.2）で渡す手が、エンジンに渡してよいかを見る。
 *
 * 🔒 **合法性は判定しない**（合法手生成器は作らない。prd/12 §2.5）。見るのは書式と、
 * **動かす駒が手番側の物として実在するか**だけ——実在しない駒を動かす手を
 * `position … moves` で適用させると、エンジンが持つ局面が壊れる。
 * 王手放置・二歩・打ち歩詰めといった「指せば負けだが盤は壊れない」手は通す。
 */
export function validateMoveOnPosition(
  state: BoardState,
  usiMove: string,
): PositionValidation {
  if (!USI_MOVE.test(usiMove)) {
    return {
      ok: false,
      violations: [
        { code: 'malformed_move', message: `指し手の書式が不正です: ${usiMove}` },
      ],
    };
  }
  const side = state.sideToMove;
  const violations: PositionViolation[] = [];

  const drop = usiMove.match(/^([PLNSGBR])\*([1-9][a-i])$/);
  if (drop) {
    const [, char, to] = drop;
    const kind = char as PieceKind;
    const [toRow, toCol] = usiToIndex(to);
    if ((state.hand[side][kind] ?? 0) < 1) {
      violations.push({
        code: 'no_such_piece',
        message: `${SIDE_NAME[side]}の持ち駒に${PIECE_NAME[kind]}がありません`,
      });
    }
    if (state.board[toRow][toCol]) {
      violations.push({
        code: 'no_such_piece',
        message: `${to} には駒があるので打てません`,
      });
    }
    return violations.length === 0 ? { ok: true } : { ok: false, violations };
  }

  const [, from, to] = usiMove.match(/^([1-9][a-i])([1-9][a-i])/)!;
  const [fromRow, fromCol] = usiToIndex(from);
  const [toRow, toCol] = usiToIndex(to);
  const moving = state.board[fromRow][fromCol];
  if (!moving || moving.side !== side) {
    violations.push({
      code: 'no_such_piece',
      message: `${from} に${SIDE_NAME[side]}の駒がありません`,
    });
  }
  const captured = state.board[toRow][toCol];
  if (captured && captured.side === side) {
    violations.push({
      code: 'no_such_piece',
      message: `${to} には自分の駒があります`,
    });
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
