import { describe, expect, it } from 'vitest';
import {
  applyMove,
  buildPositions,
  createInitialState,
  getPieceName,
  relocate,
  usiToJapaneseWithPiece,
  type BoardState,
} from './board';
import { parseSfen } from './sfen';
import { RANDOM_GAME_B } from './test-fixtures/games';
import { usiToIndex } from './usi-move';

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
    // `structuredClone` は使わない。型が lib.dom / @types/node にしか無く、
    // shared の tsconfig を環境非依存（lib: esnext / types: []）に保てなくなるため。
    // BoardState は駒と数値だけなので JSON 経由の複製で等価になる
    const snapshot = JSON.parse(JSON.stringify(state));
    const next = applyMove(state, '7g7f');

    expect(state).toEqual(snapshot); // 元の局面はそのまま
    expect(next.board[6]).not.toBe(state.board[6]); // 変化した行は差し替え
    expect(next.board[5]).not.toBe(state.board[5]);
    expect(next.board[0]).toBe(state.board[0]); // 変化のない行は共有
    expect(next.board[8]).toBe(state.board[8]);
    expect(next.hand).toBe(state.hand); // 駒を取っていないので持ち駒も共有
  });

  it('移動元 == 移動先の退化した手は盤面を変えず手番だけ進める（盤面編集の movePiece と同じ）', () => {
    // 以前は移動先 → 移動元の更新順で駒が消えていた。中核（relocate）に寄せて揃えた
    const state = createInitialState();
    const next = applyMove(state, '7g7g');
    expect(next.board).toBe(state.board);
    expect(next.sideToMove).toBe('gote');
  });

  it('玉を取っても持ち駒に玉を入れない（盤から消えるだけ）', () => {
    const state = parseSfen('4k4/4R4/9/9/9/9/9/9/4K4 b - 1')!;
    const next = applyMove(state, '5b5a');
    expect(getPieceName(next, '5a')).toBe('飛');
    expect(next.hand.sente).toEqual({});
  });

  it('盤外の座標（0 筋）は書式違いとして読み飛ばす', () => {
    const state = parseSfen('4k4/9/9/9/9/9/9/9/4K4 b P 1')!;
    for (const bad of ['P*0e', '0i1i', '5i0i']) {
      const next = applyMove(state, bad);
      expect(next.board, bad).toBe(state.board);
      expect(next.hand, bad).toBe(state.hand);
      expect(next.sideToMove, bad).toBe('gote');
    }
  });

  it('手番でない側の駒は動かさない（色を変えて動かしていた旧挙動を直す）', () => {
    const state = createInitialState();
    const next = applyMove(state, '3c3d'); // 先手番に後手の歩
    expect(next.board).toBe(state.board);
    expect(next.sideToMove).toBe('gote');
  });

  it('自分の駒は取れない（盤面を変えず手番だけ進める）', () => {
    const state = createInitialState();
    const next = applyMove(state, '7i7g'); // 7g には先手の歩
    expect(next.board).toBe(state.board);
    expect(next.hand).toBe(state.hand);
  });

  it('駒のあるマスへは打てない', () => {
    const state = parseSfen('4k4/9/9/9/9/9/9/9/4K4 b P 1')!;
    const next = applyMove(state, 'P*5a');
    expect(next.board).toBe(state.board);
    expect(next.hand).toBe(state.hand);
  });

  it('持っていない駒は打てない（盤面を変えず手番だけ進める）', () => {
    const state = createInitialState();
    const next = applyMove(state, 'P*5e');
    expect(next.board).toBe(state.board);
    expect(next.hand).toBe(state.hand);
    expect(next.sideToMove).toBe('gote');
  });
});

describe('relocate（applyMove と盤面編集の中核）', () => {
  const at = (usi: string) => {
    const [row, col] = usiToIndex(usi);
    return { row, col };
  };

  it('取った駒は動かした側の持ち駒へ（成駒は生駒に戻す）', () => {
    const state = parseSfen('4k4/9/4+r4/9/4B4/9/9/9/4K4 b - 1')!;
    const next = relocate(state, { square: at('5e') }, at('5c'))!;
    expect(next.hand.sente).toEqual({ R: 1 });
    expect(next.sideToMove).toBe('sente'); // 手番は触らない
  });

  it('自分の駒の上に動かすと、どけた駒は動かした側の持ち駒へ', () => {
    const state = createInitialState();
    const next = relocate(state, { square: at('7i') }, at('7g'))!;
    expect(getPieceName(next, '7g')).toBe('銀');
    expect(next.hand.sente).toEqual({ P: 1 });
  });

  it('打ちは持ち駒を 1 枚減らす。0 枚になればキーを落とす', () => {
    const state = parseSfen('4k4/9/9/9/9/9/9/9/4K4 b 2P 1')!;
    const once = relocate(state, { hand: 'P', side: 'sente' }, at('5e'))!;
    expect(once.hand.sente).toEqual({ P: 1 });
    const twice = relocate(once, { hand: 'P', side: 'sente' }, at('4e'))!;
    expect(twice.hand.sente).toEqual({});
  });

  it('指せないものは null（空マス・同じマス・持っていない駒・盤外）', () => {
    const state = createInitialState();
    expect(relocate(state, { square: at('5e') }, at('5d'))).toBeNull();
    expect(relocate(state, { square: at('7g') }, at('7g'))).toBeNull();
    expect(relocate(state, { hand: 'P', side: 'sente' }, at('5e'))).toBeNull();
    expect(relocate(state, { square: at('7g') }, { row: 9, col: 0 })).toBeNull();
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
 * 1 局分の通し回帰。手列は無作為な合法手の対局（`test-fixtures/games.ts` の `RANDOM_GAME_B`。
 * 85 手で詰み・実在の対局ではない）。KIF パーサーへの依存を持ち込まないよう、手列は USI のまま持つ。
 */
const GAME_MOVES = RANDOM_GAME_B;

/** 85 手目（先手の ６七銀打）までを適用した最終局面 */
const FINAL_BOARD = [
  ' ・v N ・ ・ ・ ・ ・v N ・',
  'v Lv S ・ ・ ・^+P ・ ・v L',
  'v P ・v R ・v G ・ ・v P ・',
  ' ・v Pv G ・ ・ ・ ・ ・v P',
  ' ・ ・v Pv Pv Pv Pv P^ P ・',
  '^ P ・v K ・ ・ ・ ・ ・ ・',
  '^ N^ P ・^ S^ P^ P ・ ・^ P',
  '^ S^ B ・ ・^ G^ K ・^ S^ L',
  '^ L ・ ・^ P^ B ・^ G^ N ・',
].join('\n');

describe('1 局の通し回帰（無作為な合法手の対局・85 手）', () => {
  it('最終局面と持ち駒が一致する', () => {
    const positions = buildPositions(GAME_MOVES);
    expect(positions).toHaveLength(GAME_MOVES.length + 1);

    const final = positions[GAME_MOVES.length];
    expect(render(final)).toBe(FINAL_BOARD);
    expect(final.hand.sente).toEqual({});
    expect(final.hand.gote).toEqual({ P: 1, R: 1 });
    expect(final.sideToMove).toBe('gote');
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
