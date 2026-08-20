import { describe, expect, it } from 'vitest';
import { createInitialState, type Square } from 'shared';
import { checkBoard, checkRead, pieceCount, overflowCells, sameSideKindCells } from './sanity.ts';
import { UNKNOWN, type VisionSquare } from './uncertain.ts';

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

describe('overflowCells', () => {
  /** 全マス NaN の一致度表（駒があるマスだけ後から入れる） */
  function noScores(): number[][] {
    return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => NaN));
  }

  function setScore(scores: number[][], usi: string, v: number): void {
    scores[usi.charCodeAt(1) - 97][9 - Number(usi[0])] = v;
  }

  it('規定どおりなら何も挙げない', () => {
    const scores = noScores();
    expect(overflowCells(createInitialState().board, scores)).toEqual([]);
  });

  it('はみ出した枚数だけ、一致度の低い方から挙げる', () => {
    // 桂を 5 枚置く（上限 4）。テンプレートの無い成桂が「桂」と読まれた状況。
    const b = withKings();
    const scores = noScores();
    const cells = ['9a', '1a', '9i', '1i', '5e'];
    for (const [i, usi] of cells.entries()) {
      put(b, usi, { kind: 'N', side: i < 2 ? 'gote' : 'sente' });
      setScore(scores, usi, i === 4 ? 0.2 : 0.98); // 5e だけ一致度が低い
    }

    const over = overflowCells(b, scores);
    expect(over).toHaveLength(1);
    expect(over[0]).toEqual({ row: 4, col: 4 }); // 5e
  });

  it('2 枚はみ出していれば 2 マス挙げる', () => {
    const b = withKings();
    const scores = noScores();
    const cells = ['9a', '1a', '9i', '1i', '5e', '4e'];
    for (const [i, usi] of cells.entries()) {
      put(b, usi, { kind: 'N', side: i < 2 ? 'gote' : 'sente' });
      setScore(scores, usi, i >= 4 ? 0.2 : 0.98);
    }
    expect(overflowCells(b, scores)).toHaveLength(2);
  });

  it('成駒は元の駒として数える', () => {
    const b = withKings();
    const scores = noScores();
    // 飛 2 枚 + 龍 1 枚 = 3 枚で上限 2 を超える
    for (const [i, usi] of ['2h', '8b', '5e'].entries()) {
      put(b, usi, { kind: i === 2 ? '+R' : 'R', side: 'sente' });
      setScore(scores, usi, i === 2 ? 0.3 : 0.99);
    }
    expect(overflowCells(b, scores)).toEqual([{ row: 4, col: 4 }]);
  });
});

describe('pieceCount', () => {
  it('初期配置は 40 枚', () => {
    expect(pieceCount(createInitialState().board)).toBe(40);
  });
});

describe('sameSideKindCells', () => {
  const board = (): Square[][] => Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));

  it('同じ側の別の駒に化けたマスを挙げる（起こりえない変化）', () => {
    // 8f の ▽金 を ▽全（成銀）と読んだ。実測で踏んだ形。
    const tracked = board();
    tracked[5][1] = { kind: 'G', side: 'gote' };
    const read: VisionSquare[][] = board();
    read[5][1] = { kind: '+S', side: 'gote' };

    expect(sameSideKindCells(tracked, read)).toEqual([{ row: 5, col: 1 }]);
  });

  it('相手の駒に変わったマスは挙げない（取られた形なのでありうる）', () => {
    const tracked = board();
    tracked[5][1] = { kind: 'G', side: 'gote' };
    const read: VisionSquare[][] = board();
    read[5][1] = { kind: 'S', side: 'sente' };

    expect(sameSideKindCells(tracked, read)).toEqual([]);
  });

  it('空になったマスは挙げない（動いた形なのでありうる）', () => {
    const tracked = board();
    tracked[5][1] = { kind: 'G', side: 'gote' };
    expect(sameSideKindCells(tracked, board())).toEqual([]);
  });

  it('未確定のマスは挙げない（読めていないだけ）', () => {
    const tracked = board();
    tracked[5][1] = { kind: 'G', side: 'gote' };
    const read: VisionSquare[][] = board();
    read[5][1] = UNKNOWN;
    expect(sameSideKindCells(tracked, read)).toEqual([]);
  });

  it('同じ駒なら挙げない', () => {
    const tracked = board();
    tracked[5][1] = { kind: 'G', side: 'gote' };
    const read: VisionSquare[][] = board();
    read[5][1] = { kind: 'G', side: 'gote' };
    expect(sameSideKindCells(tracked, read)).toEqual([]);
  });
});

describe('checkRead（未確定を含む読みが成立しうるか）', () => {
  /** 未確定を混ぜた読みにする */
  function asRead(b: Square[][], unknowns: string[] = []): VisionSquare[][] {
    const out: VisionSquare[][] = b.map((r) => r.slice());
    for (const usi of unknowns) out[usi.charCodeAt(1) - 97][9 - Number(usi[0])] = UNKNOWN;
    return out;
  }

  it('平手初期配置は成立する', () => {
    expect(checkRead(asRead(createInitialState().board)).ok).toBe(true);
  });

  it('⭐ 玉が見えなくても、未確定のマスがあれば成立しうる（王手の演出は玉の周りに出る）', () => {
    const b = withKings();
    const read = asRead(b, ['5i']);
    expect(checkRead(read).ok).toBe(true);
  });

  it('🔒 未確定が 1 つも無いのに玉が見えなければ成立しない', () => {
    const b = withKings();
    b[8][4] = null; // 5i の玉を消す
    expect(checkRead(asRead(b)).ok).toBe(false);
  });

  it('同じ側の玉が 2 枚見えていれば、未確定があっても成立しない', () => {
    const b = withKings();
    put(b, '4i', { kind: 'K', side: 'sente' });
    expect(checkRead(asRead(b, ['1a'])).ok).toBe(false);
  });

  it('🔴 引き継ぎで玉が 3 枚になった合成盤は checkBoard に落ちるが、素の読みは通る', () => {
    // これが 3 本目 2 局目の自己ロックの形（`HANDOFF-clock.md`）。
    // 玉が 5i → 4i へ動き、移動元が演出で読めない。引き継ぎは 5i に古い玉を
    // 置くので「K が 3 枚」になるが、**素の読みは 2 枚のままで矛盾していない**。
    const moved = withKings();
    moved[8][4] = null;
    put(moved, '4i', { kind: 'K', side: 'sente' });
    const read = asRead(moved, ['5i']);
    expect(checkRead(read).ok).toBe(true);

    const carried = moved.map((r) => r.slice());
    put(carried, '5i', { kind: 'K', side: 'sente' }); // 引き継ぎが古い玉を戻す
    const composed = checkBoard(carried);
    expect(composed.ok).toBe(false);
    expect(composed.problems.join()).toContain('K が 3 枚');
  });

  it('見えているぶんだけで駒数が上限を超えれば成立しない', () => {
    const b = withKings();
    for (const usi of ['9f', '8f', '7f']) put(b, usi, { kind: 'B', side: 'sente' });
    expect(checkRead(asRead(b, ['1a'])).ok).toBe(false);
  });

  it('二歩は見えている歩だけで判定する', () => {
    const b = withKings();
    put(b, '7f', { kind: 'P', side: 'sente' });
    put(b, '7d', { kind: 'P', side: 'sente' });
    expect(checkRead(asRead(b)).problems.join()).toContain('二歩');
    // 片方が未確定なら「歩かもしれない」だけなので責めない
    expect(checkRead(asRead(b, ['7d'])).ok).toBe(true);
  });

  it('行き所のない駒は見えていれば弾く', () => {
    const b = withKings();
    put(b, '1a', { kind: 'P', side: 'sente' });
    expect(checkRead(asRead(b)).ok).toBe(false);
  });
});
