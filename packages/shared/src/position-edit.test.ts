import { describe, expect, it } from 'vitest';
import { createInitialState, type BoardState, type Piece } from './board';
import {
  addToHand,
  canPromote,
  createEmptyState,
  dropFromHand,
  flipPieceSide,
  handCount,
  movePiece,
  moveToHand,
  pieceAt,
  pieceBox,
  placePiece,
  removePiece,
  setHandCount,
  setPromoted,
  setSideToMove,
  toggleSideToMove,
  unpromoted,
  type SquareRef,
} from './position-edit';

/** USI のマス表記（"7g"）を添字に直す。テストを盤の言葉で書くための道具 */
function sq(usi: string): SquareRef {
  return { row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) };
}

/** 元の state が変わっていないことを確かめるための深いスナップショット */
function snapshot(state: BoardState): string {
  return JSON.stringify(state);
}

/**
 * 操作の前後で**元の state が変わらない**ことを確かめる（`BoardState` の不変契約）。
 * 構造共有しているので、返り値をいじって元が変わる事故はここで落ちる。
 */
function expectImmutable(
  state: BoardState,
  operate: (state: BoardState) => BoardState,
): BoardState {
  const before = snapshot(state);
  const next = operate(state);
  expect(snapshot(state)).toBe(before);
  return next;
}

const P77: SquareRef = sq('7g');
const P76: SquareRef = sq('7f');

describe('pieceAt / handCount', () => {
  it('盤上の駒を読む', () => {
    expect(pieceAt(createInitialState(), P77)).toEqual({
      kind: 'P',
      side: 'sente',
    });
  });

  it('空きマスと盤外は null', () => {
    const state = createInitialState();
    expect(pieceAt(state, P76)).toBeNull();
    expect(pieceAt(state, { row: -1, col: 0 })).toBeNull();
    expect(pieceAt(state, { row: 0, col: 9 })).toBeNull();
  });

  it('持っていない駒種は 0 枚', () => {
    expect(handCount(createInitialState(), 'sente', 'P')).toBe(0);
  });
});

describe('unpromoted / canPromote', () => {
  it('成駒は生駒に戻る', () => {
    expect(unpromoted('+P')).toBe('P');
    expect(unpromoted('+R')).toBe('R');
  });

  it('生駒はそのまま', () => {
    expect(unpromoted('G')).toBe('G');
    expect(unpromoted('K')).toBe('K');
  });

  it('金と玉は成れない', () => {
    expect(canPromote('P')).toBe(true);
    expect(canPromote('G')).toBe(false);
    expect(canPromote('K')).toBe(false);
    expect(canPromote('+P')).toBe(false);
  });
});

describe('movePiece', () => {
  it('空きマスへ動かす（合法性は問わない）', () => {
    const state = createInitialState();
    // 歩を 3 マス先へ飛ばす。合法手ではないが編集としては通る
    const next = expectImmutable(state, (s) => movePiece(s, P77, sq('7d')));
    expect(pieceAt(next, P77)).toBeNull();
    expect(pieceAt(next, sq('7d'))).toEqual({ kind: 'P', side: 'sente' });
  });

  it('相手の駒に重ねると動かした側の持ち駒に入る', () => {
    const state = createInitialState();
    const next = expectImmutable(state, (s) =>
      movePiece(s, sq('8h'), sq('2b')),
    );
    expect(pieceAt(next, sq('2b'))).toEqual({ kind: 'B', side: 'sente' });
    expect(handCount(next, 'sente', 'B')).toBe(1);
    expect(handCount(next, 'gote', 'B')).toBe(0);
  });

  it('成駒を取ったら生駒として持ち駒に入る', () => {
    const base = placePiece(createInitialState(), sq('5e'), {
      kind: '+R',
      side: 'gote',
    });
    const next = movePiece(base, sq('7g'), sq('5e'));
    expect(handCount(next, 'sente', 'R')).toBe(1);
    expect(pieceAt(next, sq('5e'))).toEqual({ kind: 'P', side: 'sente' });
  });

  it('自分の駒に重ねても同じ扱い（どけた駒は自分の持ち駒へ）', () => {
    const state = createInitialState();
    const next = movePiece(state, sq('7i'), sq('7g'));
    expect(pieceAt(next, sq('7g'))).toEqual({ kind: 'S', side: 'sente' });
    expect(handCount(next, 'sente', 'P')).toBe(1);
  });

  it('玉に重ねたら持ち駒にはならず駒箱へ消える', () => {
    const state = createInitialState();
    const next = movePiece(state, sq('5g'), sq('5a'));
    expect(pieceAt(next, sq('5a'))).toEqual({ kind: 'P', side: 'sente' });
    expect(next.hand.sente).toEqual({});
    expect(pieceBox(next).K).toBe(1);
  });

  it('promote: true で成る', () => {
    const next = movePiece(createInitialState(), P77, sq('7c'), {
      promote: true,
    });
    expect(pieceAt(next, sq('7c'))).toEqual({ kind: '+P', side: 'sente' });
  });

  it('promote: false で成りを解く', () => {
    const base = placePiece(createEmptyState(), sq('5e'), {
      kind: '+B',
      side: 'sente',
    });
    const next = movePiece(base, sq('5e'), sq('5f'), { promote: false });
    expect(pieceAt(next, sq('5f'))).toEqual({ kind: 'B', side: 'sente' });
  });

  it('成れない駒種に promote: true を渡しても成らない', () => {
    const next = movePiece(createInitialState(), sq('6i'), sq('6h'), {
      promote: true,
    });
    expect(pieceAt(next, sq('6h'))).toEqual({ kind: 'G', side: 'sente' });
  });

  it('移動元が空・盤外・移動元 == 移動先なら state をそのまま返す', () => {
    const state = createInitialState();
    expect(movePiece(state, P76, P77)).toBe(state);
    expect(movePiece(state, P77, { row: 9, col: 0 })).toBe(state);
    expect(movePiece(state, P77, P77)).toBe(state);
  });

  it('動かしていない行は元の配列を共有する（構造共有）', () => {
    const state = createInitialState();
    const next = movePiece(state, P77, P76);
    expect(next.board[0]).toBe(state.board[0]);
    expect(next.board[6]).not.toBe(state.board[6]);
  });
});

describe('removePiece', () => {
  it('盤から取り除く（持ち駒は増えない）', () => {
    const state = createInitialState();
    const next = expectImmutable(state, (s) => removePiece(s, P77));
    expect(pieceAt(next, P77)).toBeNull();
    expect(next.hand.sente).toEqual({});
    expect(pieceBox(next).P).toBe(1);
  });

  it('空きマス・盤外は state をそのまま返す', () => {
    const state = createInitialState();
    expect(removePiece(state, P76)).toBe(state);
    expect(removePiece(state, { row: -1, col: 0 })).toBe(state);
  });
});

describe('moveToHand', () => {
  it('盤の駒を持ち主の持ち駒へ移す', () => {
    const state = createInitialState();
    const next = expectImmutable(state, (s) => moveToHand(s, P77));
    expect(pieceAt(next, P77)).toBeNull();
    expect(handCount(next, 'sente', 'P')).toBe(1);
  });

  it('side を渡すとその側の持ち駒に入る', () => {
    const next = moveToHand(createInitialState(), P77, 'gote');
    expect(handCount(next, 'gote', 'P')).toBe(1);
    expect(handCount(next, 'sente', 'P')).toBe(0);
  });

  it('成駒は生駒に戻して持ち駒に入る', () => {
    const base = placePiece(createEmptyState(), sq('5e'), {
      kind: '+S',
      side: 'gote',
    });
    const next = moveToHand(base, sq('5e'));
    expect(handCount(next, 'gote', 'S')).toBe(1);
  });

  it('玉は持ち駒にできないので取り除くだけ', () => {
    const state = createInitialState();
    const next = moveToHand(state, sq('5i'));
    expect(pieceAt(next, sq('5i'))).toBeNull();
    expect(next.hand.sente).toEqual({});
  });

  it('空きマスは state をそのまま返す', () => {
    const state = createInitialState();
    expect(moveToHand(state, P76)).toBe(state);
  });
});

describe('placePiece', () => {
  it('駒箱から盤へ置く（持ち駒には触らない）', () => {
    const state = createEmptyState();
    const piece: Piece = { kind: 'R', side: 'sente' };
    const next = expectImmutable(state, (s) => placePiece(s, sq('5e'), piece));
    expect(pieceAt(next, sq('5e'))).toEqual(piece);
    expect(next.hand).toEqual({ sente: {}, gote: {} });
    expect(pieceBox(next).R).toBe(1);
  });

  it('置き先の駒は駒箱へ戻る（持ち駒にはしない）', () => {
    const state = createInitialState();
    const next = placePiece(state, P77, { kind: 'N', side: 'gote' });
    expect(next.hand).toEqual({ sente: {}, gote: {} });
    expect(pieceBox(next).P).toBe(1);
  });

  it('盤外は state をそのまま返す', () => {
    const state = createEmptyState();
    expect(placePiece(state, { row: 9, col: 9 }, { kind: 'P', side: 'sente' }))
      .toBe(state);
  });
});

describe('dropFromHand', () => {
  it('持ち駒を 1 枚減らして盤へ置く', () => {
    const state = addToHand(createEmptyState(), 'gote', 'S', 2);
    const next = expectImmutable(state, (s) =>
      dropFromHand(s, 'gote', 'S', sq('5e')),
    );
    expect(pieceAt(next, sq('5e'))).toEqual({ kind: 'S', side: 'gote' });
    expect(handCount(next, 'gote', 'S')).toBe(1);
  });

  it('持っていない駒種は state をそのまま返す（駒を増やさない）', () => {
    const state = createEmptyState();
    expect(dropFromHand(state, 'sente', 'R', sq('5e'))).toBe(state);
  });

  it('盤外は state をそのまま返す（持ち駒も減らさない）', () => {
    const state = addToHand(createEmptyState(), 'sente', 'P', 1);
    expect(dropFromHand(state, 'sente', 'P', { row: 9, col: 0 })).toBe(state);
  });
});

describe('setHandCount / addToHand', () => {
  it('枚数を指定する', () => {
    const state = createEmptyState();
    const next = expectImmutable(state, (s) => setHandCount(s, 'sente', 'P', 3));
    expect(handCount(next, 'sente', 'P')).toBe(3);
  });

  it('0 以下はキーごと落とす（SFEN の書き出しを一意に保つ）', () => {
    const state = addToHand(createEmptyState(), 'sente', 'P', 1);
    const next = setHandCount(state, 'sente', 'P', -5);
    expect(next.hand.sente).toEqual({});
  });

  it('減らしても 0 枚未満にはならない', () => {
    const state = addToHand(createEmptyState(), 'gote', 'G', 1);
    const next = addToHand(state, 'gote', 'G', -3);
    expect(handCount(next, 'gote', 'G')).toBe(0);
  });

  it('枚数が変わらないなら state をそのまま返す', () => {
    const state = createEmptyState();
    expect(addToHand(state, 'sente', 'P', 0)).toBe(state);
    expect(setHandCount(state, 'sente', 'P', 0)).toBe(state);
  });

  it('相手の持ち駒には触らない（構造共有）', () => {
    const state = createInitialState();
    const next = addToHand(state, 'sente', 'P', 1);
    expect(next.hand.gote).toBe(state.hand.gote);
    expect(next.board).toBe(state.board);
  });
});

describe('setPromoted', () => {
  it('成る / 成りを解く', () => {
    const state = createInitialState();
    const promoted = expectImmutable(state, (s) => setPromoted(s, P77, true));
    expect(pieceAt(promoted, P77)).toEqual({ kind: '+P', side: 'sente' });
    expect(pieceAt(setPromoted(promoted, P77, false), P77)).toEqual({
      kind: 'P',
      side: 'sente',
    });
  });

  it('成れない駒種・空きマスは state をそのまま返す', () => {
    const state = createInitialState();
    expect(setPromoted(state, sq('6i'), true)).toBe(state);
    expect(setPromoted(state, sq('5i'), true)).toBe(state);
    expect(setPromoted(state, P76, true)).toBe(state);
  });

  it('既に成っている駒に true を渡しても state はそのまま', () => {
    const state = setPromoted(createInitialState(), P77, true);
    expect(setPromoted(state, P77, true)).toBe(state);
  });
});

describe('flipPieceSide', () => {
  it('駒の側を入れ替える（成り状態は保つ）', () => {
    const state = setPromoted(createInitialState(), P77, true);
    const next = expectImmutable(state, (s) => flipPieceSide(s, P77));
    expect(pieceAt(next, P77)).toEqual({ kind: '+P', side: 'gote' });
  });

  it('空きマスは state をそのまま返す', () => {
    const state = createInitialState();
    expect(flipPieceSide(state, P76)).toBe(state);
  });
});

describe('setSideToMove / toggleSideToMove', () => {
  it('手番を切り替える', () => {
    const state = createInitialState();
    const next = expectImmutable(state, (s) => toggleSideToMove(s));
    expect(next.sideToMove).toBe('gote');
    expect(toggleSideToMove(next).sideToMove).toBe('sente');
    // 盤と持ち駒はそのまま共有する
    expect(next.board).toBe(state.board);
    expect(next.hand).toBe(state.hand);
  });

  it('同じ手番を指定したら state をそのまま返す', () => {
    const state = createInitialState();
    expect(setSideToMove(state, 'sente')).toBe(state);
    expect(setSideToMove(state, 'gote').sideToMove).toBe('gote');
  });
});

describe('pieceBox', () => {
  it('初期局面では駒箱が空', () => {
    expect(pieceBox(createInitialState())).toEqual({
      P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0, K: 0,
    });
  });

  it('空の盤では全部が駒箱にある', () => {
    expect(pieceBox(createEmptyState())).toEqual({
      P: 18, L: 4, N: 4, S: 4, G: 4, B: 2, R: 2, K: 2,
    });
  });

  it('持ち駒は駒箱から引かれる', () => {
    const state = addToHand(createEmptyState(), 'gote', 'P', 5);
    expect(pieceBox(state).P).toBe(13);
  });

  it('成駒は生駒として数える', () => {
    const state = placePiece(createEmptyState(), sq('5e'), {
      kind: '+P',
      side: 'sente',
    });
    expect(pieceBox(state).P).toBe(17);
  });

  it('駒が多すぎても 0 で止まる（超過は局面検証の担当）', () => {
    let state = createEmptyState();
    for (let i = 0; i < 3; i++) {
      state = addToHand(state, 'sente', 'R', 1);
      state = addToHand(state, 'gote', 'R', 0);
    }
    expect(handCount(state, 'sente', 'R')).toBe(3);
    expect(pieceBox(state).R).toBe(0);
  });
});

describe('編集の組み合わせ（M2b が組む形）', () => {
  it('駒を持ち駒へ移して打ち直しても駒の総数は変わらない', () => {
    const state = createInitialState();
    const next = dropFromHand(
      moveToHand(state, sq('8h')),
      'sente',
      'B',
      sq('5e'),
    );
    expect(pieceAt(next, sq('8h'))).toBeNull();
    expect(pieceAt(next, sq('5e'))).toEqual({ kind: 'B', side: 'sente' });
    expect(handCount(next, 'sente', 'B')).toBe(0);
    expect(pieceBox(next)).toEqual(pieceBox(state));
  });

  it('一連の編集を通しても元の state は 1 バイトも変わらない', () => {
    const state = createInitialState();
    const before = snapshot(state);
    const edited = toggleSideToMove(
      setPromoted(
        dropFromHand(
          moveToHand(movePiece(state, P77, P76), sq('2b'), 'sente'),
          'sente',
          'B',
          sq('5e'),
        ),
        sq('5e'),
        true,
      ),
    );
    expect(snapshot(state)).toBe(before);
    expect(pieceAt(edited, sq('5e'))).toEqual({ kind: '+B', side: 'sente' });
    expect(edited.sideToMove).toBe('gote');
  });
});
