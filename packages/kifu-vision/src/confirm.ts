/**
 * 「同じマスが、何度も続けて同じ駒に読めた」ことを確信の根拠にする
 *
 * ⚠ **1 枚の絵がどれだけきれいかで決めようとして失敗していた。**
 * 成りを読み直す仕組みは「次の 1 サンプルで NCC 0.85 以上なら訂正する」という
 * 一発勝負で、**一度も発火しなかった**。
 *
 * 実際に起きていたこと（6:22 の 4d）:
 *
 * | 時刻 | 読み | NCC |
 * |---|---|---|
 * | 6:22 | ▽銀 | 0.623（ポインタあり） |
 * | 6:23〜6:32 | **ずっと ▽銀** | 0.58〜0.68 |
 *
 * 逆算は「成銀」と判断していたが、実物は成らずの銀だった。**10 秒以上ずっと
 * はっきり銀に読めていた**のに、どの 1 枚も 0.85 に届かないので訂正されず、
 * 追跡中の盤面と食い違い続けて 8 回で仕切り直しになった。
 *
 * ⚠ しかも同じ 0.677 に対して 2 つのしきい値が逆の判断をしていた。
 * 認識側は 0.45 を超えるので「確信して銀」と盤に置き、読み直し側は 0.85 に
 * 届かないので「信用できない」として訂正しない。**間違いに気付く材料は
 * 毎秒目の前にあった。**
 *
 * ⭐ **0.98 が 1 回より、0.68 が 10 回続く方が確かである。**
 * ポインタも演出も動けば消えるので、**居座る読みは本物**（これは前から
 * 分かっていた性質で、判定に使っていなかっただけ）。
 */

import type { Square } from 'shared';
import { isUnknown, type VisionSquare } from './uncertain.ts';

/**
 * 同じ読みが何回続いたら確定とみなすか。
 *
 * 1 秒間隔なら 3 秒。ポインタは 1〜2 サンプルで退くので、それより長く
 * 同じに読めるなら覆いではなく駒そのものを見ている。
 */
export const CONFIRM_AFTER = Number(process.env.KIFU_VISION_CONFIRM_AFTER ?? 3);

interface Slot {
  /** 直近に読めた中身（空マスも読みのうち） */
  value: Square;
  /** 同じ読みが続いた回数 */
  streak: number;
}

export interface Confirmation {
  row: number;
  col: number;
  value: Square;
  streak: number;
}

/** マスごとに「同じ読みが何回続いたか」を覚えておく */
export class ReadingHistory {
  private slots: (Slot | null)[][] = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null));

  /**
   * 1 サンプルぶんの読みを取り込む。
   *
   * ⚠ **未確定のマスは「読めなかった」であって「変わった」ではない。**
   * 連続を切らずに、そのまま据え置く。覆われている間に別の駒へ入れ替わった
   * 場合は、覆いが取れた時点で読みが変わるので連続が切れて気付ける。
   */
  observe(board: VisionSquare[][]): void {
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const read = board[row][col];
        if (isUnknown(read)) continue;
        const slot = this.slots[row][col];
        this.slots[row][col] = slot && same(slot.value, read)
          ? { value: slot.value, streak: slot.streak + 1 }
          : { value: read, streak: 1 };
      }
    }
  }

  /** そのマスが確定しているか。していれば読めた中身を返す。 */
  confirmed(row: number, col: number, after = CONFIRM_AFTER): Confirmation | null {
    const slot = this.slots[row][col];
    if (!slot || slot.streak < after) return null;
    return { row, col, value: slot.value, streak: slot.streak };
  }

  /**
   * 追跡中の盤面と食い違っている「確定したマス」を挙げる。
   *
   * ここに挙がるのは**追跡側が間違えている可能性が高いマス**。読みは何度も
   * 同じ答えを出しているのに、追跡中の盤面だけが違うものを持っている。
   */
  contradictions(current: Square[][], after = CONFIRM_AFTER): Confirmation[] {
    const out: Confirmation[] = [];
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const c = this.confirmed(row, col, after);
        if (c && !same(c.value, current[row][col])) out.push(c);
      }
    }
    return out;
  }

  /**
   * そのマスの連続を切る。
   *
   * 手を指したなど、**追跡側が「ここは変わったはず」と知っている**ときに使う。
   * 古い読みの連続をそのまま残すと、変わる前の駒で確定してしまう。
   */
  reset(row: number, col: number): void {
    this.slots[row][col] = null;
  }

  /** 盤ごと捨てる。別の対局に移ったときのように、過去の読みが一切参考にならない場合に使う。 */
  clear(): void {
    this.slots = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null));
  }
}

function same(a: Square, b: Square): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.side === b.side;
}
