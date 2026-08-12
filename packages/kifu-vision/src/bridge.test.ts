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

  it('⭐ 2 手が区間の終わり近くに固まっていても拾える（割った位置が外れても諦めない）', () => {
    // 手と手の間隔は 1 秒足らずのことがある。1 サンプルの中に 2 手が収まると、
    // 二分した中間はたいてい「まだ動いていない」側に寄る。
    const late = (t: number): Square[][] =>
      t < 3.6 ? positions[0] : t < 3.8 ? positions[1] : positions[2];
    const steps = bridgeGap(0, 4, positions[0], positions[2], 4, late);
    expect(steps).not.toBeNull();
    expect(steps!.map((s) => s.move.usi)).toEqual(['7g7f', '3c3d']);
  });

  it('⭐ 2 手が区間の始まり近くに固まっていても拾える', () => {
    const early = (t: number): Square[][] =>
      t < 0.2 ? positions[0] : t < 0.4 ? positions[1] : positions[2];
    const steps = bridgeGap(0, 4, positions[0], positions[2], 4, early);
    expect(steps).not.toBeNull();
    expect(steps!.map((s) => s.move.usi)).toEqual(['7g7f', '3c3d']);
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
