import { describe, expect, it } from 'vitest';
import { inkRedness, isPromotedKind } from './ink.ts';
import type { YuvImage } from './frame.ts';

/**
 * 木地の上に字を描いたマスを合成する。
 *
 * 木地は橙（R が G より高い）で、実測の R−G ≒ 47 に合わせてある。
 * 字は `inkRg` だけ R が G より高い暗い画素。
 */
function cell(inkRg: number, inkFraction = 0.3): YuvImage {
  const w = 20;
  const h = 20;
  const n = w * h;
  const y = new Uint8Array(n);
  const u = new Uint8Array(n);
  const v = new Uint8Array(n);
  const inkPixels = Math.floor(n * inkFraction);
  // R−G = 2.116136(V−128) + 0.344136(U−128)。U は動かさず V だけで作る。
  const vFor = (rg: number) => Math.round(128 + rg / 2.116136);
  for (let i = 0; i < n; i++) {
    const ink = i < inkPixels;
    y[i] = ink ? 40 : 200;
    u[i] = 128;
    v[i] = vFor(ink ? inkRg : 47); // 木地は実測どおり R−G ≒ 47 の橙
  }
  return { width: w, height: h, y, u, v };
}

describe('inkRedness', () => {
  it('黒い字（生駒）は比が小さい', () => {
    // 実測: 生駒のインク R−G は 15〜22、木地は 45〜50 → 比 0.3〜0.5
    const { ratio } = inkRedness(cell(20));
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.6);
  });

  it('朱の字（成駒）は比が大きい', () => {
    // 実測: 成駒のインク R−G は 55〜58 → 比 1.1 前後
    const { ratio } = inkRedness(cell(55));
    expect(ratio).toBeGreaterThan(0.9);
  });

  it('生駒と成駒の間に 0.76 の線を引ける', () => {
    expect(inkRedness(cell(20)).ratio).toBeLessThan(0.76);
    expect(inkRedness(cell(55)).ratio).toBeGreaterThan(0.76);
  });

  it('木地に赤みが無ければ測れないと返す（盤らしくない絵）', () => {
    const n = 100;
    const flat = { width: 10, height: 10, y: new Uint8Array(n).fill(128),
      u: new Uint8Array(n).fill(128), v: new Uint8Array(n).fill(128) }; // 灰色一色
    expect(inkRedness(flat).ratio).toBeNaN();
  });
});

describe('isPromotedKind', () => {
  it('成駒だけを成駒と言う', () => {
    for (const k of ['+P', '+L', '+N', '+S', '+B', '+R']) expect(isPromotedKind(k)).toBe(true);
    for (const k of ['P', 'L', 'N', 'S', 'G', 'B', 'R', 'K']) expect(isPromotedKind(k)).toBe(false);
  });
});
