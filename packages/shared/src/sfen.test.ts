import { describe, expect, it } from 'vitest';
import { createInitialState, applyMove } from './board';
import { positionSfen } from './position';
import { parseSfen, usiPositionSfen } from './sfen';

const INITIAL_SFEN =
  'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -';

describe('parseSfen', () => {
  it('初期局面を往復できる', () => {
    const state = parseSfen(INITIAL_SFEN);
    expect(state).not.toBeNull();
    expect(positionSfen(state!)).toBe(INITIAL_SFEN);
  });

  it('手数フィールド付き（4 フィールド）も読める', () => {
    const state = parseSfen(`${INITIAL_SFEN} 1`);
    expect(positionSfen(state!)).toBe(INITIAL_SFEN);
  });

  it('成駒と持ち駒を読める', () => {
    const sfen = '4k4/9/9/9/9/9/9/9/4K3+R w 2P3l';
    const state = parseSfen(sfen);
    expect(state).not.toBeNull();
    expect(state!.sideToMove).toBe('gote');
    expect(state!.board[8][8]).toEqual({ kind: '+R', side: 'sente' });
    expect(state!.hand.sente.P).toBe(2);
    expect(state!.hand.gote.L).toBe(3);
    // 往復しても同じ文字列になる
    expect(positionSfen(state!)).toBe(sfen);
  });

  it('手を進めた局面の SFEN を読み戻せる', () => {
    const moved = applyMove(applyMove(createInitialState(), '7g7f'), '3c3d');
    const round = parseSfen(positionSfen(moved));
    expect(positionSfen(round!)).toBe(positionSfen(moved));
  });

  it.each([
    ['段が足りない', 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1 b -'],
    ['1 段のマス数が合わない', '9/9/9/9/9/9/9/9/8 b -'],
    ['未知の駒文字', '9/9/9/9/9/9/9/9/8X b -'],
    ['手番が不正', 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL x -'],
    ['持ち駒に玉', '9/9/9/9/9/9/9/9/9 b K'],
    ['持ち駒に成駒', '9/9/9/9/9/9/9/9/9 b +P'],
    ['持ち駒の枚数だけで駒が無い', '9/9/9/9/9/9/9/9/9 b 2'],
    ['成りの後に駒が無い', '9/9/9/9/9/9/9/9/8+ b -'],
    ['金は成れない', '9/9/9/9/9/9/9/9/8+G b -'],
    ['フィールド数が足りない', 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b'],
  ])('読めない SFEN は null を返す: %s', (_name, sfen) => {
    expect(parseSfen(sfen)).toBeNull();
  });
});

describe('usiPositionSfen', () => {
  it('手数 1 を足した 4 フィールドで返す', () => {
    expect(usiPositionSfen(createInitialState())).toBe(`${INITIAL_SFEN} 1`);
  });

  it('USI に渡してそのまま読み戻せる', () => {
    const state = parseSfen(usiPositionSfen(createInitialState()));
    expect(positionSfen(state!)).toBe(INITIAL_SFEN);
  });
});
