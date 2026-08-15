/**
 * 「打てない駒が打たれた」と読めた絵を、打てる駒に限って読み直す
 *
 * 🔴 実際に踏んだ形（1 局目 16:32〜17:00・27 秒ぶん約 10 手が落ちていた）:
 * 後手が 8f に**金を打った**のに、`▽全`（成銀）のテンプレートの方が一致した。
 * 成駒は打てないので `inferMove` は `undroppable` を返し、その手は落ちる。
 *
 * ⚠ **これは「同点を絵で割る」ことではない。** 一度それをやって失敗している
 * （追記 69: 候補が同点で並んだとき移動先の絵で割ったら `S*8f`（銀打ち）を選び、
 * スライド破棄が 7 → 67 に増えた）。**絵で決まらなかったから候補を見ているのに、
 * 同じ問いをもう一度投げても答えは変わらない。**
 *
 * ⭐ ここでやるのは逆向き。**読みが「規則上あり得ない答え」を出したので、
 * あり得ない答えを取り除いてもう一度読む。** 問いが変わっている。
 *
 * そして実測では、取り除いたあとの絵は決めきれている（1 局目 8f・4 つの時刻で安定）:
 *
 * | 順位 | 駒 | NCC | |
 * |---|---|---|---|
 * | 1 | `▽全` | 0.760 | 打てない |
 * | 2 | **`▽金`** | **0.692** | **打てる** |
 * | 3 | `▽圭` | 0.511 | 打てない |
 * | 5 | `▽歩` | 0.383 | 打てる |
 *
 * **打てる駒だけで見れば 0.692 対 0.383 で 0.31 開いている。**
 * （`▽銀` は上位 8 位にも入らない。追記 69 で銀が選ばれたのは別の仕組みのため）
 */

import type { PieceKind, Side, Square } from 'shared';
import type { GrayImage } from './frame.ts';
import { cellImageForSide, classify, type Template } from './template.ts';

/** 打てる駒（成駒と玉は打てない） */
export const DROPPABLE_KINDS: PieceKind[] = ['P', 'L', 'N', 'S', 'G', 'B', 'R'];

const DROPPABLE = new Set<PieceKind>(DROPPABLE_KINDS);

export interface UndroppableSpot {
  row: number;
  col: number;
  side: Side;
  /** 読めてしまった、打てない駒 */
  kind: PieceKind;
}

/**
 * 「空マスに、打てない駒が 1 つだけ現れた」形かを見る。
 *
 * ⚠ **変わったマスが 1 つだけのときに限る。** 2 マス以上動いていれば、それは
 * 盤上の移動（成りを含む）であって打ちではない。成駒が現れること自体は正常なので、
 * 打ちの形に見えるときだけを拾う。
 */
export function findUndroppableDrop(before: Square[][], after: Square[][]): UndroppableSpot | null {
  let found: UndroppableSpot | null = null;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const a = before[row][col];
      const b = after[row][col];
      if (!a && !b) continue;
      if (a && b && a.kind === b.kind && a.side === b.side) continue;
      if (found) return null; // 2 マス以上変わっている
      if (a || !b) return null; // 空マスが埋まった形ではない
      if (DROPPABLE.has(b.kind)) return null; // 打てる駒なら困っていない
      found = { row, col, side: b.side, kind: b.kind };
    }
  }
  return found;
}

export interface DroppableReading {
  kind: PieceKind;
  score: number;
  /** 打てる駒の中での 2 位との差 */
  margin: number;
}

/**
 * そのマスを、**打てる駒だけ**に限って読み直す。
 *
 * ⚠ 向き（先手か後手か）は絞り込みに使ってよい。駒は 180 度回して置かれるので、
 * 色ではなく向きで見分けており、駒種よりはるかに安定している。
 */
export function readAsDroppable(
  board: GrayImage,
  row: number,
  col: number,
  side: Side,
  templates: Template[],
  options: { minScore?: number; minMargin?: number } = {},
): DroppableReading | null {
  const minScore = options.minScore ?? DROPPABLE_MIN_SCORE;
  const minMargin = options.minMargin ?? DROPPABLE_MIN_MARGIN;
  const allowed = templates.filter((t) => t.side === side && DROPPABLE.has(t.kind));
  if (allowed.length === 0) return null;

  // 向きは決まっているので、その向きの窓で切り出す（追記 141）
  const match = classify(cellImageForSide(board, row, col, side), allowed);
  if (!match) return null;
  if (match.score < minScore || match.margin < minMargin) return null;
  return { kind: match.template.kind, score: match.score, margin: match.margin };
}

/**
 * 読み直した結果を採用してよい一致度。
 *
 * `recognize.ts` の `UNKNOWN_NCC_THRESHOLD`（0.45）と同じ考え方。実測の 0.692 は
 * 余裕をもって超える。
 */
export const DROPPABLE_MIN_SCORE = 0.45;

/**
 * 打てる駒の中で 2 位とこれだけ開いていなければ採らない。
 *
 * 🔒 **開いていないなら決めない。** 絵で決まらないものを絵で決めると、追記 69 と
 * 同じ失敗になる。実測の差は 0.309（`▽金` 0.692 対 `▽歩` 0.383）なので、
 * 0.10 は「決まっている場合だけ通す」線として十分に低い。
 */
export const DROPPABLE_MIN_MARGIN = 0.1;
