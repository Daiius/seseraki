import { describe, expect, it } from 'vitest';
import { buildPositions, createInitialState } from './board';
import {
  boardBytes,
  handBytes,
  positionDistance,
  positionKey,
  positionSfen,
  sideSfen,
  stateFromBytes,
} from './position';

/** 指し手列を適用した後の局面キー */
function keyAfter(moves: string[]) {
  const positions = buildPositions(moves);
  return positionKey(positions[positions.length - 1]);
}

describe('positionSfen', () => {
  it('初期局面は標準の SFEN になる', () => {
    expect(positionSfen(createInitialState())).toBe(
      'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -',
    );
  });

  it('手番が末尾に出る', () => {
    expect(positionSfen(buildPositions(['7g7f'])[1])).toContain(' w ');
  });

  it('持ち駒は SFEN の慣習の順で、枚数は前置する', () => {
    // 角交換して双方が角を 1 枚ずつ持つ
    const state = buildPositions(['7g7f', '3c3d', '8h2b+', '3a2b'])[4];
    expect(positionSfen(state)).toMatch(/ (b|w) Bb$/);
  });
});

describe('手順前後の吸収（このモジュールの目的）', () => {
  it('違う順で同じ局面に至れば同じキーになる', () => {
    const a = keyAfter(['7g7f', '3c3d', '2g2f', '8c8d']);
    const b = keyAfter(['2g2f', '8c8d', '7g7f', '3c3d']);
    expect(a.sfen).toBe(b.sfen);
    expect(a.senteSfen).toBe(b.senteSfen);
    expect(a.goteSfen).toBe(b.goteSfen);
  });

  it('手数が違っても同じ局面なら同じキー（DAG になる）', () => {
    // 玉を往復させて 4 手余計に使い、同じ配置・同じ手番に戻る
    const short = keyAfter(['7g7f', '3c3d']);
    const long = keyAfter(['7g7f', '3c3d', '5i5h', '5a5b', '5h5i', '5b5a']);
    expect(long.sfen).toBe(short.sfen);
  });
});

describe('区別すべきものは区別する', () => {
  it('手番が違えば別の局面', () => {
    const state = buildPositions(['7g7f'])[1];
    const flipped = { ...state, sideToMove: 'sente' as const };
    expect(positionSfen(state)).not.toBe(positionSfen(flipped));
  });

  it('持ち駒が違えば別の局面（盤が同じでも）', () => {
    const state = createInitialState();
    const withHand = {
      ...state,
      hand: { sente: { P: 1 }, gote: {} },
    };
    expect(positionSfen(state)).not.toBe(positionSfen(withHand));
  });

  it('同じ駒でも持ち主が違えば別の局面', () => {
    const base = createInitialState();
    const senteHas = { ...base, hand: { sente: { P: 1 }, gote: {} } };
    const goteHas = { ...base, hand: { sente: {}, gote: { P: 1 } } };
    expect(positionSfen(senteHas)).not.toBe(positionSfen(goteHas));
  });
});

describe('sideSfen（片側だけの配置）', () => {
  it('相手の駒は空として書く', () => {
    const sente = sideSfen(createInitialState(), 'sente');
    // 上 3 段（後手の駒）は全部空になる
    expect(sente.startsWith('9/9/9/')).toBe(true);
    expect(sente).toContain('PPPPPPPPP');
  });

  it('手番を含めない（同じ配置なら手番が違っても同じ）', () => {
    const afterSente = buildPositions(['7g7f'])[1];
    const sente = sideSfen(afterSente, 'sente');
    expect(sente).not.toContain(' b ');
    expect(sente).not.toContain(' w ');
  });

  it('相手だけが動いても自分側のキーは変わらない', () => {
    const before = buildPositions(['7g7f'])[1];
    const after = buildPositions(['7g7f', '3c3d'])[2];
    expect(sideSfen(before, 'sente')).toBe(sideSfen(after, 'sente'));
    expect(sideSfen(before, 'gote')).not.toBe(sideSfen(after, 'gote'));
  });
});

describe('boardBytes', () => {
  it('81 バイトで、空は 0・先手は 1..14・後手は 17..30', () => {
    const bytes = boardBytes(createInitialState());
    expect(bytes).toHaveLength(81);
    // 1 段目（後手の香桂銀金玉金銀桂香）
    expect([...bytes.slice(0, 9)]).toEqual([18, 19, 20, 21, 24, 21, 20, 19, 18]);
    // 4 段目は空
    expect([...bytes.slice(27, 36)]).toEqual(Array(9).fill(0));
    // 7 段目（先手の歩）
    expect([...bytes.slice(54, 63)]).toEqual(Array(9).fill(1));
  });

  it('成駒は生駒と別の値になる', () => {
    const promoted = buildPositions(['7g7f', '3c3d', '8h2b+'])[3];
    const bytes = boardBytes(promoted);
    // ⚠ 内部配列は board[row][col] で **col=0 が 9 筋**（board.ts の冒頭）。
    // 2b は 2 段目・2 筋なので row=1, col=7 → index 16
    expect(bytes[16]).toBe(13); // 先手の馬（+B）
    // 取られる前は後手の角（B=6 に後手フラグ 16）だった
    expect(boardBytes(buildPositions(['7g7f', '3c3d'])[2])[16]).toBe(22);
  });
});

describe('handBytes', () => {
  it('14 バイトで、先手 7 種 → 後手 7 種の順', () => {
    const bytes = handBytes(createInitialState());
    expect(bytes).toHaveLength(14);
    expect([...bytes]).toEqual(Array(14).fill(0));
  });

  it('角交換すると双方の角の位置に 1 が立つ', () => {
    const state = buildPositions(['7g7f', '3c3d', '8h2b+', '3a2b'])[4];
    const bytes = handBytes(state);
    // 並びは R B G S N L P。角は index 1（先手）と 8（後手）
    expect(bytes[1]).toBe(1);
    expect(bytes[8]).toBe(1);
    expect([...bytes].reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe('stateFromBytes（バイト列から局面を戻す）', () => {
  it('往復して同じ局面キーになる', () => {
    // 成駒・持ち駒・後手番が揃う局面で確かめる
    const moves = ['7g7f', '3c3d', '8h2b+', '3a2b', '2b3c', 'P*3e'];
    for (const state of buildPositions(moves)) {
      const key = positionKey(state);
      const restored = stateFromBytes(key.board, key.hands, key.sideToMove);
      expect(positionKey(restored)).toEqual(key);
    }
  });

  it('初期局面を戻すと初期局面になる', () => {
    const key = positionKey(createInitialState());
    const restored = stateFromBytes(key.board, key.hands, key.sideToMove);
    expect(positionSfen(restored)).toBe(positionSfen(createInitialState()));
  });

  it('成駒と後手の駒を取り違えない', () => {
    const state = buildPositions(['7g7f', '3c3d', '8h2b+'])[3];
    const key = positionKey(state);
    const restored = stateFromBytes(key.board, key.hands, key.sideToMove);
    // 2b は先手の馬（row=1, col=7）
    expect(restored.board[1][7]).toEqual({ kind: '+B', side: 'sente' });
    // 3a は後手の銀
    expect(restored.board[0][6]).toEqual({ kind: 'S', side: 'gote' });
  });
});

describe('positionDistance', () => {
  it('同じ局面の距離は 0', () => {
    const a = positionKey(createInitialState());
    expect(positionDistance(a, a)).toBe(0);
  });

  it('1 手動かすと 2 マスぶん違う（移動元と移動先）', () => {
    const a = positionKey(createInitialState());
    const b = keyAfter(['7g7f']);
    expect(positionDistance(a, b)).toBe(2);
  });

  it('駒を取ると持ち駒の差も数える', () => {
    // 角交換の直後: 盤は 2 マス違い（8h と 2b）、持ち駒は先手の角が 1 枚増える
    const before = keyAfter(['7g7f', '3c3d']);
    const after = keyAfter(['7g7f', '3c3d', '8h2b+']);
    // 8h が空になり、2b が後手の角 → 先手の馬 に変わる = 2 マス
    // 先手の持ち駒に角が 1 枚 = 1
    expect(positionDistance(before, after)).toBe(3);
  });

  it('持ち駒の持ち主が違えば距離が出る（盤が同じでも）', () => {
    const base = createInitialState();
    const senteHas = positionKey({ ...base, hand: { sente: { P: 1 }, gote: {} } });
    const goteHas = positionKey({ ...base, hand: { sente: {}, gote: { P: 1 } } });
    // 盤は同じ。持ち駒は先手 +1 / 後手 +1 の 2 箇所で食い違う
    expect(positionDistance(senteHas, goteHas)).toBe(2);
  });
});
