/**
 * 局面の特徴量（`Feat`）— 戦型判定の第 0 層。
 *
 * **常に先手基準へ正規化する。** 後手の判定は盤面を反転してから同じ述語に掛けるので、
 * 内部ラベルの定義は先手の座標だけで書ける（prd/01 §6.1）。
 */
import type { BoardState, Square, Side } from '../board';

/** 窓を閉じる判定に使う駒種（成りは元の駒種に畳む。持ち駒に増えた種類を見る） */
export type CaptureKind = 'P' | 'L' | 'N' | 'S' | 'G' | 'B' | 'R';
export const ALL_KINDS: CaptureKind[] = ['P', 'L', 'N', 'S', 'G', 'B', 'R'];

export function flipBoard(board: Square[][]): Square[][] {
  const out: Square[][] = [];
  for (let r = 0; r < 9; r++) {
    const row: Square[] = [];
    for (let c = 0; c < 9; c++) {
      const sq = board[8 - r][8 - c];
      row.push(sq ? { kind: sq.kind, side: sq.side === 'sente' ? 'gote' : 'sente' } : null);
    }
    out.push(row);
  }
  return out;
}

export type Feat = {
  turn: number;
  rookFile: number | null;
  rookRank: number | null;
  /** 敵陣（1〜3段）で成った自分の角の位置。"33" など */
  bishopPromotedSquare: string | null;
  /** 盤上の自分の角（成っていない）の位置 */
  bishopSquare: string | null;
  /** 盤上の自分の銀の位置（"77" など） */
  silverSquares: string[];
  /** 盤上の自分の金の位置（"78" など） */
  goldSquares: string[];
  /** 盤上の自分の桂の位置（"77" など）。鬼殺し系の骨格 */
  knightSquares: string[];
  bishopInHand: boolean;
  /** 8八の角が動かず7七の歩が退いている */
  bishopDiagonalOpen: boolean;
  /** 自分の歩の段。index 0 = 1筋。盤上に無ければ null（＝交換済み） */
  pawn: (number | null)[];
  // ---- 相手側（先手基準に正規化。相手の飛車の初期位置も 2八 になる）----
  oppRookFile: number | null;
  oppRookRank: number | null;
  oppBishopInHand: boolean;
  oppBishopSquare: string | null;
  oppPawn: (number | null)[];
};

function pawnRanks(board: Square[][]): (number | null)[] {
  const out: (number | null)[] = [];
  for (let file = 1; file <= 9; file++) {
    const c = 9 - file;
    let found: number | null = null;
    for (let r = 0; r < 9; r++) {
      const sq = board[r][c];
      if (sq && sq.side === 'sente' && sq.kind === 'P') {
        found = r + 1;
        break;
      }
    }
    out.push(found);
  }
  return out;
}

const at = (b: Square[][], file: number, rank: number): Square => b[rank - 1][9 - file];

export function features(state: BoardState, flipped: boolean, turn: number): Feat {
  const board = flipped ? flipBoard(state.board) : state.board;
  const oppBoard = flipped ? state.board : flipBoard(state.board);
  const hand = flipped ? state.hand.gote : state.hand.sente;
  const oppHand = flipped ? state.hand.sente : state.hand.gote;

  let rookFile: number | null = null;
  let rookRank: number | null = null;
  let bishopPromotedSquare: string | null = null;
  let bishopSquare: string | null = null;
  const silverSquares: string[] = [];
  const goldSquares: string[] = [];
  const knightSquares: string[] = [];

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const sq = board[r][c];
      if (!sq || sq.side !== 'sente') continue;
      const file = 9 - c;
      const rank = r + 1;
      if (sq.kind === 'R' || sq.kind === '+R') {
        rookFile = file;
        rookRank = rank;
      }
      if (sq.kind === '+B' && rank <= 3) bishopPromotedSquare = `${file}${rank}`;
      if (sq.kind === 'B') bishopSquare = `${file}${rank}`;
      if (sq.kind === 'S') silverSquares.push(`${file}${rank}`);
      if (sq.kind === 'G') goldSquares.push(`${file}${rank}`);
      if (sq.kind === 'N') knightSquares.push(`${file}${rank}`);
    }
  }

  let oppRookFile: number | null = null;
  let oppRookRank: number | null = null;
  let oppBishopSquare: string | null = null;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const sq = oppBoard[r][c];
      if (!sq || sq.side !== 'sente') continue;
      if (sq.kind === 'R' || sq.kind === '+R') {
        oppRookFile = 9 - c;
        oppRookRank = r + 1;
      }
      if (sq.kind === 'B') oppBishopSquare = `${9 - c}${r + 1}`;
    }
  }

  const b88 = at(board, 8, 8);
  const p77 = at(board, 7, 7);

  return {
    turn,
    rookFile,
    rookRank,
    bishopPromotedSquare,
    bishopSquare,
    silverSquares,
    goldSquares,
    knightSquares,
    bishopInHand: !!hand.B,
    bishopDiagonalOpen:
      !!b88 && b88.side === 'sente' && b88.kind === 'B' && !(p77 && p77.side === 'sente' && p77.kind === 'P'),
    pawn: pawnRanks(board),
    oppRookFile,
    oppRookRank,
    oppBishopInHand: !!oppHand.B,
    oppBishopSquare,
    oppPawn: pawnRanks(oppBoard),
  };
}
