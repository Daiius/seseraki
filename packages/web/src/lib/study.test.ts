import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  pieceAt,
  positionSfen,
  handCount,
  pieceBox,
} from 'shared';
import {
  applyStudyMoves,
  baseState,
  canTogglePromotion,
  createStudySession,
  currentState,
  isStudying,
  lastMove,
  namedEvalTarget,
  positionEvalTarget,
  resetStudy,
  squareOfUsi,
  tapBox,
  tapHand,
  tapSquare,
  togglePromotion,
  toggleTurn,
  undo,
  usiDropOf,
  usiMoveOf,
  usiSquare,
} from './study';

/**
 * 検討盤のセッション（prd/12 §3）。
 *
 * 🔒 **ここを固定しておけば UI を組み替えても操作の意味が壊れない。**
 * コンポーネント（`.tsx`）は web の vitest の対象外なので、判断はすべてこの層にある。
 */

const initial = createInitialState();
const sq = squareOfUsi;

describe('USI 座標', () => {
  it('盤の添字と USI を往復できる', () => {
    expect(usiSquare({ row: 6, col: 2 })).toBe('7g');
    expect(sq('7g')).toEqual({ row: 6, col: 2 });
    expect(sq('1a')).toEqual({ row: 0, col: 8 });
    expect(usiSquare({ row: 0, col: 8 })).toBe('1a');
  });

  it('指し手・駒打ちの文字列を組み立てる', () => {
    expect(usiMoveOf(sq('7g'), sq('7f'))).toBe('7g7f');
    expect(usiMoveOf(sq('8h'), sq('2b'), true)).toBe('8h2b+');
    expect(usiDropOf('P', sq('5e'))).toBe('P*5e');
  });
});

describe('タップ 2 段', () => {
  it('空きマスを叩いても何も起きない（選択もしない）', () => {
    const s = tapSquare(createStudySession(initial), sq('5e'));
    expect(s.selection).toBeNull();
    expect(isStudying(s)).toBe(false);
  });

  it('駒のあるマスを叩くと選択、同じマスをもう一度叩くと解除', () => {
    const picked = tapSquare(createStudySession(initial), sq('7g'));
    expect(picked.selection).toEqual({ kind: 'square', square: sq('7g') });
    // 🔒 選び直せることが、盤マスが 44px 基準を下回る例外を支えている（prd/12 §3.3）
    expect(tapSquare(picked, sq('7g')).selection).toBeNull();
  });

  it('選択 → 行き先で駒が動き、そこから検討が始まる', () => {
    const s = applyStudyMoves(initial, ['7g7f']);
    expect(isStudying(s)).toBe(true);
    expect(lastMove(s)).toBe('7g7f');
    expect(pieceAt(currentState(s), sq('7g'))).toBeNull();
    expect(pieceAt(currentState(s), sq('7f'))).toEqual({ kind: 'P', side: 'sente' });
  });

  it('選び直せる（別の自分の駒を叩くと選択が移る）', () => {
    let s = tapSquare(createStudySession(initial), sq('7g'));
    s = tapSquare(s, sq('2g'));
    // 2g にも駒があるので「移動」になる。ここは仕様どおり——駒のあるマスへの
    // 移動は「重ねる」操作で、選び直しではない
    expect(isStudying(s)).toBe(true);
    expect(lastMove(s)).toBe('7g2g');
  });

  it('起点の局面は書き換わらない（undo スタックが壊れない）', () => {
    const before = positionSfen(initial);
    const s = applyStudyMoves(initial, ['7g7f', '3c3d']);
    expect(positionSfen(baseState(s))).toBe(before);
    expect(positionSfen(initial)).toBe(before);
  });
});

describe('手番の扱い', () => {
  it('手番側の駒を動かしたら手番が進む（指し手だから）', () => {
    const s = applyStudyMoves(initial, ['7g7f']);
    expect(currentState(s).sideToMove).toBe('gote');
  });

  it('相手側の駒を動かしたときは進めない（編集だから）', () => {
    // 初手から後手の駒（3c の歩）を動かす＝編集
    const s = applyStudyMoves(initial, ['3c3d']);
    expect(currentState(s).sideToMove).toBe('sente');
  });

  it('手番トグルで入れ替えられる（prd/12 §2.3）', () => {
    const s = toggleTurn(createStudySession(initial));
    expect(currentState(s).sideToMove).toBe('gote');
    expect(isStudying(s)).toBe(true);
  });
});

describe('駒を取る / 成る', () => {
  it('相手の駒に重ねたら動かした側の持ち駒になる', () => {
    const s = applyStudyMoves(initial, ['8h2b']);
    expect(handCount(currentState(s), 'sente', 'B')).toBe(1);
    expect(pieceAt(currentState(s), sq('2b'))).toEqual({ kind: 'B', side: 'sente' });
  });

  it('直前の手を成 / 不成で指し直せる（段は増えない）', () => {
    const plain = applyStudyMoves(initial, ['8h2b']);
    expect(canTogglePromotion(plain)).toBe(true);
    const promoted = togglePromotion(plain);
    expect(lastMove(promoted)).toBe('8h2b+');
    expect(pieceAt(currentState(promoted), sq('2b'))).toEqual({
      kind: '+B',
      side: 'sente',
    });
    expect(promoted.steps.length).toBe(plain.steps.length);
    // もう一度押せば不成へ戻る
    expect(lastMove(togglePromotion(promoted))).toBe('8h2b');
  });

  it('成れない駒（金）の手は切り替えられない', () => {
    const s = applyStudyMoves(initial, ['6i5h']);
    expect(canTogglePromotion(s)).toBe(false);
    expect(togglePromotion(s)).toBe(s);
  });

  it('編集で進んだ段は切り替えの対象にならない', () => {
    const s = toggleTurn(createStudySession(initial));
    expect(canTogglePromotion(s)).toBe(false);
  });
});

describe('持ち駒と駒箱', () => {
  it('盤の駒を選んで持ち駒を叩くと、その側の持ち駒になる', () => {
    let s = tapSquare(createStudySession(initial), sq('7g'));
    s = tapHand(s, 'gote');
    expect(handCount(currentState(s), 'gote', 'P')).toBe(1);
    expect(pieceAt(currentState(s), sq('7g'))).toBeNull();
    expect(lastMove(s)).toBeNull();
  });

  it('盤の駒を選んで駒箱を叩くと盤から消える（持ち駒には行かない）', () => {
    let s = tapSquare(createStudySession(initial), sq('7g'));
    s = tapBox(s, 'sente', 'P');
    expect(pieceAt(currentState(s), sq('7g'))).toBeNull();
    expect(handCount(currentState(s), 'sente', 'P')).toBe(0);
    expect(pieceBox(currentState(s)).P).toBe(1);
  });

  it('駒箱を選んで盤を叩くと置ける（手番は動かない＝編集）', () => {
    let s = tapSquare(createStudySession(initial), sq('7g'));
    s = tapBox(s, 'sente', 'P'); // 7g の歩を箱へ
    s = tapBox(s, 'gote', 'P'); // 箱の歩（後手）を選ぶ
    s = tapSquare(s, sq('5e'));
    expect(pieceAt(currentState(s), sq('5e'))).toEqual({ kind: 'P', side: 'gote' });
    expect(currentState(s).sideToMove).toBe('sente');
  });

  it('持ち駒を選んで盤を叩くと打てる（USI は駒打ちの形）', () => {
    let s = tapSquare(createStudySession(initial), sq('7g'));
    s = tapHand(s, 'sente'); // 先手の持ち駒へ
    s = tapHand(s, 'sente', 'P'); // その歩を選ぶ
    s = tapSquare(s, sq('5e'));
    expect(lastMove(s)).toBe('P*5e');
    expect(pieceAt(currentState(s), sq('5e'))).toEqual({ kind: 'P', side: 'sente' });
    expect(handCount(currentState(s), 'sente', 'P')).toBe(0);
  });

  it('駒箱を選んで持ち駒を叩くと 1 枚増える', () => {
    let s = tapSquare(createStudySession(initial), sq('7g'));
    s = tapBox(s, 'sente', 'P'); // 箱へ戻す
    s = tapBox(s, 'sente', 'P'); // 箱の歩を選ぶ
    s = tapHand(s, 'sente', 'P');
    expect(handCount(currentState(s), 'sente', 'P')).toBe(1);
  });

  it('持ち駒を選んで駒箱を叩くと 1 枚減る', () => {
    let s = applyStudyMoves(initial, ['8h2b']); // 角を取って持ち駒に
    s = tapHand(s, 'sente', 'B');
    s = tapBox(s, 'sente', 'B');
    expect(handCount(currentState(s), 'sente', 'B')).toBe(0);
  });

  it('持っていない駒は選べない', () => {
    const s = tapHand(createStudySession(initial), 'sente', 'R');
    expect(s.selection).toBeNull();
  });
});

describe('undo と破棄', () => {
  it('1 段ずつ戻り、起点より手前へは行かない', () => {
    const s = applyStudyMoves(initial, ['7g7f', '3c3d']);
    expect(s.steps.length).toBe(3);
    const back = undo(undo(undo(s)));
    expect(back.steps.length).toBe(1);
    expect(isStudying(back)).toBe(false);
    expect(positionSfen(currentState(back))).toBe(positionSfen(initial));
  });

  it('「棋譜に戻る」で起点まで一息に戻る', () => {
    const s = resetStudy(applyStudyMoves(initial, ['7g7f', '3c3d', '2g2f']));
    expect(isStudying(s)).toBe(false);
    expect(currentState(s)).toBe(initial);
  });
});

describe('評価の送り先', () => {
  it('局面評価は現在の検討局面をそのまま送る', () => {
    const s = applyStudyMoves(initial, ['7g7f']);
    expect(positionEvalTarget(s)).toEqual({
      sfen: positionSfen(currentState(s)),
      move: null,
    });
  });

  it('名指し評価は「その手を指す前」の局面と手を送る', () => {
    const s = applyStudyMoves(initial, ['7g7f']);
    // 🔴 手を適用した後の局面を送ると別の手を読むことになる
    expect(namedEvalTarget(s)).toEqual({ sfen: positionSfen(initial), move: '7g7f' });
  });

  it('検討していない / 直前が編集なら名指しできない', () => {
    expect(namedEvalTarget(createStudySession(initial))).toBeNull();
    expect(namedEvalTarget(toggleTurn(createStudySession(initial)))).toBeNull();
  });
});
