/**
 * 局面が変わらない区間（セグメント）への分割
 *
 * 変化を検出した瞬間のフレームを読んではいけない。将棋アプリは駒がスライドして
 * 動くので、変化した直後は駒がマスの間にあり、テンプレート照合が崩れる。
 * 実測でも、変化点のフレームは NCC の最低値が中央 0.384 まで落ちた（静止した
 * 局面なら 0.986）。
 *
 * すべての指し手は必ず 1 マス以上の「駒の有無」を変えるので、有無が同じまま
 * 続く区間は同じ局面である。その区間の**真ん中**を代表として読めば、
 * アニメーションもフレーム取得のわずかなずれも避けられる。
 */

import type { BoardGeometry } from './geometry.ts';
import { streamBoardFrames } from './frame.ts';
import { occupancy, occupancyDistance } from './occupancy.ts';

export interface Segment {
  /** 何番目のフレームから */
  fromIndex: number;
  /** 何番目のフレームまで（含む） */
  toIndex: number;
  /** 代表として読むべき時刻（秒） */
  representativeTime: number;
  /** 区間の長さ（フレーム数）。1 なら不安定でアニメーションを掴む恐れがある。 */
  length: number;
  occupancy: boolean[][];
}

/**
 * 動画全体を、駒の有無が変わらない区間に切り分ける。
 *
 * 盤面に crop して縮小したものを 1 パスで流す。縮小しても有無の判定は
 * 変わらない（等倍と 1/4 で食い違い 0 マスであることを実測で確認済み）。
 */
export async function findSegments(
  videoPath: string,
  geo: BoardGeometry,
  fps: number,
  divisor = 4,
  range?: { startSec?: number; durationSec?: number },
): Promise<Segment[]> {
  const offset = range?.startSec ?? 0;
  const segments: Segment[] = [];
  let currentOcc: boolean[][] | null = null;
  let startIndex = 0;
  let lastIndex = 0;

  const flush = () => {
    if (!currentOcc) return;
    // 区間の真ん中を選ぶ。端はアニメーションや演出に近い。
    const mid = (startIndex + lastIndex) / 2;
    segments.push({
      fromIndex: startIndex,
      toIndex: lastIndex,
      representativeTime: offset + mid / fps,
      length: lastIndex - startIndex + 1,
      occupancy: currentOcc,
    });
  };

  await streamBoardFrames(videoPath, geo, fps, divisor, (img, index) => {
    const occ = occupancy(img);
    if (!currentOcc) {
      currentOcc = occ;
      startIndex = index;
      lastIndex = index;
      return;
    }
    if (occupancyDistance(occ, currentOcc) === 0) {
      lastIndex = index;
      return;
    }
    flush();
    currentOcc = occ;
    startIndex = index;
    lastIndex = index;
  }, range);
  flush();

  return segments;
}
