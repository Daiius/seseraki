import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, type PieceKind, type Square } from 'shared';
import { generateMoves } from './movegen.ts';
import { canPlay, completeIfInitial, handsAreGuessed, isInitialBoard, offBoardPieces, startFromBoard, startState } from './tracking.ts';

const at = (usi: string) => ({ row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) });

function boardWith(pieces: [square: string, kind: PieceKind, side: 'sente' | 'gote'][]): Square[][] {
  const board: Square[][] = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));
  for (const [sq, kind, side] of pieces) {
    const { row, col } = at(sq);
    board[row][col] = { kind, side };
  }
  return board;
}

describe('offBoardPieces', () => {
  it('初期局面では盤に無い駒は無い', () => {
    expect(offBoardPieces(createInitialState().board)).toEqual({});
  });

  it('取られた駒が数に出る', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d', '8h2b+']) s = applyMove(s, usi);
    // 先手の角が後手の角を取った。盤から角が 1 枚消えている。
    expect(offBoardPieces(s.board)).toEqual({ B: 1 });
  });

  it('成駒は元の駒として数える（持ち駒に戻れば生駒に戻るので）', () => {
    const board = boardWith([['5e', '+P', 'sente'], ['5i', 'K', 'sente'], ['5a', 'K', 'gote']]);
    // 歩は 18 枚。盤上のと金 1 枚を歩として数えるので、残りは 17 枚。
    expect(offBoardPieces(board).P).toBe(17);
  });
});

describe('startState', () => {
  it('初期局面から始めるなら、持ち駒も手番も正確に分かる', () => {
    const s = startState(createInitialState().board, 'sente');
    expect(s.hand.sente).toEqual({});
    expect(s.hand.gote).toEqual({});
    expect(handsAreGuessed(s)).toBe(false);
  });

  it('途中の局面から始めるなら、持ち駒は両者に持たせる', () => {
    // 🔒 分からないときは**候補が広がる方**へ倒す。狭める方に間違えると、
    // 本当に指された打ちが候補から消えて、そこで追跡が切れる。
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d', '8h2b+']) s = applyMove(s, usi);
    const started = startState(s.board, 'gote');
    expect(started.hand.sente).toEqual({ B: 1 });
    expect(started.hand.gote).toEqual({ B: 1 });
    expect(handsAreGuessed(started)).toBe(true);
  });

  it('広げた持ち駒でも、盤上の手はそのまま挙がる', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d', '8h2b+', '3a2b']) s = applyMove(s, usi);
    const guessed = startFromBoard(s.board, 'sente');
    const usis = new Set(generateMoves(guessed).map((m) => m.usi));
    // 本当に指せる手（角打ち）は入っている
    expect(usis.has('B*4e')).toBe(true);
    expect(usis.has('7f7e')).toBe(true);
  });

  it('正確な持ち駒なら、持っていない駒の打ちは挙がらない', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d', '8h2b+', '3a2b']) s = applyMove(s, usi);
    // 先手は角だけを持っている
    expect(generateMoves(s).some((m) => m.usi.startsWith('B*'))).toBe(true);
    expect(generateMoves(s).some((m) => m.usi.startsWith('P*'))).toBe(false);
  });
});

describe('isInitialBoard', () => {
  it('平手初期局面を見分ける', () => {
    expect(isInitialBoard(createInitialState().board)).toBe(true);
    expect(isInitialBoard(applyMove(createInitialState(), '7g7f').board)).toBe(false);
  });
});

describe('completeIfInitial', () => {
  it('読めなかった穴があっても初期局面と分かり、穴が埋まる', () => {
    // ⭐ 起点の絵で 1 マス読めないことは珍しくない（ポインタは常に盤上のどこかにいる）。
    // 初期局面と見なされないと持ち駒が「不明」になり、偽の打ちが通ってしまう。
    const holed = createInitialState().board.map((r) => r.slice());
    holed[at('1c').row][at('1c').col] = null;
    const fixed = completeIfInitial(holed);
    expect(fixed).not.toBeNull();
    expect(fixed![at('1c').row][at('1c').col]).toEqual({ kind: 'P', side: 'gote' });
  });

  it('初期配置に無いマスに駒があれば、途中の局面として断る', () => {
    const moved = applyMove(createInitialState(), '7g7f').board;
    expect(completeIfInitial(moved)).toBeNull();
  });

  it('駒種が違えば断る', () => {
    const wrong = createInitialState().board.map((r) => r.slice());
    wrong[at('1c').row][at('1c').col] = { kind: 'G', side: 'gote' };
    expect(completeIfInitial(wrong)).toBeNull();
  });

  it('穴が多すぎれば断る', () => {
    const holed = createInitialState().board.map((r) => r.slice());
    for (const sq of ['1c', '2c', '3c', '4c']) holed[at(sq).row][at(sq).col] = null;
    expect(completeIfInitial(holed, 3)).toBeNull();
  });

  it('穴を埋めた起点なら、持ち駒は空になる（偽の打ちが候補から消える）', () => {
    const holed = createInitialState().board.map((r) => r.slice());
    holed[at('1c').row][at('1c').col] = null;
    const s = startState(holed, 'sente');
    expect(s.hand.sente).toEqual({});
    expect(s.hand.gote).toEqual({});
    expect(generateMoves(s).some((m) => m.usi.startsWith('P*'))).toBe(false);
  });
});

describe('canPlay', () => {
  it('持っていない駒の打ちを断る（applyMove は黙って通してしまう）', () => {
    const s = createInitialState();
    expect(canPlay(s, 'P*1c', 'sente')).toBe(false);
    // ⚠ shared の applyMove は例外を投げない。持ち駒が負になって消えるだけ。
    expect(() => applyMove(s, 'P*1c')).not.toThrow();
  });

  it('持っている駒の打ちは通す', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d', '8h2b+', '3a2b']) s = applyMove(s, usi);
    expect(canPlay(s, 'B*4e', 'sente')).toBe(true);
  });

  it('盤上の移動は素通しする（絞るのは差分と legality の仕事）', () => {
    expect(canPlay(createInitialState(), '7g7f', 'sente')).toBe(true);
  });
});
