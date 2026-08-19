import { describe, expect, it } from 'vitest';
import { createInitialState, type Side } from 'shared';
import { flipSide, isFlipped, orient, rotateSquare, rotateUsi } from './orientation.ts';
import { generateMoves } from './movegen.ts';
import { replayGame } from './replay.ts';

describe('rotateSquare', () => {
  it('盤の中心について点対称に移る', () => {
    expect(rotateSquare('7g')).toBe('3c');
    expect(rotateSquare('3c')).toBe('7g');
    expect(rotateSquare('5e')).toBe('5e'); // 中心は動かない
    expect(rotateSquare('1a')).toBe('9i');
    expect(rotateSquare('9i')).toBe('1a');
  });
});

describe('rotateUsi', () => {
  it('移動する手を回す', () => {
    expect(rotateUsi('7g7f')).toBe('3c3d');
    expect(rotateUsi('8h2b+')).toBe('2b8h+');
  });

  it('打つ手は駒種を保ったまま回す', () => {
    expect(rotateUsi('P*4b')).toBe('P*6h');
  });

  it('2 回回すと元に戻る', () => {
    for (const usi of ['7g7f', '8h2b+', 'P*4b', '1a9i']) {
      expect(rotateUsi(rotateUsi(usi))).toBe(usi);
    }
  });
});

describe('orient', () => {
  it('画面の下が先手なら何も変えない', () => {
    expect(orient({ usi: '7g7f', side: 'sente' as const }, false)).toEqual({ usi: '7g7f', side: 'sente' });
  });

  it('画面の下が後手なら、回して先後を入れ替える', () => {
    expect(orient({ usi: '3c3d', side: 'gote' as const }, true)).toEqual({ usi: '7g7f', side: 'sente' });
  });

  it('付随する情報は保つ', () => {
    expect(orient({ usi: '3c3d', side: 'gote' as const, time: 4.6 }, true)).toMatchObject({ time: 4.6 });
  });
});

describe('isFlipped', () => {
  it('1 手目を指した側が画面の上（＝後手として読めた）なら反転している', () => {
    expect(isFlipped('gote')).toBe(true);
    expect(isFlipped('sente')).toBe(false);
  });
});

describe('反転した棋譜の性質', () => {
  it('🔴 反転していても棋譜は合法なまま（合法性では検出できない）', () => {
    // 「画面の下＝先手」として読んだ 1 局目の冒頭。後手から始まっているが、
    // これは反転しているだけで、手の集合としては正しい。
    const asRead = ['3c3d', '7g7f', '8c8d', '6i7h'];
    // 手番だけ入れ替えて素直に再生すると、当然どこも破綻しない
    const rotated = asRead.map((usi, i) => ({
      usi: rotateUsi(usi),
      side: i % 2 === 0 ? ('sente' as Side) : ('gote' as Side),
      time: i,
    }));
    const r = replayGame(rotated);
    expect(r.problems).toEqual([]);
    expect(rotated[0].usi).toBe('7g7f');
  });

  it('初期局面は 180° 回転で自分自身に移る（だから気づけない）', () => {
    // 先手の合法手を回すと、後手の合法手の集合にぴたりと重なる。
    // 盤の絵だけを見ている限り、どちらの向きでも同じだけ辻褄が合ってしまう。
    const sente = generateMoves(createInitialState()).map((m) => m.usi);
    const gote = generateMoves({ ...createInitialState(), sideToMove: 'gote' }).map((m) => m.usi);
    expect(new Set(sente.map(rotateUsi))).toEqual(new Set(gote));
  });
});

describe('flipSide', () => {
  it('先後を入れ替える', () => {
    expect(flipSide('sente')).toBe('gote');
    expect(flipSide('gote')).toBe('sente');
  });
});
