import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, type PieceKind, type Square } from 'shared';
import { generateMoves } from './movegen.ts';
import { handsAreGuessed, isInitialBoard, offBoardPieces, startFromBoard, startState } from './tracking.ts';

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
