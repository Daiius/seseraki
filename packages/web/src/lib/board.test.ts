import { describe, expect, it } from 'vitest';
import {
  applyMove,
  buildPositions,
  createInitialState,
  getPieceName,
  usiToJapaneseWithPiece,
  type BoardState,
} from './board';

/**
 * 盤面を人が読める図にする。
 * 左端が9筋・上端が一段目（`board[row][col]` の並びそのまま）。
 * 先手は `^`、後手は `v` を前置し、駒は USI 表記（成駒は `+P` 等）。
 */
function render(state: BoardState): string {
  return state.board
    .map((row) =>
      row
        .map((sq) =>
          sq === null
            ? ' ・'
            : `${sq.side === 'sente' ? '^' : 'v'}${sq.kind.padStart(2, ' ')}`,
        )
        .join(''),
    )
    .join('\n');
}

/** 手列を最後まで適用した局面 */
function last(usiMoves: string[]): BoardState {
  return buildPositions(usiMoves)[usiMoves.length];
}

const INITIAL_BOARD = [
  'v Lv Nv Sv Gv Kv Gv Sv Nv L',
  ' ・v R ・ ・ ・ ・ ・v B ・',
  'v Pv Pv Pv Pv Pv Pv Pv Pv P',
  ' ・ ・ ・ ・ ・ ・ ・ ・ ・',
  ' ・ ・ ・ ・ ・ ・ ・ ・ ・',
  ' ・ ・ ・ ・ ・ ・ ・ ・ ・',
  '^ P^ P^ P^ P^ P^ P^ P^ P^ P',
  ' ・^ B ・ ・ ・ ・ ・^ R ・',
  '^ L^ N^ S^ G^ K^ G^ S^ N^ L',
].join('\n');

describe('createInitialState', () => {
  it('平手初期局面を返す', () => {
    const state = createInitialState();
    expect(render(state)).toBe(INITIAL_BOARD);
    expect(state.hand).toEqual({ sente: {}, gote: {} });
    expect(state.sideToMove).toBe('sente');
  });

  it('内部配列は row=一段目から / col=9筋からの並びになっている', () => {
    // render() ごと座標変換を取り違えていないかを、生の添字でも押さえる
    const { board } = createInitialState();
    expect(board[8][4]).toEqual({ kind: 'K', side: 'sente' }); // 5i = 先手玉
    expect(board[0][4]).toEqual({ kind: 'K', side: 'gote' }); // 5a = 後手玉
    expect(board[7][7]).toEqual({ kind: 'R', side: 'sente' }); // 2h = 先手飛
    expect(board[8][0]).toEqual({ kind: 'L', side: 'sente' }); // 9i = 先手香
    expect(getPieceName(createInitialState(), '5i')).toBe('玉');
  });
});

describe('applyMove', () => {
  it('移動元を空にして移動先に置き、手番が入れ替わる', () => {
    const state = applyMove(createInitialState(), '7g7f');
    expect(getPieceName(state, '7g')).toBe('');
    expect(getPieceName(state, '7f')).toBe('歩');
    expect(state.sideToMove).toBe('gote');
  });

  it('成りの手は移動先で成駒になり、取った駒は持ち駒に入る', () => {
    // 角交換: 先手の角が 2b の後手角を取って成る（馬）
    const state = last(['7g7f', '3c3d', '8h2b+']);
    expect(getPieceName(state, '2b')).toBe('馬');
    expect(state.board[1][7]).toEqual({ kind: '+B', side: 'sente' });
    expect(state.hand.sente).toEqual({ B: 1 });
    expect(state.hand.gote).toEqual({});
  });

  it('駒打ちは持ち駒を1枚減らし、0枚になったら持ち駒から消える', () => {
    // 角交換 → 後手が馬を銀で取り返す → 先手が持ち駒の角を打つ
    const state = last(['7g7f', '3c3d', '8h2b+', '3a2b', 'B*4e']);
    expect(getPieceName(state, '4e')).toBe('角');
    expect(state.board[4][5]).toEqual({ kind: 'B', side: 'sente' });
    expect(state.hand.sente).toEqual({}); // 0 枚のキーは残さない
    expect(state.sideToMove).toBe('gote');
  });

  it('成駒を取ると生駒として持ち駒に入る（+R → R / +P → P）', () => {
    const state = last([
      '2g2f', //  1 先手 ２六歩
      '3c3d', //  2 後手 ３四歩
      '2f2e', //  3 先手 ２五歩
      '2b3c', //  4 後手 ３三角（2筋から角をどける）
      '2e2d', //  5 先手 ２四歩
      '3a2b', //  6 後手 ２二銀
      '2d2c+', //  7 先手 ２三歩成（歩を取って と金）
      '2b2c', //  8 後手 同銀（と金を取る → 持ち駒は P）
      '2h2c+', //  9 先手 同飛成（銀を取って龍）
      '4a3b', // 10 後手 ３二金
      '7g7f', // 11 先手 ７六歩
      '3b2c', // 12 後手 同金（龍を取る → 持ち駒は +R ではなく R）
    ]);
    expect(getPieceName(state, '2c')).toBe('金');
    expect(state.hand.gote).toEqual({ P: 1, R: 1 });
    expect(state.hand.sente).toEqual({ P: 1, S: 1 });
  });

  it('駒のないマスからの移動は盤面を変えず手番だけ進める', () => {
    const state = createInitialState();
    const next = applyMove(state, '5e4e'); // 5e は空マス
    expect(next.board).toBe(state.board); // 差分コピーすら起きない
    expect(next.hand).toBe(state.hand);
    expect(next.sideToMove).toBe('gote');
  });

  it('パース不能な手は盤面を変えず手番だけ進める', () => {
    const state = createInitialState();
    for (const bad of ['', 'resign', '7g7f++', 'X*5e', '7j7i']) {
      const next = applyMove(state, bad);
      expect(render(next)).toBe(INITIAL_BOARD);
      expect(next.sideToMove).toBe('gote');
    }
  });

  it('元の局面を破壊せず、変化のない行は共有する', () => {
    const state = createInitialState();
    const snapshot = structuredClone(state);
    const next = applyMove(state, '7g7f');

    expect(state).toEqual(snapshot); // 元の局面はそのまま
    expect(next.board[6]).not.toBe(state.board[6]); // 変化した行は差し替え
    expect(next.board[5]).not.toBe(state.board[5]);
    expect(next.board[0]).toBe(state.board[0]); // 変化のない行は共有
    expect(next.board[8]).toBe(state.board[8]);
    expect(next.hand).toBe(state.hand); // 駒を取っていないので持ち駒も共有
  });

  it('移動元 == 移動先の退化した手では移動元が空になる', () => {
    // 移動先 → 移動元 の更新順に依存する挙動。差分コピー化で変わっていないことを固定する。
    expect(getPieceName(applyMove(createInitialState(), '7g7g'), '7g')).toBe('');
  });
});

describe('buildPositions', () => {
  it('初期局面 + 各手後の局面を返す', () => {
    const positions = buildPositions(['7g7f', '3c3d']);
    expect(positions).toHaveLength(3);
    expect(render(positions[0])).toBe(INITIAL_BOARD);
    expect(getPieceName(positions[1], '7f')).toBe('歩');
    expect(getPieceName(positions[2], '3d')).toBe('歩');
  });

  it('手が無ければ初期局面だけを返す', () => {
    expect(buildPositions([])).toHaveLength(1);
  });
});

describe('usiToJapaneseWithPiece', () => {
  const initial = createInitialState();

  it('通常の移動は「移動先 + 駒名 + (移動元)」', () => {
    expect(usiToJapaneseWithPiece(initial, '7g7f')).toBe('７六歩(77)');
  });

  it('成りには「成」を付ける', () => {
    expect(usiToJapaneseWithPiece(initial, '8h2b+')).toBe('２二角成(88)');
  });

  it('駒打ちは「打」', () => {
    expect(usiToJapaneseWithPiece(initial, 'B*5e')).toBe('５五角打');
  });

  it('解釈できない手はそのまま返す', () => {
    expect(usiToJapaneseWithPiece(initial, 'resign')).toBe('resign');
  });
});

/**
 * 実棋譜 1 局分（ムラ vs daiius・70 手で後手の勝ち）。
 * `packages/server/src/kif/parser.test.ts` が持つ同じ棋譜の KIF を USI に変換したもの。
 * KIF パーサーへの依存を web のテストに持ち込まないよう、手列はリテラルで持つ。
 */
const GAME_MOVES = [
  '2g2f', //  1 ２六歩(27)
  '3c3d', //  2 ３四歩(33)
  '7g7f', //  3 ７六歩(77)
  '4a3b', //  4 ３二金(41)
  '3i4h', //  5 ４八銀(39)
  '2b8h+', //  6 ８八角成(22)
  '7i8h', //  7 同　銀(79)
  '3a2b', //  8 ２二銀(31)
  '8h7g', //  9 ７七銀(88)
  '2b3c', // 10 ３三銀(22)
  '6i7h', // 11 ７八金(69)
  '7a6b', // 12 ６二銀(71)
  '4g4f', // 13 ４六歩(47)
  '6c6d', // 14 ６四歩(63)
  '4h4g', // 15 ４七銀(48)
  '6b6c', // 16 ６三銀(62)
  '2f2e', // 17 ２五歩(26)
  '7c7d', // 18 ７四歩(73)
  '5i6h', // 19 ６八玉(59)
  '9c9d', // 20 ９四歩(93)
  '9g9f', // 21 ９六歩(97)
  '8c8d', // 22 ８四歩(83)
  '1g1f', // 23 １六歩(17)
  '1c1d', // 24 １四歩(13)
  '3g3f', // 25 ３六歩(37)
  '8a7c', // 26 ７三桂(81)
  '2i3g', // 27 ３七桂(29)
  '5a4b', // 28 ４二玉(51)
  '2h2i', // 29 ２九飛(28)
  '6a5b', // 30 ５二金(61)
  '4i4h', // 31 ４八金(49)
  '6c5d', // 32 ５四銀(63)
  '6h7i', // 33 ７九玉(68)
  '4c4d', // 34 ４四歩(43)
  '7i8h', // 35 ８八玉(79)
  '6d6e', // 36 ６五歩(64)
  '4g5f', // 37 ５六銀(47)
  'B*6d', // 38 ６四角打
  'B*2h', // 39 ２八角打
  '8b6b', // 40 ６二飛(82)
  '2i6i', // 41 ６九飛(29)
  '7c8e', // 42 ８五桂(73)
  '7g6h', // 43 ６八銀(77)
  '5d5e', // 44 ５五銀(54)
  '5f6e', // 45 ６五銀(56)
  '6d8b', // 46 ８二角(64)
  '6e7d', // 47 ７四銀(65)
  '5e4f', // 48 ４六銀(55)
  '7d8c+', // 49 ８三銀成(74)
  '8b5e', // 50 ５五角(82)
  '8h9h', // 51 ９八玉(88)
  '9d9e', // 52 ９五歩(94)
  '5g5f', // 53 ５六歩(57)
  '5e6d', // 54 ６四角(55)
  '9h8h', // 55 ８八玉(98)
  '9e9f', // 56 ９六歩(95)
  '8c8d', // 57 ８四全(83)（成銀の移動）
  '9f9g+', // 58 ９七歩成(96)
  '8i9g', // 59 同　桂(89)
  '9a9g+', // 60 同　香成(91)
  '9i9g', // 61 同　香(99)
  '6d9g+', // 62 同　角成(64)
  '8h8i', // 63 ８九玉(88)
  'N*7g', // 64 ７七桂打
  '7h7g', // 65 同　金(78)
  '8e7g+', // 66 同　桂成(85)
  '6h7g', // 67 同　銀(68)
  '9g8g', // 68 ８七馬(97)
  '6i7i', // 69 ７九飛(69)
  'G*9h', // 70 ９八金打（詰み）
];

/** 70 手目までを適用した最終局面（後手の 9h 金 + 8g 馬で 8i の先手玉が詰み） */
const FINAL_BOARD = [
  ' ・ ・ ・ ・ ・ ・ ・v Nv L',
  ' ・ ・ ・v Rv Gv Kv G ・ ・',
  ' ・ ・ ・ ・v P ・v Sv P ・',
  ' ・^+S ・ ・ ・v Pv P ・v P',
  ' ・ ・ ・ ・ ・ ・ ・^ P ・',
  ' ・ ・^ P ・^ Pv S^ P ・^ P',
  ' ・v+B^ S^ P ・ ・^ N ・ ・',
  'v G ・ ・ ・ ・^ G ・^ B ・',
  ' ・^ K^ R ・ ・ ・ ・ ・^ L',
].join('\n');

describe('実棋譜 1 局の通し回帰（ムラ vs daiius・70手）', () => {
  it('最終局面と持ち駒が一致する', () => {
    const positions = buildPositions(GAME_MOVES);
    expect(positions).toHaveLength(GAME_MOVES.length + 1);

    const final = positions[GAME_MOVES.length];
    expect(render(final)).toBe(FINAL_BOARD);
    expect(final.hand.sente).toEqual({ P: 4, L: 1, N: 2 });
    expect(final.hand.gote).toEqual({ P: 3, L: 1 });
    expect(final.sideToMove).toBe('sente');
  });

  it('どの局面でも駒数が保存される', () => {
    // 盤上 + 両者の持ち駒を生駒に戻して数えると、常に初期の駒数と一致する
    const initialCount: Record<string, number> = {
      K: 2, R: 2, B: 2, G: 4, S: 4, N: 4, L: 4, P: 18,
    };
    for (const state of buildPositions(GAME_MOVES)) {
      const count: Record<string, number> = {};
      const add = (kind: string, n: number) => {
        const base = kind.startsWith('+') ? kind.slice(1) : kind;
        count[base] = (count[base] ?? 0) + n;
      };
      for (const row of state.board) {
        for (const sq of row) if (sq) add(sq.kind, 1);
      }
      for (const side of ['sente', 'gote'] as const) {
        for (const [kind, n] of Object.entries(state.hand[side])) add(kind, n);
      }
      expect(count).toEqual(initialCount);
    }
  });

  it('先行する局面は後続の手で変化しない（構造共有の安全性）', () => {
    // 全手を通して得た i 手目の局面が、i 手だけ進めた局面と一致すること。
    // どこかに破壊的更新が混ざると、先に作った局面が後から書き換わって崩れる。
    const positions = buildPositions(GAME_MOVES);
    for (let i = 0; i <= GAME_MOVES.length; i++) {
      expect(positions[i]).toEqual(buildPositions(GAME_MOVES.slice(0, i))[i]);
    }
  });
});
