/**
 * 将棋盤面追跡
 *
 * USI の手を順に適用して各マスの駒を追跡する。
 * USI 座標: 列は 1-9（右から左）、行は a-i（上から下）
 * 内部配列: board[row][col] で row=0 が一段目（上）、col=0 が9筋（右端）
 */

// 駒の種類
export type PieceKind =
  | 'P' | 'L' | 'N' | 'S' | 'G' | 'B' | 'R' | 'K'   // 生駒
  | '+P' | '+L' | '+N' | '+S' | '+B' | '+R';           // 成駒

export type Side = 'sente' | 'gote';

export interface Piece {
  kind: PieceKind;
  side: Side;
}

export type Square = Piece | null;

const PIECE_NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

// USI 駒文字 → PieceKind（駒打ち用）
const USI_DROP_PIECE: Record<string, PieceKind> = {
  P: 'P', L: 'L', N: 'N', S: 'S', G: 'G', B: 'B', R: 'R',
};

// 成り: 生駒 → 成駒
const PROMOTE_MAP: Partial<Record<PieceKind, PieceKind>> = {
  P: '+P', L: '+L', N: '+N', S: '+S', B: '+B', R: '+R',
};

// 成駒 → 生駒（持ち駒にするとき）
const UNPROMOTE_MAP: Partial<Record<PieceKind, PieceKind>> = {
  '+P': 'P', '+L': 'L', '+N': 'N', '+S': 'S', '+B': 'B', '+R': 'R',
};

/**
 * USI 座標 (例: "7g") → [row, col] (0-indexed)
 * USI: 列 1-9 は右から左、行 a-i は上から下
 * 内部: col 0=9筋, col 8=1筋 / row 0=一段, row 8=九段
 */
function usiToIndex(usi: string): [number, number] {
  const col = 9 - Number(usi[0]); // "7" → col 2
  const row = usi.charCodeAt(1) - 97; // "g" → row 6
  return [row, col];
}

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
 * 盤面をディープコピー
 */
export function cloneState(state: BoardState): BoardState {
  return {
    board: state.board.map((row) => row.map((sq) => (sq ? { ...sq } : null))),
    hand: {
      sente: { ...state.hand.sente },
      gote: { ...state.hand.gote },
    },
    sideToMove: state.sideToMove,
  };
}

/**
 * USI の手を適用して新しい盤面を返す（元の盤面は変更しない）
 */
export function applyMove(state: BoardState, usiMove: string): BoardState {
  const next = cloneState(state);
  const side = next.sideToMove;

  // 駒打ち: "B*5c"
  const dropMatch = usiMove.match(/^([PLNSGBR])\*(\d[a-i])$/);
  if (dropMatch) {
    const [, piece, to] = dropMatch;
    const [toR, toC] = usiToIndex(to);
    const kind = USI_DROP_PIECE[piece];
    next.board[toR][toC] = { kind, side };
    const h = next.hand[side];
    h[kind] = (h[kind] ?? 0) - 1;
    if (h[kind]! <= 0) delete h[kind];
    next.sideToMove = side === 'sente' ? 'gote' : 'sente';
    return next;
  }

  // 通常の移動: "7g7f" or "7g7f+"
  const moveMatch = usiMove.match(/^(\d[a-i])(\d[a-i])(\+?)$/);
  if (moveMatch) {
    const [, from, to, promote] = moveMatch;
    const [fromR, fromC] = usiToIndex(from);
    const [toR, toC] = usiToIndex(to);

    const piece = next.board[fromR][fromC];
    if (!piece) {
      // 不正な手だが壊さないようにスキップ
      next.sideToMove = side === 'sente' ? 'gote' : 'sente';
      return next;
    }

    // 取った駒を持ち駒に
    const captured = next.board[toR][toC];
    if (captured) {
      let capturedKind = captured.kind;
      if (UNPROMOTE_MAP[capturedKind]) {
        capturedKind = UNPROMOTE_MAP[capturedKind]!;
      }
      const h = next.hand[side];
      h[capturedKind] = (h[capturedKind] ?? 0) + 1;
    }

    // 移動
    let kind = piece.kind;
    if (promote && PROMOTE_MAP[kind]) {
      kind = PROMOTE_MAP[kind]!;
    }
    next.board[toR][toC] = { kind, side };
    next.board[fromR][fromC] = null;
    next.sideToMove = side === 'sente' ? 'gote' : 'sente';
    return next;
  }

  // パース不能な手はスキップ
  next.sideToMove = side === 'sente' ? 'gote' : 'sente';
  return next;
}

/**
 * USI の手列から各局面の盤面状態を生成
 * 返り値: [初期局面, 1手目後, 2手目後, ...]
 */
export function buildPositions(usiMoves: string[]): BoardState[] {
  const positions: BoardState[] = [];
  let state = createInitialState();
  positions.push(cloneState(state));
  for (const move of usiMoves) {
    state = applyMove(state, move);
    positions.push(cloneState(state));
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
