import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  pieceAt,
  positionSfen,
  handCount,
} from 'shared';
import {
  applyStudyMoves,
  baseState,
  canRedo,
  canTogglePromotion,
  canUndo,
  createStudySession,
  currentState,
  isStudying,
  lastMove,
  namedEvalTarget,
  positionEvalTarget,
  redo,
  redoAll,
  resetStudy,
  squareOfUsi,
  tapHand,
  tapSquare,
  togglePromotion,
  toggleTurn,
  undo,
  undoAll,
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

/**
 * 駒台での受け渡し（prd/12 §3.2・決定 2026-08-28）。
 *
 * 🔴 **駒箱は持たない。** 駒箱は「盤にも持ち駒にもない駒」の置き場だが、実際には
 * 盤から抜いた駒の**退避先でしかない**ので、駒台がその役を兼ねれば要らなくなる。
 * 駒の総数は元から変えられないので、失われる機能もない。
 */
describe('駒台での受け渡し', () => {
  it('盤の駒を選んで駒台の空き部分を叩くと、その側の持ち駒になる', () => {
    let s = tapSquare(createStudySession(initial), sq('7g'));
    s = tapHand(s, 'gote'); // 受け皿（駒種を指さない）
    expect(handCount(currentState(s), 'gote', 'P')).toBe(1);
    expect(pieceAt(currentState(s), sq('7g'))).toBeNull();
    // 編集なので指し手ではない（名指し評価の対象にならない）
    expect(lastMove(s)).toBeNull();
  });

  it('相手の駒台にも入れられる（フル編集）', () => {
    // 後手の歩を先手の駒台へ
    let s = tapSquare(createStudySession(initial), sq('3c'));
    s = tapHand(s, 'sente');
    expect(handCount(currentState(s), 'sente', 'P')).toBe(1);
    expect(handCount(currentState(s), 'gote', 'P')).toBe(0);
  });

  it('成駒は生駒に戻って駒台へ入る', () => {
    // ▲８八角で２二の角を取り、成にしてから駒台へ移す
    let s = togglePromotion(applyStudyMoves(initial, ['8h2b']));
    expect(pieceAt(currentState(s), sq('2b'))).toEqual({ kind: '+B', side: 'sente' });
    s = tapSquare(s, sq('2b'));
    s = tapHand(s, 'sente');
    expect(handCount(currentState(s), 'sente', 'B')).toBe(2);
    expect(pieceAt(currentState(s), sq('2b'))).toBeNull();
  });

  it('⚠ 玉は持ち駒にできないので、駒台へ移すと盤から消えるだけになる', () => {
    let s = tapSquare(createStudySession(initial), sq('5i'));
    s = tapHand(s, 'sente');
    expect(pieceAt(currentState(s), sq('5i'))).toBeNull();
    expect(currentState(s).hand.sente.K).toBeUndefined();
  });

  it('駒を選んでいなければ、空き部分を叩いても何も起きない', () => {
    const s = createStudySession(initial);
    // 選択も始まらないし、段も積まれない
    expect(tapHand(s, 'sente')).toBe(s);
    expect(tapHand(s, 'gote')).toBe(s);
  });

  it('駒台の駒を選んで盤を叩くと打てる（USI は駒打ちの形）', () => {
    let s = tapSquare(createStudySession(initial), sq('7g'));
    s = tapHand(s, 'sente'); // 受け皿へ移す
    s = tapHand(s, 'sente', 'P'); // その歩を選ぶ
    s = tapSquare(s, sq('5e'));
    expect(lastMove(s)).toBe('P*5e');
    expect(pieceAt(currentState(s), sq('5e'))).toEqual({ kind: 'P', side: 'sente' });
    expect(handCount(currentState(s), 'sente', 'P')).toBe(0);
    // 手番側の駒を打ったので手番が進む（盤上の駒を動かしたときと同じ規則）
    expect(currentState(s).sideToMove).toBe('gote');
    // 打った手はそのまま名指し評価にかけられる
    expect(namedEvalTarget(s)?.move).toBe('P*5e');
  });

  it('相手側の持ち駒を打っても手番は進まない（指し手ではなく編集）', () => {
    // 先手が角を取ると手番は後手へ。そこで**先手の**持ち駒を打つのは編集
    let s = applyStudyMoves(initial, ['8h2b']);
    expect(currentState(s).sideToMove).toBe('gote');
    s = tapHand(s, 'sente', 'B');
    s = tapSquare(s, sq('5e'));
    expect(lastMove(s)).toBe('B*5e');
    expect(pieceAt(currentState(s), sq('5e'))).toEqual({ kind: 'B', side: 'sente' });
    expect(currentState(s).sideToMove).toBe('gote');
  });

  it('駒台の駒はもう一度叩けば選択解除、別の駒種を叩けば選び直し', () => {
    let s = applyStudyMoves(initial, ['8h2b']);
    s = tapHand(s, 'sente', 'B');
    expect(s.selection).toEqual({ kind: 'hand', side: 'sente', piece: 'B' });
    expect(tapHand(s, 'sente', 'B').selection).toBeNull();
    // 持っていない駒種へは移らない（選択が外れるだけ）
    expect(tapHand(s, 'sente', 'R').selection).toBeNull();
  });

  it('持っていない駒は選べない', () => {
    const s = tapHand(createStudySession(initial), 'sente', 'R');
    expect(s.selection).toBeNull();
  });
});

/**
 * undo / redo（prd/12 §3.1・決定 2026-08-28）。
 *
 * 🔴 検討中は既存のコントローラー行（◀ ▶ ≪ ≫）が検討の操作になる。**専用ボタンを
 * 増やすより既存の操作子に意味を持たせる**というユーザ判断で、
 * 「検討中に手送りしたら検討を破棄する」は撤回された。
 */
describe('undo と redo', () => {
  it('1 段ずつ戻り、起点より手前へは行かない', () => {
    const s = applyStudyMoves(initial, ['7g7f', '3c3d']);
    expect(s.cursor).toBe(2);
    const back = undo(undo(undo(s)));
    expect(back.cursor).toBe(0);
    expect(positionSfen(currentState(back))).toBe(positionSfen(initial));
  });

  it('🔴 起点まで戻しても検討からは抜けない（◀ が無効になるだけ）', () => {
    // 抜けると同じ ◀ が 1 回のタップで「undo」から「棋譜の手送り」へ意味を変える
    const back = undoAll(applyStudyMoves(initial, ['7g7f', '3c3d']));
    expect(back.cursor).toBe(0);
    expect(isStudying(back)).toBe(true);
    expect(canUndo(back)).toBe(false);
    expect(canRedo(back)).toBe(true);
  });

  it('戻したぶんは redo でやり直せる（手順は捨てない）', () => {
    const s = applyStudyMoves(initial, ['7g7f', '3c3d']);
    const back = undo(undo(s));
    expect(canRedo(back)).toBe(true);
    const again = redo(redo(back));
    expect(again.cursor).toBe(2);
    expect(positionSfen(currentState(again))).toBe(positionSfen(currentState(s)));
    expect(canRedo(again)).toBe(false);
  });

  it('≪ ≫ は起点と最後へ一息に動く', () => {
    const s = applyStudyMoves(initial, ['7g7f', '3c3d', '2g2f']);
    expect(undoAll(s).cursor).toBe(0);
    expect(redoAll(undoAll(s)).cursor).toBe(3);
    // 端で押しても何も起きない（局面は動かない）
    expect(currentState(redoAll(s))).toBe(currentState(s));
    expect(currentState(undoAll(undoAll(s)))).toBe(currentState(undoAll(s)));
  });

  it('🔴 戻した先で新しい手を指すと、その先の redo 分は捨てる（一本道を保つ）', () => {
    const s = applyStudyMoves(initial, ['7g7f', '3c3d']);
    let back = undo(s); // ▲７六歩まで戻す
    expect(canRedo(back)).toBe(true);
    back = tapSquare(back, sq('8c')); // 別の手を指す
    back = tapSquare(back, sq('8d'));
    expect(lastMove(back)).toBe('8c8d');
    expect(back.steps.length).toBe(3);
    expect(back.cursor).toBe(2);
    // △３四歩は消えた（分岐ツリーにはしない。prd/12 §3.2）
    expect(canRedo(back)).toBe(false);
  });

  it('成 / 不成の指し直しも、その先の redo 分を捨てる', () => {
    const s = applyStudyMoves(initial, ['8h2b', '3a2b']);
    const back = togglePromotion(undo(s));
    expect(lastMove(back)).toBe('8h2b+');
    expect(canRedo(back)).toBe(false);
    expect(back.steps.length).toBe(2);
  });

  it('「棋譜に戻る」だけが検討の出口', () => {
    const s = resetStudy(applyStudyMoves(initial, ['7g7f', '3c3d', '2g2f']));
    expect(isStudying(s)).toBe(false);
    expect(currentState(s)).toBe(initial);
  });

  it('戻した位置から評価できる（名指しは戻した先の手が対象）', () => {
    const s = undo(applyStudyMoves(initial, ['7g7f', '3c3d']));
    expect(namedEvalTarget(s)).toEqual({
      sfen: positionSfen(initial),
      move: '7g7f',
      from: initial,
    });
    expect(positionEvalTarget(s).sfen).toBe(positionSfen(currentState(s)));
  });

  /**
   * 🔴 回帰（レビュー指摘 `OCL-753E7A28`）。cursor 方式へ変えたとき、名指し評価の
   * **基点だけが配列末尾基準のまま**取り残されていた。undo して redo 分が残っていると
   * 「送る局面・手」と「検証と PV 再生に使う局面」がずれ、正しい要求を誤って弾いたり、
   * **返ってきた咎め筋を別の盤から再生**したりする。
   */
  it('🔴 undo して redo 分が残っていても、送り先と基点が cursor に揃う', () => {
    const full = applyStudyMoves(initial, ['7g7f', '3c3d', '2g2f']);
    const s = undo(undo(full)); // ▲７六歩まで戻す（redo 分が 2 段残っている）
    expect(canRedo(s)).toBe(true);

    const target = namedEvalTarget(s);
    expect(target?.move).toBe('7g7f');
    // 送る SFEN も基点も cursor の 1 つ手前（= 初期局面）で、末尾の局面ではない
    expect(target?.sfen).toBe(positionSfen(initial));
    expect(target?.from).toBe(initial);
    expect(target?.from).not.toBe(currentState(full));

    // 局面評価の側も cursor の局面（末尾ではない）
    const position = positionEvalTarget(s);
    expect(position.from).toBe(currentState(s));
    expect(position.sfen).toBe(positionSfen(currentState(s)));
  });
});

describe('評価の送り先', () => {
  it('局面評価は現在の検討局面をそのまま送る', () => {
    const s = applyStudyMoves(initial, ['7g7f']);
    expect(positionEvalTarget(s)).toEqual({
      sfen: positionSfen(currentState(s)),
      move: null,
      from: currentState(s),
    });
  });

  it('名指し評価は「その手を指す前」の局面と手を送る', () => {
    const s = applyStudyMoves(initial, ['7g7f']);
    // 🔴 手を適用した後の局面を送ると別の手を読むことになる
    expect(namedEvalTarget(s)).toEqual({
      sfen: positionSfen(initial),
      move: '7g7f',
      from: initial,
    });
  });

  it('検討していない / 直前が編集なら名指しできない', () => {
    expect(namedEvalTarget(createStudySession(initial))).toBeNull();
    expect(namedEvalTarget(toggleTurn(createStudySession(initial)))).toBeNull();
  });
});
