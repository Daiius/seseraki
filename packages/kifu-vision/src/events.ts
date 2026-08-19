/**
 * 「いつ盤面を読むべきか」をマスの平均色から決める
 *
 * 駒の有無（輝度の散らばり）で区間を切る方法は、マウスポインタが空マスに
 * 重なるたびに偽の変化が立つうえ、駒のスライド中の中途半端な絵も拾ってしまう。
 *
 * マスの平均色なら
 *   - ポインタは面積が小さく、平均をほとんど動かさない
 *   - 指した手のマスにはオレンジのハイライトが付くので、むしろ信号が強い
 *   - 盤の背景は位置ごとに色が違うが動かないので、時刻どうしの比較で打ち消える
 *
 * 実測では、静止した局面のノイズが 0〜1 に対し、手が指されたマスは 20〜76 と
 * 桁違いに分かれた。
 *
 * ここでは「変化が起きてから収まるまで待ち、収まった時刻」を返す。
 * その時刻の絵はアニメーションが終わっているので、そのまま読んでよい。
 */

import type { BoardGeometry } from './geometry.ts';
import { streamBoardCellColors } from './frame.ts';

/** この色差を超えたマスは「変わった」と見なす。実測のノイズは 0〜1。 */
export const CELL_COLOR_THRESHOLD = 8;

export interface StableMoment {
  /** 読むべき時刻（秒）。変化が収まった直後。 */
  time: number;
  /** 直前の落ち着いた状態から色が変わったマス */
  changed: { row: number; col: number }[];
}

function diffAt(a: Uint8Array, b: Uint8Array, cell: number): number {
  const i = cell * 3;
  return Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]);
}

function changedCells(a: Uint8Array, b: Uint8Array, threshold: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < 81; c++) if (diffAt(a, b, c) > threshold) out.push(c);
  return out;
}

/**
 * 盤面の色が動いてから収まるまでを 1 つの区切りとし、収まった時刻を列挙する。
 *
 * @param settleSeconds 変化がこの秒数だけ起きなければ「収まった」と見なす
 */
export async function findStableMoments(
  videoPath: string,
  geo: BoardGeometry,
  fps: number,
  range?: { startSec?: number; durationSec?: number },
  threshold = CELL_COLOR_THRESHOLD,
  settleSeconds = 0.3,
): Promise<StableMoment[]> {
  const frames: Uint8Array[] = [];
  await streamBoardCellColors(videoPath, geo, fps, (cells) => frames.push(cells), range);
  if (frames.length === 0) return [];

  const settleFrames = Math.max(2, Math.round(fps * settleSeconds));
  const startSec = range?.startSec ?? 0;
  const moments: StableMoment[] = [];

  // 最初のフレームも「読むべき時刻」として返す（差分を追う起点になる）
  moments.push({ time: startSec, changed: [] });

  let settled = frames[0];
  for (let i = 1; i < frames.length; i++) {
    if (changedCells(settled, frames[i], threshold).length === 0) continue;

    // 動き出した。止まるまで進める。
    let j = i;
    let quiet = 0;
    let last = frames[i];
    while (j + 1 < frames.length && quiet < settleFrames) {
      j++;
      quiet = changedCells(last, frames[j], threshold).length === 0 ? quiet + 1 : 0;
      last = frames[j];
    }

    const changed = changedCells(settled, last, threshold);
    if (changed.length > 0) {
      moments.push({
        time: startSec + j / fps,
        changed: changed.map((c) => ({ row: Math.floor(c / 9), col: c % 9 })),
      });
    }
    settled = last;
    i = j;
  }

  return moments;
}
