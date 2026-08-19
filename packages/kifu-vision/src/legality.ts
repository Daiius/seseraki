/**
 * 駒の動きの妥当性
 *
 * 合法手生成器（movegen）ではない。「この駒がこのマスからこのマスへ動けるか」
 * だけを見る。王手放置や打ち歩詰めは判定しない。
 *
 * 差分から導いた手は `applyMove` で検算できるが、あれは「その手を指せば
 * その配置になるか」を見るだけで、**駒の動きとして有り得るかは見ていない**。
 * 実際、認識がずれると「銀が 7d から 8h へ飛ぶ」ような手が検算を通ってしまった。
 * ここで弾く。
 *
 * 盤の添字は shared と同じで、row 0 が一段目（画面の上）、col 0 が 9 筋（画面の左）。
 * 先手は上に進む（row が減る）、後手は下に進む（row が増える）。
 */

import type { PieceKind, Side, Square } from 'shared';

/** [行の増分, 列の増分] を先手視点で並べる。後手は行の符号を反転する。 */
const STEP_MOVES: Partial<Record<PieceKind, [number, number][]>> = {
  P: [[-1, 0]],
  N: [[-2, -1], [-2, 1]],
  S: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]],
  G: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]],
  K: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
};
// 成った小駒は金と同じ動き
for (const k of ['+P', '+L', '+N', '+S'] as PieceKind[]) STEP_MOVES[k] = STEP_MOVES.G;

/** 何マスでも滑る方向 */
const SLIDE_MOVES: Partial<Record<PieceKind, [number, number][]>> = {
  L: [[-1, 0]],
  B: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  R: [[-1, 0], [1, 0], [0, -1], [0, 1]],
  '+B': [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  '+R': [[-1, 0], [1, 0], [0, -1], [0, 1]],
};

/** 成った大駒だけが持つ、1 マスだけの追加の動き */
const EXTRA_STEPS: Partial<Record<PieceKind, [number, number][]>> = {
  '+B': [[-1, 0], [1, 0], [0, -1], [0, 1]],
  '+R': [[-1, -1], [-1, 1], [1, -1], [1, 1]],
};

const inBoard = (r: number, c: number) => r >= 0 && r < 9 && c >= 0 && c < 9;

/**
 * from から to へ、その駒が動けるか。
 *
 * 滑る駒（香・角・飛・馬・龍）は途中に駒があると通れない。
 */
export function canMove(
  board: Square[][],
  from: { row: number; col: number },
  to: { row: number; col: number },
  kind: PieceKind,
  side: Side,
): boolean {
  if (!inBoard(to.row, to.col) || !inBoard(from.row, from.col)) return false;
  if (from.row === to.row && from.col === to.col) return false;

  // 先手は上へ進む。後手は行の増分を反転する。
  const dir = side === 'sente' ? 1 : -1;
  const dr = to.row - from.row;
  const dc = to.col - from.col;

  for (const [sr, sc] of [...(STEP_MOVES[kind] ?? []), ...(EXTRA_STEPS[kind] ?? [])]) {
    if (dr === sr * dir && dc === sc) return true;
  }

  for (const [sr, sc] of SLIDE_MOVES[kind] ?? []) {
    const stepR = sr * dir;
    const stepC = sc;
    let r = from.row + stepR;
    let c = from.col + stepC;
    while (inBoard(r, c)) {
      if (r === to.row && c === to.col) return true;
      // 途中に駒があればそこで止まる
      if (board[r][c]) break;
      r += stepR;
      c += stepC;
    }
  }

  return false;
}

/** 成れるか（移動元か移動先が敵陣三段以内） */
export function canPromote(
  from: { row: number; col: number },
  to: { row: number; col: number },
  side: Side,
): boolean {
  const inEnemyZone = (row: number) => (side === 'sente' ? row <= 2 : row >= 6);
  return inEnemyZone(from.row) || inEnemyZone(to.row);
}

/** 成らないと二度と動けなくなる形か（行き所のない駒） */
export function mustPromote(kind: PieceKind, to: { row: number }, side: Side): boolean {
  const rowFromEnemyEdge = side === 'sente' ? to.row : 8 - to.row;
  if (kind === 'P' || kind === 'L') return rowFromEnemyEdge === 0;
  if (kind === 'N') return rowFromEnemyEdge <= 1;
  return false;
}

/** 打てるマスか（歩・香は最奥、桂は奥 2 段には打てない） */
export function canDrop(kind: PieceKind, to: { row: number }, side: Side): boolean {
  return !mustPromote(kind, to, side);
}
