import { describe, expect, it } from 'vitest';
import { createInitialState, type Square } from 'shared';
import { checkBoard, pieceCount } from './sanity.ts';

function emptyBoard(): Square[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));
}

function put(board: Square[][], usi: string, piece: Square): void {
  board[usi.charCodeAt(1) - 97][9 - Number(usi[0])] = piece;
}

/** 玉だけ置いた、それ以外は問題のない盤面 */
function withKings(): Square[][] {
  const b = emptyBoard();
  put(b, '5i', { kind: 'K', side: 'sente' });
  put(b, '5a', { kind: 'K', side: 'gote' });
  return b;
}

describe('checkBoard', () => {
  it('平手初期配置は成立する', () => {
    const result = checkBoard(createInitialState().board);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('玉が無ければ成立しない', () => {
    const result = checkBoard(emptyBoard());
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain('玉');
  });

  it('同じ側の玉が 2 枚あれば成立しない', () => {
    const b = withKings();
    put(b, '4i', { kind: 'K', side: 'sente' });
    expect(checkBoard(b).ok).toBe(false);
  });

  it('二歩を見つける', () => {
    const b = withKings();
    put(b, '7f', { kind: 'P', side: 'sente' });
    put(b, '7d', { kind: 'P', side: 'sente' });
    const result = checkBoard(b);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain('二歩');
  });

  it('筋が違えば二歩ではない', () => {
    const b = withKings();
    put(b, '7f', { kind: 'P', side: 'sente' });
    put(b, '6f', { kind: 'P', side: 'sente' });
    expect(checkBoard(b).ok).toBe(true);
  });

  it('先後で同じ筋に歩があっても二歩ではない', () => {
    const b = withKings();
    put(b, '7f', { kind: 'P', side: 'sente' });
    put(b, '7d', { kind: 'P', side: 'gote' });
    expect(checkBoard(b).ok).toBe(true);
  });

  it('駒が規定より多ければ成立しない', () => {
    const b = withKings();
    // 飛車を 3 枚置く（規定は 2 枚）
    put(b, '2h', { kind: 'R', side: 'sente' });
    put(b, '3h', { kind: 'R', side: 'sente' });
    put(b, '4h', { kind: 'R', side: 'gote' });
    const result = checkBoard(b);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain('R');
  });

  it('成駒は元の駒として数える', () => {
    const b = withKings();
    put(b, '2h', { kind: 'R', side: 'sente' });
    put(b, '3h', { kind: '+R', side: 'sente' });
    expect(checkBoard(b).ok).toBe(true);
    put(b, '4h', { kind: '+R', side: 'gote' });
    expect(checkBoard(b).ok).toBe(false);
  });

  it('行き所のない駒を見つける', () => {
    const b = withKings();
    put(b, '9a', { kind: 'P', side: 'sente' });
    expect(checkBoard(b).ok).toBe(false);

    const b2 = withKings();
    put(b2, '9b', { kind: 'N', side: 'sente' });
    expect(checkBoard(b2).ok).toBe(false);

    // 成っていれば問題ない
    const b3 = withKings();
    put(b3, '9a', { kind: '+P', side: 'sente' });
    expect(checkBoard(b3).ok).toBe(true);
  });

  it('後手の行き所のない駒は下段側で判定する', () => {
    const b = withKings();
    put(b, '9i', { kind: 'P', side: 'gote' });
    expect(checkBoard(b).ok).toBe(false);
  });
});

describe('pieceCount', () => {
  it('初期配置は 40 枚', () => {
    expect(pieceCount(createInitialState().board)).toBe(40);
  });
});
