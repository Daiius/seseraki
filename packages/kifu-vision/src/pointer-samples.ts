/**
 * マウスポインタが乗ったマスの絵を集める
 *
 * 新しいテンプレート（成駒など）を採るとき、**駒どうしで区別できるかだけでは
 * 足りない**。実際に躓いたのは、龍のテンプレートがマウスポインタを引き寄せた
 * ことだった。白い矢印の濃淡が「ス」の字と相関し、ポインタしかない空マスが
 * 「龍」と読まれる。盤上に龍は 1 枚しかいないので駒数が上限を超え、
 * 盤面がまるごと捨てられて、読める手が 61 → 52 に減った。
 *
 * テンプレートどうしの相関は測っていた（龍は生駒どうしより紛らわしくなかった）。
 * **駒でないものとの相関を測っていなかったのが盲点だった。**
 *
 * ここでは「駒が無いのにポインタが乗っているマス」を集める。新しいテンプレートは
 * これらとも照合して、似ていれば採用しない。
 */

import type { BoardGeometry } from './geometry.ts';
import { boardRect } from './geometry.ts';
import { grabFrame, crop, type GrayImage } from './frame.ts';
import { occupancy, hasPointer } from './occupancy.ts';
import { cellImage, ncc } from './template.ts';

export interface PointerSample {
  seconds: number;
  row: number;
  col: number;
  img: GrayImage;
}

/**
 * 動画を一定間隔で見て、ポインタだけが乗った空マスを集める。
 *
 * 駒があるマスは混ぜない。駒に重なったポインタの絵を混ぜると、
 * 「駒に似ている」のが当たり前になって判定に使えなくなる。
 */
export function collectPointerSamples(
  videoPath: string,
  geo: BoardGeometry,
  options: { fromSec: number; toSec: number; stepSec: number; max?: number; dupThreshold?: number },
): PointerSample[] {
  const max = options.max ?? 30;
  const dup = options.dupThreshold ?? 0.85;
  const out: PointerSample[] = [];

  for (let t = options.fromSec; t <= options.toSec && out.length < max; t += options.stepSec) {
    const board = crop(grabFrame(videoPath, t, geo.frameW, geo.frameH), boardRect(geo));
    const occ = occupancy(board);
    for (let row = 0; row < 9 && out.length < max; row++) {
      for (let col = 0; col < 9 && out.length < max; col++) {
        const cut = cellImage(board, row, col);
        if (!hasPointer(cut)) continue;
        // 駒があるマスは対象外。ポインタ単体の絵だけが欲しい。
        if (occ[row][col] && !isLikelyEmptyWithPointer(cut)) continue;
        if (out.some((s) => ncc(s.img, cut) > dup)) continue;
        out.push({ seconds: t, row, col, img: cut });
      }
    }
  }
  return out;
}

/**
 * ポインタを除いた部分が平らか（＝駒ではなく盤の木目）を見る。
 *
 * ポインタが乗ると `occupancy` は「駒あり」に倒れてしまうので、それだけでは
 * 空マスか判らない。明るい画素（ポインタ）を除いた残りの散らばりを見れば、
 * 木目だけなら小さく、駒があれば大きい。
 */
function isLikelyEmptyWithPointer(cell: GrayImage, brightness = 200): boolean {
  const rest: number[] = [];
  for (const v of cell.data) if (v <= brightness) rest.push(v);
  if (rest.length < cell.data.length * 0.3) return false;
  const mean = rest.reduce((a, b) => a + b, 0) / rest.length;
  const sd = Math.sqrt(rest.reduce((a, b) => a + (b - mean) ** 2, 0) / rest.length);
  // 空マス（木目のみ）の散らばりは実測で 2〜9 だが、ポインタの黒い縁取りが
  // 残るので実際にはもっと大きくなる。駒がある場合（51〜71）と分けられればよい。
  return sd < 38;
}

/** テンプレート候補がポインタの絵とどれだけ似ているか。最大値を返す。 */
export function similarityToPointers(candidate: GrayImage, samples: PointerSample[]): number {
  let worst = -1;
  for (const s of samples) {
    if (s.img.width !== candidate.width || s.img.height !== candidate.height) continue;
    const score = ncc(s.img, candidate);
    if (score > worst) worst = score;
  }
  return worst;
}
