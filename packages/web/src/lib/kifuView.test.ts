import { describe, expect, it } from 'vitest';
import { applyMove, buildPositions } from 'shared';
import { displayOf, evalMoveNumberOf } from './kifuView';

const usiMoves = ['7g7f', '3c3d', '2g2f'];
const positions = buildPositions(usiMoves);

describe('evalMoveNumberOf', () => {
  it('直前の手を指す前の局面。初期局面は 0', () => {
    expect(evalMoveNumberOf(0)).toBe(0);
    expect(evalMoveNumberOf(1)).toBe(0);
    expect(evalMoveNumberOf(3)).toBe(2);
  });
});

describe('displayOf', () => {
  it('分岐していなければ本筋の局面と直前の実手', () => {
    const view = displayOf({ positions, usiMoves, moveIndex: 2, branchPv: null, branchDepth: 0 });
    expect(view).toMatchObject({ branchActive: false, branchDepth: 0, lastMove: '3c3d', lastMoveNumber: 1 });
    expect(view.state).toBe(positions[2]);
    expect(view.lastMovePreState).toBe(positions[1]);
  });

  it('初期局面には直前の手が無い', () => {
    const view = displayOf({ positions, usiMoves, moveIndex: 0, branchPv: null, branchDepth: 0 });
    expect(view).toMatchObject({ branchActive: false, lastMove: null, lastMovePreState: null, lastMoveNumber: 0 });
    expect(view.state).toBe(positions[0]);
  });

  it('分岐は直前の実手を指す前の局面から読み筋を辿る', () => {
    // 2 手目（3c3d）の代わりに 8c8d → 2g2f と読む
    const pv = ['8c8d', '2g2f'];
    const view = displayOf({ positions, usiMoves, moveIndex: 2, branchPv: pv, branchDepth: 2 });
    const afterFirst = applyMove(positions[1], '8c8d');
    expect(view).toMatchObject({ branchActive: true, branchDepth: 2, lastMove: '2g2f', lastMoveNumber: 2 });
    expect(view.lastMovePreState).toEqual(afterFirst);
    expect(view.state).toEqual(applyMove(afterFirst, '2g2f'));
  });

  it('🔴 読み筋が短くなったら、進めた手数を頭打ちにする（存在しない手を指さない）', () => {
    const view = displayOf({ positions, usiMoves, moveIndex: 2, branchPv: ['8c8d'], branchDepth: 5 });
    expect(view).toMatchObject({ branchActive: true, branchDepth: 1, lastMove: '8c8d', lastMoveNumber: 1 });
  });

  it('読み筋が空・進めていなければ分岐していない', () => {
    expect(displayOf({ positions, usiMoves, moveIndex: 2, branchPv: [], branchDepth: 3 })).toMatchObject({
      branchActive: false,
      branchDepth: 0,
      lastMove: '3c3d',
    });
    expect(displayOf({ positions, usiMoves, moveIndex: 2, branchPv: ['8c8d'], branchDepth: 0 })).toMatchObject({
      branchActive: false,
    });
  });
});
