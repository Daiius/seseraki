import { describe, expect, it, vi } from 'vitest';
import { buildPositions, type Square } from 'shared';
import { bridgeGap } from './bridge.ts';

describe('bridgeGap', () => {
  const moves = ['7g7f', '3c3d', '2g2f', '8c8d'];
  const positions = buildPositions(moves).map((p) => p.board);

  /** 時刻 0..4 に 1 手ずつ進む動画を模す */
  const readAt = (t: number): Square[][] => positions[Math.min(4, Math.max(0, Math.round(t)))];

  it('1 手で繋がるならそのまま返す', () => {
    const steps = bridgeGap(0, 1, positions[0], positions[1], 1, readAt);
    expect(steps).not.toBeNull();
    expect(steps!.map((s) => s.move.usi)).toEqual(['7g7f']);
  });

  it('間に手が挟まっていても二分して拾い直す', () => {
    const steps = bridgeGap(0, 4, positions[0], positions[4], 4, readAt);
    expect(steps).not.toBeNull();
    expect(steps!.map((s) => s.move.usi)).toEqual(moves);
  });

  it('配置が同じなら手は無い', () => {
    expect(bridgeGap(0, 4, positions[2], positions[2], 4, readAt)).toEqual([]);
  });

  it('中間が読めなければ諦める', () => {
    const steps = bridgeGap(0, 4, positions[0], positions[4], 4, () => null);
    expect(steps).toBeNull();
  });

  it('繋がらない区間は諦めて null を返す', () => {
    // 途中がまったく読めない（いつも初期局面が返る）動画
    const steps = bridgeGap(0, 4, positions[0], positions[4], 4, () => positions[0]);
    expect(steps).toBeNull();
  });

  it('静止している区間では余計にフレームを読まない', () => {
    const read = vi.fn(readAt);
    bridgeGap(0, 1, positions[0], positions[1], 1, read);
    // 1 手で繋がるので中間を見に行く必要がない
    expect(read).not.toHaveBeenCalled();
  });

  it('深さの上限で打ち切る', () => {
    const read = vi.fn(readAt);
    bridgeGap(0, 4, positions[0], positions[4], 4, read, { maxDepth: 0 });
    expect(read).not.toHaveBeenCalled();
  });
});
