import { describe, expect, it } from 'vitest';
import type { GrayImage } from './frame.ts';
import { bestShiftNcc, ncc, resample, rotate180, shiftImage } from './template.ts';

/** 座標から決まる、なめらかで方向のある模様。回転すれば必ず別物になる。 */
function gradient(width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = Math.round((200 * x) / width + (40 * y) / height);
    }
  }
  return { width, height, data };
}

describe('resample', () => {
  it('同じ寸法ならそのまま返す', () => {
    const img = gradient(8, 9);
    expect(resample(img, 8, 9)).toBe(img);
  });

  it('引き伸ばしても字の形（＝相関）が保たれる', () => {
    // 駒の絵を別解像度の相手と照合できるかは、これが成り立つかにかかっている。
    const small = gradient(24, 26);
    const big = resample(small, 61, 66);
    expect(big.width).toBe(61);
    expect(big.height).toBe(66);
    // 大きい方から作った本物と比べても、ほぼ同じ絵になっている
    expect(ncc(big, resample(gradient(48, 52), 61, 66))).toBeGreaterThan(0.99);
  });

  it('往復させても崩れない', () => {
    const original = gradient(48, 52);
    const round = resample(resample(original, 61, 66), 48, 52);
    expect(ncc(round, original)).toBeGreaterThan(0.99);
  });

  it('画素の中心どうしを対応させる（端を端に寄せない）', () => {
    // 半画素ずれると小さい絵ほど効く。左右対称な絵は引き伸ばしても対称なはず。
    const w = 9;
    const data = new Uint8Array(w);
    for (let x = 0; x < w; x++) data[x] = x === 4 ? 255 : 0;
    const stretched = resample({ width: w, height: 1, data }, 27, 1);
    let sumLeft = 0;
    let sumRight = 0;
    for (let x = 0; x < 13; x++) sumLeft += stretched.data[x];
    for (let x = 14; x < 27; x++) sumRight += stretched.data[x];
    expect(sumLeft).toBe(sumRight);
  });
});

describe('rotate180', () => {
  it('2 回まわすと元に戻る', () => {
    const img = gradient(11, 13);
    expect([...rotate180(rotate180(img)).data]).toEqual([...img.data]);
  });

  it('方向のある絵は回すと別物になる', () => {
    const img = gradient(11, 13);
    expect(ncc(rotate180(img), img)).toBeLessThan(0);
  });
});

/**
 * 細かい模様。**なめらかな絵ではずれの検出を試せない**——線形の勾配は
 * 数画素ずらしても相関がほとんど落ちないので、「ずらして合わせた」ことの
 * 確かめにならない。駒字は細い線の集まりなので、こちらの方が実物に近い。
 */
function texture(width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = ((x * 7 + y * 13) % 17) * 15;
    }
  }
  return { width, height, data };
}

describe('shiftImage', () => {
  it('ずらして戻すと、内側は 1 画素も変わらない', () => {
    const img = texture(20, 20);
    const back = shiftImage(shiftImage(img, 3, -2), -3, 2);
    // ⚠ 端は端の画素で埋めるので戻らない。しかも駒字のような細かい絵では
    // 埋めた帯が全体の相関をかなり下げる（実測 0.71）。**内側だけを見る。**
    // 照合で見るのはマスの内側 52% なので、実用上はこれで足りる。
    for (let y = 2; y < 18; y++) {
      for (let x = 3; x < 17; x++) {
        expect(back.data[y * 20 + x]).toBe(img.data[y * 20 + x]);
      }
    }
  });
});

describe('bestShiftNcc', () => {
  it('ずれている相手でも、ずらし直せば一致すると分かる', () => {
    // 後手の駒＝先手の駒を 180 度回して数画素ずらしたもの。ずれたまま測ると
    // 本物どうしでも値が落ちるので、ラベルの裏取りに使えなくなる。
    const img = texture(30, 30);
    const moved = shiftImage(img, 4, -3);
    expect(ncc(moved, img)).toBeLessThan(0.5);

    const best = bestShiftNcc(moved, img, 5);
    expect(best.dx).toBe(4);
    expect(best.dy).toBe(-3);
    expect(best.score).toBeGreaterThan(0.99);
  });

  it('探す範囲の外なら見つからない', () => {
    const img = texture(30, 30);
    const best = bestShiftNcc(shiftImage(img, 9, 0), img, 2);
    expect(best.score).toBeLessThan(0.9);
  });
});
