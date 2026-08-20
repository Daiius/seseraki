import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, type BoardState, type Square } from 'shared';
import { pickByRuleOnly, destinationVisible } from './escape.ts';
import { generateMoves } from './movegen.ts';
import { UNKNOWN, type VisionSquare } from './uncertain.ts';

const at = (usi: string) => ({ row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) });

/** 盤面をそのまま「完璧に読めた」読みとして使う */
const asRead = (board: Square[][]): VisionSquare[][] => board.map((r) => r.slice());

/** 読みの一部を「読めなかった」ことにする */
function blank(read: VisionSquare[][], squares: string[]): VisionSquare[][] {
  const out = read.map((r) => r.slice());
  for (const sq of squares) {
    const { row, col } = at(sq);
    out[row][col] = UNKNOWN;
  }
  return out;
}

function after(state: BoardState, usi: string): BoardState {
  return applyMove(state, usi);
}

const moveNamed = (state: BoardState, usi: string) => generateMoves(state).find((m) => m.usi === usi)!;

describe('destinationVisible', () => {
  it('行き先がその駒として写っていれば true', () => {
    const before = createInitialState();
    const read = asRead(after(before, '7g7f').board);
    expect(destinationVisible(read, moveNamed(before, '7g7f'))).toBe(true);
  });

  it('行き先が未確定なら false（証拠の不在は証拠ではない）', () => {
    const before = createInitialState();
    const read = blank(asRead(after(before, '7g7f').board), ['7f']);
    expect(destinationVisible(read, moveNamed(before, '7g7f'))).toBe(false);
  });

  it('行き先が空に読めていれば false', () => {
    const before = createInitialState();
    const read = asRead(before.board); // まだ動いていない絵
    expect(destinationVisible(read, moveNamed(before, '7g7f'))).toBe(false);
  });

  it('成ったかどうかまで見る（`becomes` と突き合わせる）', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d']) s = after(s, usi);
    const read = asRead(after(s, '8h2b+').board); // 2b は馬
    expect(destinationVisible(read, moveNamed(s, '8h2b+'))).toBe(true);
    expect(destinationVisible(read, moveNamed(s, '8h2b'))).toBe(false);
  });
});

describe('pickByRuleOnly（成立しない絵からの脱出）', () => {
  it('時計が 1 手と言い、読みと一致する手が 1 つなら拾える', () => {
    const before = createInitialState();
    const read = asRead(after(before, '7g7f').board);
    const pick = pickByRuleOnly(before, read, { clockMoves: 1 });
    expect(pick).not.toBeNull();
    expect(pick!.via).toBe('single');
    expect(pick!.moves.map((m) => m.usi)).toEqual(['7g7f']);
  });

  it('🔒 時計が「この窓で誰も指していない」と言うなら何も拾わない', () => {
    const before = createInitialState();
    const read = asRead(after(before, '7g7f').board);
    expect(pickByRuleOnly(before, read, { clockMoves: 0 })).toBeNull();
  });

  it('🔒 行き先が絵に写っていなければ拾わない（既定）', () => {
    // ⚠ 移動元だけ読めていれば `pickCandidate` は手を決められる。だが
    // 「読めないマスへ動いた」は証拠の不在を証拠として使うことなので、
    // 霧の中の脱出ではそれを採らない。
    const before = createInitialState();
    const read = blank(asRead(after(before, '7g7f').board), ['7f']);
    expect(pickByRuleOnly(before, read, { clockMoves: 1 })).toBeNull();
  });

  it('門を外せば同じ絵から拾える（`requireVisibleDestination: false`）', () => {
    const before = createInitialState();
    const read = blank(asRead(after(before, '7g7f').board), ['7f']);
    const pick = pickByRuleOnly(before, read, { clockMoves: 1, requireVisibleDestination: false });
    expect(pick!.moves.map((m) => m.usi)).toEqual(['7g7f']);
  });

  it('⭐ 2 手進んでいても、時計が 2 手と言えば分解して拾える', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d']) s = after(s, usi);
    const two = after(after(s, '8h2b+'), '3a2b');
    const pick = pickByRuleOnly(s, asRead(two.board), { clockMoves: 2 });
    expect(pick).not.toBeNull();
    expect(pick!.via).toBe('pair');
    expect(pick!.moves.map((m) => m.usi)).toEqual(['8h2b', '3a2b']);
    // 角は 2b で取られるので成/不成は原理的に決まらない。印は残す。
    expect(pick!.promotionUncertain).toBe(true);
  });

  it('🔒 時計が 1 手としか言わないなら、2 手の説明は作らない', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d']) s = after(s, usi);
    const two = after(after(s, '8h2b+'), '3a2b');
    expect(pickByRuleOnly(s, asRead(two.board), { clockMoves: 1 })).toBeNull();
  });

  it('🔒 3 手ぶん進んでいたら（時計が 3 手と言っても）何も作らない', () => {
    // 2 手では説明が付かず、3 手の探索は持っていない。**正直な穴として残す。**
    let s = createInitialState();
    let three = s;
    for (const usi of ['7g7f', '3c3d', '2g2f']) three = after(three, usi);
    expect(pickByRuleOnly(s, asRead(three.board), { clockMoves: 3 })).toBeNull();
  });

  it('🔒 読みが追跡盤面と大きく食い違えば拾わない（食い違いの上限）', () => {
    // 追跡がずれている絵。どの 1 手でも説明が付かないので選ばない。
    const before = createInitialState();
    const read = asRead(before.board);
    read[4][4] = { kind: 'R', side: 'sente' }; // 5e に有り得ない飛車
    read[4][3] = { kind: 'B', side: 'gote' };
    expect(pickByRuleOnly(before, read, { clockMoves: 1 })).toBeNull();
  });

  it('⭐ 覆われたマスがあっても、行き先さえ写っていれば拾える', () => {
    // 王手の演出は 1〜2 マスを覆う。覆われたのが手と無関係のマスなら、
    // 候補との突き合わせでは「情報が無い」として飛ばされるだけで済む。
    const before = createInitialState();
    const read = blank(asRead(after(before, '7g7f').board), ['1a', '9i', '5e']);
    const pick = pickByRuleOnly(before, read, { clockMoves: 1 });
    expect(pick!.moves.map((m) => m.usi)).toEqual(['7g7f']);
  });
});
