import { describe, expect, it } from 'vitest';
import type { GrayImage } from './frame.ts';
import { cellStats, presence, presenceOf, occupancy, EMPTY_MAX_SD, OCCUPANCY_THRESHOLD } from './occupancy.ts';

/**
 * 各マスの標準偏差を指定して合成した盤画像を作る。
 *
 * 1 マス 10x10 の上半分を `128 - sd`、下半分を `128 + sd` で塗る。
 * `cellStats` が見るのは内側（inset 0.18）の 6x6 で、上下 3 行ずつに割れるので
 * 標準偏差はちょうど `sd` になる。
 */
function boardWithSd(sds: number[][]): GrayImage {
  const cell = 10;
  const size = cell * 9;
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sd = sds[Math.floor(y / cell)][Math.floor(x / cell)];
      data[y * size + x] = y % cell < cell / 2 ? 128 - sd : 128 + sd;
    }
  }
  return { width: size, height: size, data };
}

const uniform = (sd: number) => Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => sd));

describe('boardWithSd（合成画像そのものの確認）', () => {
  it('指定した標準偏差どおりのマスになる', () => {
    const stats = cellStats(boardWithSd(uniform(20)));
    expect(stats[0][0].sd).toBeCloseTo(20, 6);
    expect(stats[8][8].sd).toBeCloseTo(20, 6);
  });
});

describe('presenceOf', () => {
  it('境界の内と外で 3 つに分かれる', () => {
    expect(presenceOf(EMPTY_MAX_SD)).toBe('empty');
    expect(presenceOf(EMPTY_MAX_SD + 0.1)).toBe('unclear');
    expect(presenceOf(OCCUPANCY_THRESHOLD)).toBe('unclear');
    expect(presenceOf(OCCUPANCY_THRESHOLD + 0.1)).toBe('piece');
  });

  it('通常の空マス（実測 2〜12）は空と断定される', () => {
    for (const sd of [2, 5, 9, 12]) expect(presenceOf(sd)).toBe('empty');
  });

  it('演出に覆われて誤って空とされていた帯（実測 13〜30）は未確定になる', () => {
    // 0:20.4 のエフェクトのピークで誤って「空」になった 6 マスの実測値
    for (const sd of [13, 15, 19, 25, 28, 30]) expect(presenceOf(sd)).toBe('unclear');
  });

  it('駒があるマス（実測 51〜71）は駒ありのまま', () => {
    for (const sd of [51, 60, 71]) expect(presenceOf(sd)).toBe('piece');
  });
});

describe('presence', () => {
  it('マスごとに 3 値を返す', () => {
    const sds = uniform(5);
    sds[3][4] = 20; // 覆われた帯
    sds[8][0] = 60; // 駒あり
    const p = presence(boardWithSd(sds));
    expect(p[0][0]).toBe('empty');
    expect(p[3][4]).toBe('unclear');
    expect(p[8][0]).toBe('piece');
  });

  it('2 値の occupancy は変わらない（初期局面探しはそのまま）', () => {
    const sds = uniform(5);
    sds[3][4] = 20;
    sds[8][0] = 60;
    const occ = occupancy(boardWithSd(sds));
    expect(occ[3][4]).toBe(false); // 未確定は 2 値では「駒なし」のまま
    expect(occ[8][0]).toBe(true);
  });
});
