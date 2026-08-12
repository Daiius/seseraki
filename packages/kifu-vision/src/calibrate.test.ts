import { describe, expect, it } from 'vitest';
import type { GrayImage } from './frame.ts';
import type { BoardGeometry } from './geometry.ts';
import { calibrateGeometry, calibrateFromFrames, isCalibrationTrustworthy } from './calibrate.ts';

const SEED: BoardGeometry = {
  originX: 10,
  originY: 20,
  cellW: 30,
  cellH: 34,
  frameW: 320,
  frameH: 360,
};

/** 指定した格子で線を引いた盤の絵を作る（線は暗く、マスの中は明るい） */
function drawBoard(geo: Partial<BoardGeometry> & { frameW: number; frameH: number }): GrayImage {
  const g = { ...SEED, ...geo };
  const data = new Uint8Array(g.frameW * g.frameH).fill(180);
  const put = (x: number, y: number) => {
    if (x >= 0 && x < g.frameW && y >= 0 && y < g.frameH) data[y * g.frameW + x] = 40;
  };
  for (let i = 0; i <= 9; i++) {
    const x = Math.round(g.originX + g.cellW * i);
    for (let y = Math.round(g.originY); y <= Math.round(g.originY + g.cellH * 9); y++) put(x, y);
    const y = Math.round(g.originY + g.cellH * i);
    for (let x2 = Math.round(g.originX); x2 <= Math.round(g.originX + g.cellW * 9); x2++) put(x2, y);
  }
  return { width: g.frameW, height: g.frameH, data };
}

describe('格子の測り直し', () => {
  it('ずれていない盤なら、元の座標がそのまま返る', () => {
    const r = calibrateGeometry(drawBoard({ frameW: 320, frameH: 360 }), SEED);
    // ⚠ ぴったりには当たらない。線には幅があり、探索も 0.25 画素刻みなので、
    // **精度は 1 画素程度**。ずれを 7 画素から 1 画素に減らせれば目的は足りる。
    expect(Math.abs(r.shift.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.shift.y)).toBeLessThanOrEqual(1);
  });

  it('⭐ 平行にずれた盤を当てて、ずれ量を返す', () => {
    const actual = { ...SEED, originX: 16, originY: 25 };
    const r = calibrateGeometry(drawBoard(actual), SEED);
    expect(Math.abs(r.geo.originX - 16)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.geo.originY - 25)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.shift.x - 6)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.shift.y - 5)).toBeLessThanOrEqual(1);
  });

  it('⚠ 背景に明暗のむらがあっても、暗い側へ引きずられない', () => {
    // 生の暗さで測ると失敗した場面。盤の背景は上ほど暗いグラデーションで、
    // 格子でない所へ寄せた方が「線上の輝度合計」は下がりうる。
    const img = drawBoard({ frameW: 320, frameH: 360 });
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = y * img.width + x;
        img.data[i] = Math.max(0, img.data[i] - Math.round((y / img.height) * 90));
      }
    }
    const r = calibrateGeometry(img, SEED);
    expect(Math.abs(r.shift.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.shift.y)).toBeLessThanOrEqual(1);
  });

  it('⚠ 画面端に黒帯があっても、そこを「限りなく暗い格子線」と取らない', () => {
    const img = drawBoard({ frameW: 320, frameH: 360 });
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < 14; x++) img.data[y * img.width + x] = 0;
    }
    const r = calibrateGeometry(img, SEED);
    expect(Math.abs(r.shift.x)).toBeLessThanOrEqual(1);
  });

  it('マスの大きさが違う盤も当てられる', () => {
    const actual = { ...SEED, cellW: 30.75, cellH: 33.2 };
    const r = calibrateGeometry(drawBoard(actual), SEED);
    expect(r.geo.cellW).toBeCloseTo(30.75, 0);
    expect(r.geo.cellH).toBeCloseTo(33.2, 0);
  });

  it('🔴 盤が写っていない絵でも「答え」は返るが、はっきりしないので採用しない', () => {
    // 一様な絵。格子はどこにも無いが、探索は必ず最小値を見つけてしまう。
    const flat: GrayImage = { width: 320, height: 360, data: new Uint8Array(320 * 360).fill(150) };
    const r = calibrateGeometry(flat, SEED);
    expect(r.geo).toBeDefined();
    expect(isCalibrationTrustworthy(r)).toBe(false);
  });

  it('採用できる絵が 1 枚も無ければ null を返す', () => {
    const flat: GrayImage = { width: 320, height: 360, data: new Uint8Array(320 * 360).fill(150) };
    expect(calibrateFromFrames([flat, flat], SEED)).toBeNull();
  });

  it('複数枚から中央値を採る。盤の無い絵は混ざっても無視される', () => {
    const actual = { ...SEED, originX: 16, originY: 25 };
    const flat: GrayImage = { width: 320, height: 360, data: new Uint8Array(320 * 360).fill(150) };
    const r = calibrateFromFrames([drawBoard(actual), flat, drawBoard(actual)], SEED);
    expect(r).not.toBeNull();
    expect(r!.used).toBe(2);
    expect(r!.tried).toBe(3);
    expect(r!.geo.originX).toBeCloseTo(16, 0);
  });
});
