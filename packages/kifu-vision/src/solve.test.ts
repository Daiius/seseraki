import { describe, expect, it } from 'vitest';
import type { PieceKind, Square } from 'shared';
import { solveUnknowns } from './solve.ts';

function emptyBoard(): Square[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));
}

function at(usi: string): [number, number] {
  return [usi.charCodeAt(1) - 97, 9 - Number(usi[0])];
}

function put(board: Square[][], usi: string, piece: Square): void {
  const [row, col] = at(usi);
  board[row][col] = piece;
}

/** 初期局面から作れる駒（＝すでにテンプレートがある駒） */
const KNOWN: PieceKind[] = ['P', 'L', 'N', 'S', 'G', 'B', 'R', 'K'];
const UNKNOWN_KINDS: PieceKind[] = ['+P', '+L', '+N', '+S', '+B', '+R'];

describe('solveUnknowns', () => {
  it('成った駒を手の整合性から逆算する', () => {
    const before = emptyBoard();
    put(before, '8h', { kind: 'B', side: 'sente' });
    put(before, '2b', { kind: 'B', side: 'gote' });

    // 2b が読めなかった（実際は成った角＝馬）
    const after = emptyBoard();
    put(after, '2b', { kind: 'P', side: 'sente' }); // 誤認識された中身。使われないはず。

    const solved = solveUnknowns(before, after, [{ ...posOf('2b'), inAfter: true }], UNKNOWN_KINDS);
    expect(solved).not.toBeNull();
    expect(solved!.move.usi).toBe('8h2b+');
    expect(solved!.resolved[0].piece).toEqual({ kind: '+B', side: 'sente' });
  });

  it('候補を絞らないと成りと成らずの区別がつかず曖昧になる', () => {
    const before = emptyBoard();
    put(before, '8h', { kind: 'B', side: 'sente' });
    put(before, '2b', { kind: 'B', side: 'gote' });
    const after = emptyBoard();
    put(after, '2b', { kind: 'P', side: 'sente' });

    // 全駒種を候補にすると「角のまま(8h2b)」と「馬になった(8h2b+)」の両方が成り立つ
    const solved = solveUnknowns(before, after, [{ ...posOf('2b'), inAfter: true }]);
    expect(solved).toBeNull();
  });

  it('と金の移動も逆算できる', () => {
    const before = emptyBoard();
    put(before, '5c', { kind: '+P', side: 'sente' });
    const after = emptyBoard();
    put(after, '5b', { kind: 'G', side: 'sente' }); // 成駒テンプレートが無く金と誤認

    const solved = solveUnknowns(
      before,
      after,
      [{ ...posOf('5b'), inAfter: true }],
      UNKNOWN_KINDS,
    );
    expect(solved).not.toBeNull();
    expect(solved!.move.usi).toBe('5c5b');
    expect(solved!.resolved[0].piece).toEqual({ kind: '+P', side: 'sente' });
  });

  it('1 手で説明が付かなければ null', () => {
    const before = emptyBoard();
    put(before, '7g', { kind: 'P', side: 'sente' });
    put(before, '3c', { kind: 'P', side: 'gote' });
    // 2 手ぶん進んだ状態
    const after = emptyBoard();
    put(after, '7f', { kind: 'P', side: 'sente' });
    put(after, '3d', { kind: 'P', side: 'gote' });

    const solved = solveUnknowns(before, after, [{ ...posOf('3d'), inAfter: true }], UNKNOWN_KINDS);
    expect(solved).toBeNull();
  });

  it('未知マスが多すぎたら諦める', () => {
    const before = emptyBoard();
    const after = emptyBoard();
    const many = [posOf('1a'), posOf('2a'), posOf('3a')].map((p) => ({ ...p, inAfter: true }));
    expect(solveUnknowns(before, after, many, UNKNOWN_KINDS)).toBeNull();
  });

  it('既知の駒だけが候補なら成駒は導けない（KNOWN を渡した場合の確認）', () => {
    const before = emptyBoard();
    put(before, '5c', { kind: '+P', side: 'sente' });
    const after = emptyBoard();
    put(after, '5b', { kind: 'G', side: 'sente' });

    // 候補に成駒が無いので +P には辿り着けない。ただし「金が動いた」形では
    // before の 5c が +P のままなので 1 手にならず、解なしになる。
    const solved = solveUnknowns(before, after, [{ ...posOf('5b'), inAfter: true }], KNOWN);
    expect(solved).toBeNull();
  });
});

function posOf(usi: string): { row: number; col: number } {
  const [row, col] = at(usi);
  return { row, col };
}
