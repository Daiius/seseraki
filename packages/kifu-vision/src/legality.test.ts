import { describe, expect, it } from 'vitest';
import type { Square } from 'shared';
import { canMove, canPromote, canDrop, mustPromote } from './legality.ts';

function emptyBoard(): Square[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));
}

/** USI 座標 ("7g") → {row, col} */
function sq(usi: string): { row: number; col: number } {
  return { row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) };
}

function put(board: Square[][], usi: string, piece: Square): void {
  const p = sq(usi);
  board[p.row][p.col] = piece;
}

describe('canMove', () => {
  const board = emptyBoard();

  it('先手の歩は一つ上へ進める', () => {
    expect(canMove(board, sq('7g'), sq('7f'), 'P', 'sente')).toBe(true);
    expect(canMove(board, sq('7g'), sq('7h'), 'P', 'sente')).toBe(false);
    expect(canMove(board, sq('7g'), sq('6f'), 'P', 'sente')).toBe(false);
  });

  it('後手の歩は先手と逆向きに進む', () => {
    expect(canMove(board, sq('3c'), sq('3d'), 'P', 'gote')).toBe(true);
    expect(canMove(board, sq('3c'), sq('3b'), 'P', 'gote')).toBe(false);
  });

  it('銀は届かないマスへは動けない（実際に誤検出された形）', () => {
    // 認識がずれたとき「銀が 7d から 8h へ飛ぶ」手が applyMove の検算を通ってしまった
    expect(canMove(board, sq('7d'), sq('8h'), 'S', 'sente')).toBe(false);
  });

  it('銀は斜め後ろへは動けるが真後ろへは動けない', () => {
    expect(canMove(board, sq('5e'), sq('4f'), 'S', 'sente')).toBe(true);
    expect(canMove(board, sq('5e'), sq('5f'), 'S', 'sente')).toBe(false);
  });

  it('金は斜め後ろへ動けない', () => {
    expect(canMove(board, sq('5e'), sq('5f'), 'G', 'sente')).toBe(true);
    expect(canMove(board, sq('5e'), sq('4f'), 'G', 'sente')).toBe(false);
  });

  it('桂は駒を飛び越える', () => {
    const b = emptyBoard();
    put(b, '7f', { kind: 'P', side: 'sente' });
    expect(canMove(b, sq('7g'), sq('8e'), 'N', 'sente')).toBe(true);
    expect(canMove(b, sq('7g'), sq('6e'), 'N', 'sente')).toBe(true);
    expect(canMove(b, sq('7g'), sq('7e'), 'N', 'sente')).toBe(false);
  });

  it('香は途中に駒があると通れない', () => {
    const b = emptyBoard();
    expect(canMove(b, sq('1i'), sq('1c'), 'L', 'sente')).toBe(true);
    put(b, '1f', { kind: 'P', side: 'gote' });
    // 1f までは行ける（取れる）が、その先へは進めない
    expect(canMove(b, sq('1i'), sq('1f'), 'L', 'sente')).toBe(true);
    expect(canMove(b, sq('1i'), sq('1c'), 'L', 'sente')).toBe(false);
  });

  it('角は斜めに滑り、途中の駒で止まる', () => {
    const b = emptyBoard();
    expect(canMove(b, sq('8h'), sq('2b'), 'B', 'sente')).toBe(true);
    put(b, '5e', { kind: 'P', side: 'sente' });
    expect(canMove(b, sq('8h'), sq('2b'), 'B', 'sente')).toBe(false);
  });

  it('馬は角の動きに加えて縦横一マス動ける', () => {
    expect(canMove(board, sq('5e'), sq('5d'), '+B', 'sente')).toBe(true);
    expect(canMove(board, sq('5e'), sq('1a'), '+B', 'sente')).toBe(true);
    expect(canMove(board, sq('5e'), sq('5c'), '+B', 'sente')).toBe(false);
  });

  it('龍は飛の動きに加えて斜め一マス動ける', () => {
    expect(canMove(board, sq('5e'), sq('4d'), '+R', 'sente')).toBe(true);
    expect(canMove(board, sq('5e'), sq('5a'), '+R', 'sente')).toBe(true);
    expect(canMove(board, sq('5e'), sq('3c'), '+R', 'sente')).toBe(false);
  });

  it('と金は金と同じ動き', () => {
    expect(canMove(board, sq('5e'), sq('5d'), '+P', 'sente')).toBe(true);
    expect(canMove(board, sq('5e'), sq('4f'), '+P', 'sente')).toBe(false);
  });

  it('同じマスへは動けない', () => {
    expect(canMove(board, sq('5e'), sq('5e'), 'R', 'sente')).toBe(false);
  });
});

describe('canPromote / mustPromote / canDrop', () => {
  it('敵陣に入るか出るときに成れる', () => {
    expect(canPromote(sq('2d'), sq('2c'), 'sente')).toBe(true);
    expect(canPromote(sq('2c'), sq('2d'), 'sente')).toBe(true);
    expect(canPromote(sq('2e'), sq('2d'), 'sente')).toBe(false);
  });

  it('後手の敵陣は下三段', () => {
    expect(canPromote(sq('8f'), sq('8g'), 'gote')).toBe(true);
    expect(canPromote(sq('8e'), sq('8f'), 'gote')).toBe(false);
  });

  it('行き所のない駒は成らなければならない', () => {
    expect(mustPromote('P', sq('5a'), 'sente')).toBe(true);
    expect(mustPromote('P', sq('5b'), 'sente')).toBe(false);
    expect(mustPromote('N', sq('5b'), 'sente')).toBe(true);
    expect(mustPromote('N', sq('5c'), 'sente')).toBe(false);
    expect(mustPromote('S', sq('5a'), 'sente')).toBe(false);
  });

  it('歩と桂は打てないマスがある', () => {
    expect(canDrop('P', sq('5a'), 'sente')).toBe(false);
    expect(canDrop('N', sq('5b'), 'sente')).toBe(false);
    expect(canDrop('G', sq('5a'), 'sente')).toBe(true);
  });
});
