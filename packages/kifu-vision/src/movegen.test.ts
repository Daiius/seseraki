import { describe, expect, it } from 'vitest';
import { createInitialState, applyMove, type BoardState, type PieceKind, type Side, type Square } from 'shared';
import { generateMoves, groupByDestination, isInCheck, findKing } from './movegen.ts';

/** USI のマス表記（"7g" など）から [row, col] へ */
const at = (usi: string) => ({ row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) });

function emptyBoard(): Square[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));
}

function state(
  pieces: [square: string, kind: PieceKind, side: Side][],
  sideToMove: Side = 'sente',
  hand: BoardState['hand'] = { sente: {}, gote: {} },
): BoardState {
  const board = emptyBoard();
  for (const [sq, kind, side] of pieces) {
    const { row, col } = at(sq);
    board[row][col] = { kind, side };
  }
  return { board, hand, sideToMove };
}

describe('generateMoves', () => {
  it('平手初期局面の合法手は 30 手', () => {
    // 将棋の初期局面の合法手数は 30 で確定している（歩 18・香 4・銀 4・金 2・玉 1・飛 1）。
    // 数が合うことは、動き・成り・打ちの扱いがまとめて正しいことの証拠になる。
    const moves = generateMoves(createInitialState());
    expect(moves).toHaveLength(30);
    expect(new Set(moves.map((m) => m.usi)).size).toBe(30);
  });

  it('1 手進めた局面でも合法手は 30 手', () => {
    const after = applyMove(createInitialState(), '7g7f');
    expect(generateMoves(after)).toHaveLength(30);
  });

  it('敵陣に入る手は成りと不成の両方を挙げる', () => {
    // 飛が 2 段目へ動く。成っても成らなくてもよい形。
    const s = state([['2h', 'R', 'sente'], ['5i', 'K', 'sente'], ['5a', 'K', 'gote']]);
    const toSecondRank = generateMoves(s).filter((m) => m.usi.startsWith('2h2b'));
    expect(toSecondRank.map((m) => m.usi).sort()).toEqual(['2h2b', '2h2b+']);
    expect(toSecondRank.find((m) => m.promotes)!.becomes).toBe('+R');
    expect(toSecondRank.find((m) => !m.promotes)!.becomes).toBe('R');
  });

  it('行き所の無い駒になる手は、成る方しか挙げない', () => {
    // 歩が最奥へ。成らずには指せない。
    const s = state([['5b', 'P', 'sente'], ['5i', 'K', 'sente'], ['1a', 'K', 'gote']]);
    const toLast = generateMoves(s).filter((m) => m.usi.startsWith('5b5a'));
    expect(toLast.map((m) => m.usi)).toEqual(['5b5a+']);
  });

  it('成った駒はもう成れない', () => {
    const s = state([['2b', '+R', 'sente'], ['5i', 'K', 'sente'], ['5a', 'K', 'gote']]);
    expect(generateMoves(s).every((m) => !m.promotes)).toBe(true);
  });

  it('自分の駒がいるマスへは動けない', () => {
    const s = state([['5e', 'R', 'sente'], ['5d', 'G', 'sente'], ['5i', 'K', 'sente'], ['5a', 'K', 'gote']]);
    expect(generateMoves(s).some((m) => m.usi === '5e5d')).toBe(false);
    // その先へも通れない（滑る駒は味方に遮られる）
    expect(generateMoves(s).some((m) => m.usi.startsWith('5e5c'))).toBe(false);
  });

  it('相手の駒は取れる。取った駒種を記録する', () => {
    const s = state([['5e', 'R', 'sente'], ['5d', 'G', 'gote'], ['5i', 'K', 'sente'], ['5a', 'K', 'gote']]);
    const capture = generateMoves(s).find((m) => m.usi === '5e5d');
    expect(capture?.captures).toBe('G');
  });

  it('二歩になる打ちは挙げない', () => {
    const s = state(
      [['5g', 'P', 'sente'], ['5i', 'K', 'sente'], ['5a', 'K', 'gote']],
      'sente',
      { sente: { P: 1 }, gote: {} },
    );
    const drops = generateMoves(s).filter((m) => m.usi.startsWith('P*'));
    // 5 筋には既に歩がいるので、5 筋への打ちだけが消える
    expect(drops.some((m) => m.usi.endsWith('e'))).toBe(true);
    expect(drops.some((m) => m.usi.startsWith('P*5'))).toBe(false);
  });

  it('と金は二歩に数えない', () => {
    const s = state(
      [['5g', '+P', 'sente'], ['5i', 'K', 'sente'], ['5a', 'K', 'gote']],
      'sente',
      { sente: { P: 1 }, gote: {} },
    );
    expect(generateMoves(s).some((m) => m.usi === 'P*5e')).toBe(true);
  });

  it('持っていない駒は打てない', () => {
    const s = state([['5i', 'K', 'sente'], ['5a', 'K', 'gote']], 'sente', { sente: { P: 1 }, gote: {} });
    const drops = generateMoves(s).filter((m) => m.from === null);
    expect(drops.every((m) => m.kind === 'P')).toBe(true);
    expect(drops.length).toBeGreaterThan(0);
  });

  it('歩・香は最奥に、桂は奥 2 段に打てない', () => {
    const s = state([['5i', 'K', 'sente'], ['5a', 'K', 'gote']], 'sente', {
      sente: { P: 1, L: 1, N: 1 }, gote: {},
    });
    const drops = generateMoves(s).filter((m) => m.from === null).map((m) => m.usi);
    expect(drops).not.toContain('P*4a');
    expect(drops).not.toContain('L*4a');
    expect(drops).not.toContain('N*4a');
    expect(drops).not.toContain('N*4b');
    expect(drops).toContain('P*4b');
    expect(drops).toContain('N*4c');
  });

  it('後手の手番なら後手の手だけを挙げる', () => {
    const s = state([['5g', 'P', 'sente'], ['5c', 'P', 'gote'], ['5i', 'K', 'sente'], ['5a', 'K', 'gote']], 'gote');
    expect(generateMoves(s).every((m) => m.side === 'gote')).toBe(true);
    expect(generateMoves(s).some((m) => m.usi === '5c5d')).toBe(true);
  });
});

  it('🔒 相手玉を取る手は候補に入れない', () => {
    // 玉を取る手は将棋の合法手ではない。認識がずれた局面でこれを候補に入れると、
    // 絵といちばん整合したときに採用され、通し再生も同じ生成器なので「合法」と数えてしまう。
    const st = state([
      ['5i', 'K', 'sente'],
      ['5a', 'K', 'gote'],
      ['5b', 'R', 'sente'],
    ]);
    const usis = generateMoves(st).map((m) => m.usi);
    expect(usis).not.toContain('5b5a');
    expect(usis).not.toContain('5b5a+');
    // 玉以外は今までどおり取れる（門を締めすぎていないこと）
    const st2 = state([
      ['5i', 'K', 'sente'],
      ['1a', 'K', 'gote'],
      ['5b', 'R', 'sente'],
      ['5a', 'G', 'gote'],
    ]);
    expect(generateMoves(st2).map((m) => m.usi)).toContain('5b5a');
  });

describe('isInCheck / 王手放置', () => {
  it('飛に睨まれていれば王手', () => {
    const s = state([['5i', 'K', 'sente'], ['5a', 'R', 'gote'], ['1a', 'K', 'gote']]);
    expect(isInCheck(s.board, 'sente')).toBe(true);
    expect(isInCheck(s.board, 'gote')).toBe(false);
  });

  it('間に駒があれば王手ではない', () => {
    const s = state([['5i', 'K', 'sente'], ['5e', 'G', 'sente'], ['5a', 'R', 'gote'], ['1a', 'K', 'gote']]);
    expect(isInCheck(s.board, 'sente')).toBe(false);
  });

  it('王手を放置する手は挙げない', () => {
    // 5e の金は 5 筋の飛を止めている。横へ動くと玉が取られる。
    const s = state([['5i', 'K', 'sente'], ['5e', 'G', 'sente'], ['5a', 'R', 'gote'], ['1a', 'K', 'gote']]);
    const moves = generateMoves(s).map((m) => m.usi);
    expect(moves).not.toContain('5e4e');
    expect(moves).not.toContain('5e6e');
    // 筋を外れなければよい
    expect(moves).toContain('5e5d');
  });

  it('玉が取られる盤面でも例外にせず、王手ではないと答える', () => {
    // 認識が壊れると玉のいない盤面が来る。ここで落ちると走査全体が止まる。
    const s = state([['5e', 'G', 'sente']]);
    expect(findKing(s.board, 'sente')).toBeNull();
    expect(isInCheck(s.board, 'sente')).toBe(false);
  });

  it('legalOnly を切れば王手放置も挙げる（盤面が壊れている場合の逃げ道）', () => {
    const s = state([['5i', 'K', 'sente'], ['5e', 'G', 'sente'], ['5a', 'R', 'gote'], ['1a', 'K', 'gote']]);
    expect(generateMoves(s, { legalOnly: false }).map((m) => m.usi)).toContain('5e4e');
  });
});

describe('groupByDestination', () => {
  it('同じ移動元・移動先の手は 1 つにまとまる（違いは成るかどうかだけ）', () => {
    const s = state([['2h', 'R', 'sente'], ['5i', 'K', 'sente'], ['5a', 'K', 'gote']]);
    const groups = groupByDestination(generateMoves(s));
    const toB = [...groups].find(([k]) => k.endsWith('->1,7'))!; // 2b = row 1, col 7
    expect(toB[1].map((m) => m.usi).sort()).toEqual(['2h2b', '2h2b+']);
    // ⭐ 生駒か成駒かさえ読めれば選べる。成駒のテンプレートが無くても決まる。
    expect(new Set(toB[1].map((m) => m.becomes))).toEqual(new Set(['R', '+R']));
  });
});

describe('applyMove との整合', () => {
  it('挙げた手はすべて applyMove を通る', () => {
    // 候補が shared の適用器と食い違っていたら、second opinion として使えない。
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d', '8h2b+', '3a2b', 'B*4e']) s = applyMove(s, usi);
    for (const m of generateMoves(s)) {
      expect(() => applyMove(s, m.usi), m.usi).not.toThrow();
    }
  });

  it('取った駒は持ち駒に入り、次はそれを打てる', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d', '8h2b+']) s = applyMove(s, usi);
    // 先手は角を取って角を持っている。後手の手番なので、後手の候補には打ちが無い。
    expect(generateMoves(s).some((m) => m.usi.startsWith('B*'))).toBe(false);
    s = applyMove(s, '3a2b');
    expect(generateMoves(s).some((m) => m.usi.startsWith('B*'))).toBe(true);
  });
});
