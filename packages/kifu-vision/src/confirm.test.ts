import { describe, expect, it } from 'vitest';
import type { Square } from 'shared';
import { ReadingHistory } from './confirm.ts';
import { UNKNOWN, type VisionSquare } from './uncertain.ts';

function board(fill: VisionSquare = null): VisionSquare[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => fill));
}
function pos(usi: string): { row: number; col: number } {
  return { row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) };
}
function withPiece(usi: string, piece: VisionSquare): VisionSquare[][] {
  const b = board();
  const p = pos(usi);
  b[p.row][p.col] = piece;
  return b;
}
const GIN: Square = { kind: 'S', side: 'gote' };
const NARIGIN: Square = { kind: '+S', side: 'gote' };

describe('読みの積み重ねで確定させる', () => {
  it('1 回では確定しない。3 回続けて同じなら確定する', () => {
    const h = new ReadingHistory();
    const p = pos('4d');
    h.observe(withPiece('4d', GIN));
    expect(h.confirmed(p.row, p.col)).toBeNull();
    h.observe(withPiece('4d', GIN));
    expect(h.confirmed(p.row, p.col)).toBeNull();
    h.observe(withPiece('4d', GIN));
    expect(h.confirmed(p.row, p.col)?.value).toEqual(GIN);
  });

  it('読みが変われば連続はやり直しになる', () => {
    const h = new ReadingHistory();
    const p = pos('4d');
    h.observe(withPiece('4d', GIN));
    h.observe(withPiece('4d', GIN));
    h.observe(withPiece('4d', NARIGIN));
    expect(h.confirmed(p.row, p.col)).toBeNull();
  });

  it('⭐ 未確定は連続を切らない（読めなかっただけで、変わったわけではない）', () => {
    const h = new ReadingHistory();
    const p = pos('4d');
    h.observe(withPiece('4d', GIN));
    h.observe(withPiece('4d', UNKNOWN)); // ポインタが乗って読めない
    h.observe(withPiece('4d', GIN));
    h.observe(withPiece('4d', GIN));
    expect(h.confirmed(p.row, p.col)?.value).toEqual(GIN);
  });

  it('空マスも「読み」として積める', () => {
    const h = new ReadingHistory();
    const p = pos('4d');
    for (let i = 0; i < 3; i++) h.observe(board());
    expect(h.confirmed(p.row, p.col)?.value).toBeNull();
  });

  it('⭐⭐ 逆算の取り違えを、追跡中の盤面との食い違いとして挙げる', () => {
    // 実測（6:22 の 4d）の再現。ポインタに覆われた移動先を「成銀」と逆算したが、
    // 実物は成らずの銀で、以後ずっと銀に読めていた。
    const h = new ReadingHistory();
    for (let i = 0; i < 4; i++) h.observe(withPiece('4d', GIN));

    const current: Square[][] = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));
    const p = pos('4d');
    current[p.row][p.col] = NARIGIN; // 逆算の結果（間違い）

    const bad = h.contradictions(current);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ row: p.row, col: p.col, value: GIN });
  });

  it('追跡中の盤面と一致していれば食い違いには挙がらない', () => {
    const h = new ReadingHistory();
    for (let i = 0; i < 4; i++) h.observe(withPiece('4d', GIN));
    const current: Square[][] = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));
    const p = pos('4d');
    current[p.row][p.col] = GIN;
    expect(h.contradictions(current)).toHaveLength(0);
  });

  it('⚠ 手を指したマスは連続を捨てる。残すと「変わる前の駒」で確定してしまう', () => {
    const h = new ReadingHistory();
    const p = pos('4d');
    for (let i = 0; i < 4; i++) h.observe(withPiece('4d', GIN));
    expect(h.confirmed(p.row, p.col)).not.toBeNull();

    h.reset(p.row, p.col); // ここへ手が指された
    expect(h.confirmed(p.row, p.col)).toBeNull();
  });
});
