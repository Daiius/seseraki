/**
 * マスに駒があるかの判定
 *
 * 空マスは盤の木目だけなので輝度がのっぺり並ぶのに対し、駒があるマスは
 * 黒い駒字と明るい駒面が同居するので輝度が大きく散らばる。実測では
 * 標準偏差が空マス 2〜9 / 駒あり 51〜71 と 2 山に完全に割れ、間に 40 以上の
 * 隙間があった。閾値の置き所に神経を使う必要がない。
 *
 * 盤の背景演出（終盤に赤くなる等）で輝度の水準自体は動くが、
 * 標準偏差は水準に依らないのでそのまま使える。
 *
 * 入力は「盤ちょうど」に切り出した画像で、これを 9x9 に等分して見る。
 * 縮小した画像でもそのまま通るので、変化検出用の粗いフレームにも使える。
 */

import type { GrayImage } from './frame.ts';

/** 標準偏差がこれを超えたら駒あり。2 山の隙間のほぼ中央。 */
export const OCCUPANCY_THRESHOLD = 30;

/** マスの内側どれだけを見るか。格子線と隣のマスのはみ出しを避ける。 */
export const CELL_INSET = 0.18;

export interface CellStat {
  mean: number;
  sd: number;
}

/** 盤画像を 9x9 に等分した [row][col] のマスの統計を返す */
export function cellStats(board: GrayImage, inset = CELL_INSET): CellStat[][] {
  const cw = board.width / 9;
  const ch = board.height / 9;
  const mx = cw * inset;
  const my = ch * inset;

  const out: CellStat[][] = [];
  for (let row = 0; row < 9; row++) {
    out.push([]);
    for (let col = 0; col < 9; col++) {
      const x0 = Math.round(cw * col + mx);
      const y0 = Math.round(ch * row + my);
      const x1 = Math.round(cw * (col + 1) - mx);
      const y1 = Math.round(ch * (row + 1) - my);

      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const base = y * board.width;
        for (let x = x0; x < x1; x++) {
          sum += board.data[base + x];
          n++;
        }
      }
      const mean = sum / n;
      let varSum = 0;
      for (let y = y0; y < y1; y++) {
        const base = y * board.width;
        for (let x = x0; x < x1; x++) {
          varSum += (board.data[base + x] - mean) ** 2;
        }
      }
      out[row].push({ mean, sd: Math.sqrt(varSum / n) });
    }
  }
  return out;
}

/** 各マスに駒があるかを 9x9 で返す */
export function occupancy(
  board: GrayImage,
  threshold = OCCUPANCY_THRESHOLD,
): boolean[][] {
  return cellStats(board).map((r) => r.map((s) => s.sd > threshold));
}

/** 平手の初期配置で駒が置かれているマス */
export const INITIAL_OCCUPANCY: boolean[][] = [
  [true, true, true, true, true, true, true, true, true],
  [false, true, false, false, false, false, false, true, false],
  [true, true, true, true, true, true, true, true, true],
  [false, false, false, false, false, false, false, false, false],
  [false, false, false, false, false, false, false, false, false],
  [false, false, false, false, false, false, false, false, false],
  [true, true, true, true, true, true, true, true, true],
  [false, true, false, false, false, false, false, true, false],
  [true, true, true, true, true, true, true, true, true],
];

/** 2 つの occupancy が食い違うマスの数 */
export function occupancyDistance(a: boolean[][], b: boolean[][]): number {
  let n = 0;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (a[row][col] !== b[row][col]) n++;
    }
  }
  return n;
}

/**
 * マウスポインタが乗っているマスか
 *
 * ポインタは**白い矢印**で、盤の木目（実測 130〜210）よりはっきり明るい。
 * マス内に極端に明るい画素がまとまってあれば、そこにポインタがいるとみてよい。
 *
 * ポインタが乗ると輝度の散らばりが増えて空マスが「駒あり」と誤判定され、
 * テンプレート照合が適当な駒を当ててしまう。**駒を動かす瞬間ポインタは必ず
 * 盤上にいる**ので、いちばん読みたい場面でいちばん邪魔になる。
 *
 * 集めた「読めなかったマス」23 枚を並べて見たところ、**大半がポインタだった**
 * （成駒は数枚）。誤認識の主因はテンプレート不足ではなくこれだった。
 */
export function hasPointer(cell: GrayImage, threshold = POINTER_BRIGHTNESS, ratio = POINTER_AREA): boolean {
  let bright = 0;
  for (const v of cell.data) if (v > threshold) bright++;
  return bright / cell.data.length > ratio;
}

/**
 * これより明るい画素はポインタの白とみなす。
 *
 * 実測（4941 マス）で決めた。この基準を超える画素を 1% 以上含むマスは 41 個で、
 * フレーム 61 枚に対し 1 枚あたり 0.67 マス。**ポインタは常に 1 個**なので妥当な数。
 * 基準を 225 に下げると 546 マス（1 枚あたり 8.9 マス）に急増し、駒や盤の
 * 明るい部分を拾い始める。マス内の最大輝度は中央 214 なので、235 で分離が成立する。
 */
export const POINTER_BRIGHTNESS = 235;

/**
 * マスのこの割合を超えて白ければポインタがいる。
 *
 * 4% にしていたが実測すると厳しすぎた（41 マス → 27 マスに減る）。
 * ポインタがマスに部分的にしか掛かっていない場合を取りこぼす。
 */
export const POINTER_AREA = 0.01;

/** 目視用に occupancy を 9 行の文字列にする */
export function formatOccupancy(occ: boolean[][]): string {
  return occ.map((r) => r.map((v) => (v ? '#' : '.')).join('')).join('\n');
}
