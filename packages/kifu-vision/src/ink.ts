/**
 * 駒字の**色**で成駒と生駒を見分ける。
 *
 * ⭐ 照合（NCC）はグレースケールなので、字の形しか見ていない。実測で
 * `金` と `全` は 0.70〜0.81 相関し、**位置合わせを良くするほど上がる**（追記 62）。
 * 形では割り切れない。
 *
 * だが**成駒は朱、生駒は黒**で書かれている。これは照合とはまったく独立した証拠で、
 * 人が並べてくれた `data/handoff/promoted.png` の九段（杏 圭 全 金 玉 金 全 圭 杏）で
 * 測ると、インクの R−G は成駒 +30〜+50 / 生駒 +3〜+4 と、間が 25 以上空く。
 *
 * ⚠ **盤の木地も橙なので、生の R−G では駄目**（木地自体が +45〜+50 ある）。
 * インクの R−G を**同じマスの木地の R−G で割る**。こうすると背景の演出で
 * 明るさや彩度が動いても比は保たれる。実測（動画）:
 *
 *   | | インク R−G | 木地 R−G | **比** |
 *   |---|---|---|---|
 *   | と（成駒） | 58.1 | 49.9 | **1.16** |
 *   | 金（生駒） | 20.1 | 47.9 | **0.42** |
 *   | 銀（生駒） | 17.8 | 45.3 | **0.39** |
 *
 * 🔒 これは「代用が外れたら別の証拠で門を通す」の系譜（追記 118〜119）。
 * NCC の閾値は動かさない。
 */

import type { YuvImage } from './frame.ts';

/** インク・木地とみなす画素の割合（暗い順・明るい順にこれだけ取る） */
const TAIL = 0.2;

export interface Redness {
  /** インクの R−G を木地の R−G で割った値。成駒は 1 前後、生駒は 0.4 前後。 */
  ratio: number;
  inkRedness: number;
  paperRedness: number;
}

/**
 * マスの絵から「字の赤さ」を測る。
 *
 * 暗い方から 20% を字の画素、明るい方から 20% を木地の画素とみなす。
 * ⚠ **駒が無いマスに使ってはいけない。** 字が無いので暗い側も木地になり、
 * 比は 1 に近づく（＝成駒に見える）。呼ぶ前に「駒がある」ことを確かめること。
 */
export function inkRedness(cell: YuvImage): Redness {
  const n = cell.width * cell.height;
  if (n === 0) return { ratio: NaN, inkRedness: NaN, paperRedness: NaN };

  // R−G は色差だけで決まる（Y は R にも G にも同じだけ乗るので消える）:
  //   R = Y + 1.402(V−128)
  //   G = Y − 0.344136(U−128) − 0.714136(V−128)
  //   R−G = 2.116136(V−128) + 0.344136(U−128)
  const px: { lum: number; rg: number }[] = new Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = {
      lum: cell.y[i],
      rg: 2.116136 * (cell.v[i] - 128) + 0.344136 * (cell.u[i] - 128),
    };
  }
  px.sort((a, b) => a.lum - b.lum);

  const take = Math.max(1, Math.floor(n * TAIL));
  let ink = 0;
  let paper = 0;
  for (let i = 0; i < take; i++) {
    ink += px[i].rg;
    paper += px[n - 1 - i].rg;
  }
  ink /= take;
  paper /= take;

  // 木地の赤みが無い（＝盤らしくない絵）ときは比が暴れるので測れないと返す。
  const ratio = paper > 5 ? ink / paper : NaN;
  return { ratio, inkRedness: ink, paperRedness: paper };
}

/**
 * その駒種が成駒か。
 *
 * USI の駒種は成ると `+` が付く（`+S` = 成銀）。玉と金には成りが無い。
 */
export function isPromotedKind(kind: string): boolean {
  return kind.startsWith('+');
}
