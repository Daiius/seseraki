import { describe, expect, it } from 'vitest';
import type { Square } from 'shared';
import { rescueVanished } from './vanished.ts';
import { UNKNOWN, type VisionSquare } from './uncertain.ts';

function empty<T>(fill: T): T[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => fill));
}
function pos(usi: string): { row: number; col: number } {
  return { row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) };
}
function put<T>(b: T[][], usi: string, v: T): void {
  const p = pos(usi);
  b[p.row][p.col] = v;
}

/** 玉が 1 枚ずつ無いと checkBoard を通らない */
function kings(b: Square[][]): void {
  put(b, '5i', { kind: 'K', side: 'sente' });
  put(b, '5a', { kind: 'K', side: 'gote' });
}

describe('消えた駒の行き先を未確定のマスに探す', () => {
  it('⭐ 移動先が読めていないだけなら、そこへ動いたとみなす', () => {
    // 実測（14:06 の 7g）の再現。後手の香が 7g へ動いたが、7g のテンプレートが
    // 無くて未確定 → 引き継ぎで前の駒（▲角）のまま → 香が消えただけに見える。
    const before = empty<Square>(null);
    kings(before);
    put(before, '7f', { kind: 'L', side: 'gote' });
    put(before, '7g', { kind: 'B', side: 'sente' });

    const after = before.map((r) => r.slice());
    put(after, '7f', null); // 香が消えた（7g は引き継ぎで ▲角 のまま）

    const read = empty<VisionSquare>(null);
    kings(read as Square[][]);
    put(read, '7g', UNKNOWN); // 7g は読めていない
    put(read, '7f', null);

    const r = rescueVanished(before, after, read);
    expect(r).not.toBeNull();
    expect(r!.usi).toBe('7f7g');
    expect(r!.side).toBe('gote');
    expect(r!.board[pos('7g').row][pos('7g').col]).toEqual({ kind: 'L', side: 'gote' });
    // 敵陣なので成れる。絵が読めないので成ったかは決めきれない。
    expect(r!.promotionUncertain).toBe(true);
  });

  it('⚠ 移動先が読めているなら、この経路には来ない（本当にスライド途中）', () => {
    const before = empty<Square>(null);
    kings(before);
    put(before, '7f', { kind: 'L', side: 'gote' });
    put(before, '7g', { kind: 'B', side: 'sente' });

    const after = before.map((r) => r.slice());
    put(after, '7f', null);

    const read = empty<VisionSquare>(null);
    kings(read as Square[][]);
    put(read, '7g', { kind: 'B', side: 'sente' }); // ちゃんと読めている
    put(read, '7f', null);

    expect(rescueVanished(before, after, read)).toBeNull();
  });

  it('⚠ 行き先の候補が 2 つあれば決めない', () => {
    const before = empty<Square>(null);
    kings(before);
    put(before, '5e', { kind: 'R', side: 'sente' }); // 飛は縦横に伸びる
    const after = before.map((r) => r.slice());
    put(after, '5e', null);

    const read = empty<VisionSquare>(null);
    kings(read as Square[][]);
    put(read, '5d', UNKNOWN);
    put(read, '5f', UNKNOWN);
    put(read, '5e', null);

    expect(rescueVanished(before, after, read)).toBeNull();
  });

  it('その駒が動けないマスは候補にしない', () => {
    const before = empty<Square>(null);
    kings(before);
    put(before, '7g', { kind: 'P', side: 'sente' }); // 歩は前に 1 マスだけ
    const after = before.map((r) => r.slice());
    put(after, '7g', null);

    const read = empty<VisionSquare>(null);
    kings(read as Square[][]);
    put(read, '7d', UNKNOWN); // 3 マス先。歩は届かない
    put(read, '7g', null);

    expect(rescueVanished(before, after, read)).toBeNull();
  });

  it('成らないと動けなくなる形なら、成りとして確定する', () => {
    const before = empty<Square>(null);
    kings(before);
    put(before, '3b', { kind: 'P', side: 'sente' });
    const after = before.map((r) => r.slice());
    put(after, '3b', null);

    const read = empty<VisionSquare>(null);
    kings(read as Square[][]);
    put(read, '3a', UNKNOWN);
    put(read, '3b', null);

    const r = rescueVanished(before, after, read);
    expect(r).not.toBeNull();
    expect(r!.usi).toBe('3b3a+');
    expect(r!.promotionUncertain).toBe(false);
  });

  it('消える以外の変化があるなら、この経路ではない', () => {
    const before = empty<Square>(null);
    kings(before);
    put(before, '7f', { kind: 'L', side: 'gote' });
    put(before, '2c', { kind: 'P', side: 'sente' });
    const after = before.map((r) => r.slice());
    put(after, '7f', null);
    put(after, '2c', null); // 2 マス消えた

    const read = empty<VisionSquare>(null);
    kings(read as Square[][]);
    put(read, '7g', UNKNOWN);

    expect(rescueVanished(before, after, read)).toBeNull();
  });
});
