/**
 * 読めなかったマスの駒種を、手の整合性から逆算する
 *
 * 成駒（と金・成香・成桂・成銀・馬・龍）は平手初期局面に無いので、初期局面から
 * 作ったテンプレートには含まれない。そのマスは NCC が落ちて誤認識される。
 *
 * ただしここは画像を睨み直さなくても解ける。**1 手で変わるマスは高々 2 つ**なので、
 * 読めなかったマスに駒種を総当たりで割り当て、「ちょうど 1 手で説明が付く」割り当てを
 * 探せばよい。解が 1 つに定まればその駒種が正解で、そのマスの画像はそのまま
 * 新しいテンプレートとして使える（画像認識ではなく論理で確定したラベルなので信頼できる）。
 *
 * これで成駒はすべて自己ブートストラップで揃う。
 */

import type { PieceKind, Side, Square } from 'shared';
import { inferMove, verifyMove, type InferredMove } from './moves.ts';

const ALL_KINDS: PieceKind[] = [
  'P', 'L', 'N', 'S', 'G', 'B', 'R', 'K',
  '+P', '+L', '+N', '+S', '+B', '+R',
];
const SIDES: Side[] = ['sente', 'gote'];

export interface UnknownCell {
  row: number;
  col: number;
  /** true なら「変化後」の盤面のマス、false なら「変化前」 */
  inAfter: boolean;
}

export interface ResolvedCell {
  row: number;
  col: number;
  inAfter: boolean;
  piece: { kind: PieceKind; side: Side };
}

export interface SolveResult {
  move: InferredMove;
  resolved: ResolvedCell[];
}

function cloneBoard(board: Square[][]): Square[][] {
  return board.map((r) => r.slice());
}

/**
 * 読めなかったマスに駒種を割り当てて、1 手で説明が付く組み合わせを探す。
 *
 * 解が 1 つに定まらなければ null を返す（曖昧なまま覚えると誤りが伝播するため）。
 * 総当たりの数は 候補数^(未知マス数) だが、未知マスは普通 1〜2 個なので十分速い。
 *
 * ⚠ **候補を絞らないとほぼ必ず曖昧になる。** 例えば角が敵陣に入る手は、
 * 移動先を「角」と置けば成らず、「馬」と置けば成りとして、どちらも 1 手で
 * 説明が付いてしまう。盤面の論理だけでは成ったかどうかを決められない。
 *
 * 実際には「読めなかった＝テンプレートに無い駒＝まだ覚えていない駒種」という
 * 事前情報があるので、`candidateKinds` に未登録の駒種だけを渡せば一意に定まる。
 */
export function solveUnknowns(
  before: Square[][],
  after: Square[][],
  unknowns: UnknownCell[],
  candidateKinds?: PieceKind[],
  maxUnknowns = 2,
): SolveResult | null {
  if (unknowns.length === 0 || unknowns.length > maxUnknowns) return null;

  const kinds = candidateKinds && candidateKinds.length > 0 ? candidateKinds : ALL_KINDS;
  const candidates: { kind: PieceKind; side: Side }[] = [];
  for (const side of SIDES) {
    for (const kind of kinds) candidates.push({ kind, side });
  }

  const solutions: SolveResult[] = [];

  const assign = (i: number, b: Square[][], a: Square[][]) => {
    if (solutions.length > 1) return; // 曖昧と分かった時点で打ち切る
    if (i === unknowns.length) {
      const result = inferMove(b, a);
      if (!result.move) return;
      if (!verifyMove(b, result.move.usi, result.move.side, a)) return;
      solutions.push({
        move: result.move,
        resolved: unknowns.map((u, k) => ({
          row: u.row,
          col: u.col,
          inAfter: u.inAfter,
          piece: (u.inAfter ? a : b)[u.row][u.col] as { kind: PieceKind; side: Side },
        })),
      });
      return;
    }
    const u = unknowns[i];
    for (const cand of candidates) {
      const target = u.inAfter ? a : b;
      const saved = target[u.row][u.col];
      target[u.row][u.col] = cand;
      assign(i + 1, b, a);
      target[u.row][u.col] = saved;
      if (solutions.length > 1) return;
    }
  };

  assign(0, cloneBoard(before), cloneBoard(after));

  return solutions.length === 1 ? solutions[0] : null;
}

/** 駒が成駒かどうか */
export function isPromoted(kind: PieceKind): boolean {
  return kind.startsWith('+');
}
