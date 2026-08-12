import { describe, expect, it } from 'vitest';
import type { Square } from 'shared';
import { UNKNOWN, unknownCells, markUnknown, resolveWith, fillGuesses, settle, type VisionSquare } from './uncertain.ts';
import { inferMove } from './moves.ts';
import { checkBoard } from './sanity.ts';

function emptyBoard<T = Square>(fill: T): T[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => fill));
}

function pos(usi: string): { row: number; col: number } {
  return { row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) };
}

function put<T>(board: T[][], usi: string, value: T): void {
  const p = pos(usi);
  board[p.row][p.col] = value;
}

function get<T>(board: T[][], usi: string): T {
  const p = pos(usi);
  return board[p.row][p.col];
}

describe('未確定を持てる盤面', () => {
  it('未確定のマスを列挙する', () => {
    const board = emptyBoard<VisionSquare>(null);
    put(board, '5e', UNKNOWN);
    put(board, '3c', UNKNOWN);
    expect(unknownCells(board)).toEqual([pos('3c'), pos('5e')].sort((a, b) => a.row - b.row || a.col - b.col));
  });

  it('markUnknown は元の盤面を書き換えない', () => {
    const board = emptyBoard<VisionSquare>(null);
    put(board, '5e', { kind: 'S', side: 'sente' });
    const marked = markUnknown(board, [pos('5e')]);
    expect(get(marked, '5e')).toBe(UNKNOWN);
    expect(get(board, '5e')).toEqual({ kind: 'S', side: 'sente' });
  });

  it('未確定は直前の配置で埋まる', () => {
    const previous = emptyBoard<Square>(null);
    put(previous, '5e', { kind: 'S', side: 'sente' });
    const read = emptyBoard<VisionSquare>(null);
    put(read, '5e', UNKNOWN);

    expect(get(resolveWith(read, previous), '5e')).toEqual({ kind: 'S', side: 'sente' });
  });

  it('未確定が残っていれば settle は null を返す', () => {
    const board = emptyBoard<VisionSquare>(null);
    expect(settle(board)).not.toBeNull();
    put(board, '5e', UNKNOWN);
    expect(settle(board)).toBeNull();
  });

  it('fillGuesses は未確定だけを第一候補で埋める', () => {
    const read = emptyBoard<VisionSquare>(null);
    put(read, '5e', UNKNOWN);
    put(read, '7g', { kind: 'P', side: 'sente' });
    const guesses = emptyBoard<Square>(null);
    put(guesses, '5e', { kind: 'N', side: 'gote' });
    put(guesses, '7g', { kind: 'L', side: 'gote' }); // 読めているマスは上書きしない

    const filled = fillGuesses(read, guesses);
    expect(get(filled, '5e')).toEqual({ kind: 'N', side: 'gote' });
    expect(get(filled, '7g')).toEqual({ kind: 'P', side: 'sente' });
  });
});

describe('当てずっぽうの駒を置かないことで救われる場面', () => {
  it('⭐ 一致度の低い当てずっぽうを置くと盤面ごと捨てられるが、未確定なら助かる', () => {
    // 実測（6:40 の 4e）: マウスポインタしか無い空マスで ▽と が NCC 0.208 の
    // 1 位を取った。盤上の「と」は歩と合わせて 18 枚が上限……ではなく、
    // ここでは分かりやすく玉で見る。玉は各陣営 1 枚しかない。
    const before = emptyBoard<Square>(null);
    put(before, '5i', { kind: 'K', side: 'sente' });
    put(before, '5a', { kind: 'K', side: 'gote' });
    put(before, '7g', { kind: 'P', side: 'sente' });

    // 7g の歩が 7f へ動いた。同時に 4e にポインタが重なった。
    const read = emptyBoard<VisionSquare>(null);
    put(read, '5i', { kind: 'K', side: 'sente' });
    put(read, '5a', { kind: 'K', side: 'gote' });
    put(read, '7f', { kind: 'P', side: 'sente' });
    put(read, '4e', UNKNOWN);

    // 当てずっぽうで埋めると玉が 2 枚になり、盤面ごと捨てられる
    const guesses = emptyBoard<Square>(null);
    put(guesses, '4e', { kind: 'K', side: 'sente' });
    expect(checkBoard(fillGuesses(read, guesses)).ok).toBe(false);

    // 未確定のまま引き継げば、4e は空のままで 1 手が読める
    const carried = resolveWith(read, before);
    expect(checkBoard(carried).ok).toBe(true);
    expect(inferMove(before, carried).move?.usi).toBe('7g7f');
  });

  it('覆われている間も駒はそこにあり続けるので、引き継ぎが正しい', () => {
    const before = emptyBoard<Square>(null);
    put(before, '8h', { kind: 'B', side: 'sente' });
    put(before, '7g', { kind: 'P', side: 'sente' });

    // 8h の角がポインタに覆われて読めない。動いたのは 7g の歩。
    const read = emptyBoard<VisionSquare>(null);
    put(read, '8h', UNKNOWN);
    put(read, '7f', { kind: 'P', side: 'sente' });

    const carried = resolveWith(read, before);
    expect(get(carried, '8h')).toEqual({ kind: 'B', side: 'sente' });
    expect(inferMove(before, carried).move?.usi).toBe('7g7f');
  });
});
