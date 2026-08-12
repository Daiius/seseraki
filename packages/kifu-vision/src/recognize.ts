/**
 * 盤面画像 → 駒の配置
 *
 * マスごとに「駒があるか」を輝度の散らばりで判定し、あるものだけ
 * テンプレート照合にかける。持ち駒はここでは読まない（画面の持ち駒欄は
 * 対局者情報やボタンに隠れることがあるうえ、初期局面から手を追っていけば
 * 持ち駒は自然に確定するため）。
 */

import type { Square } from 'shared';
import type { GrayImage } from './frame.ts';
import { occupancy, OCCUPANCY_THRESHOLD, hasPointer } from './occupancy.ts';
import { cellImage, classify, type Template } from './template.ts';
import { UNKNOWN, isUnknown, markUnknown, resolveWith, type VisionSquare } from './uncertain.ts';

/**
 * これを下回る NCC は「テンプレートに無い駒」を疑う。
 *
 * 実測では正しく読めたマスが 0.49〜0.999（中央値 0.986）で、0.49 は
 * マウスポインタに覆われたマスだった。テンプレートが存在しない駒
 * （成駒など）は 0.1〜0.4 に落ちるので、その間に線を引く。
 */
export const UNKNOWN_NCC_THRESHOLD = 0.45;

export interface RecognizedCell {
  piece: Square;
  /** 駒があると判定されたマスのみ。空マスは NaN */
  score: number;
  margin: number;
}

export interface LowConfidenceCell {
  row: number;
  col: number;
  score: number;
  margin: number;
  /** 一応の第一候補（未知の駒なら当てにならない） */
  guess: Square;
  /** マウスポインタが乗っていたか。乗っていれば読めなくて当然。 */
  pointer?: boolean;
}

export interface RecognizedBoard {
  /**
   * 読めた駒 / 空 / 未確定 の 3 値。
   *
   * ⚠ **確信が持てないマスに当てずっぽうの駒を置かない。** 置くと盤上の枚数制限を
   * 壊し、`checkBoard` が 81 マスぶんの情報をまとめて捨てる。判断は
   * `resolveWith`（引き継ぐ）か `solveUnknowns`（手から逆算）へ先送りする。
   */
  board: VisionSquare[][];
  cells: RecognizedCell[][];
  /** NCC が低く、テンプレートに無い駒の可能性があるマス */
  lowConfidence: LowConfidenceCell[];
  /** 未確定のマスに入れた第一候補。成りの検出など、当てずっぽうでも要るとき用。 */
  guesses: Square[][];
}

export interface RecognizeOptions {
  occupancyThreshold?: number;
  unknownThreshold?: number;
}

export function recognizeBoard(
  board: GrayImage,
  templates: Template[],
  options: RecognizeOptions = {},
): RecognizedBoard {
  const occThreshold = options.occupancyThreshold ?? OCCUPANCY_THRESHOLD;
  const unknownThreshold = options.unknownThreshold ?? UNKNOWN_NCC_THRESHOLD;

  const occ = occupancy(board, occThreshold);
  const squares: VisionSquare[][] = [];
  const guesses: Square[][] = [];
  const cells: RecognizedCell[][] = [];
  const lowConfidence: LowConfidenceCell[] = [];

  for (let row = 0; row < 9; row++) {
    squares.push([]);
    guesses.push([]);
    cells.push([]);
    for (let col = 0; col < 9; col++) {
      const cut = cellImage(board, row, col);

      // マウスポインタが乗っているマスは、そこに何があっても正しく読めない。
      // 空マスなら「駒あり」と誤判定され、駒があれば別の駒に化ける。
      // 読めなかったものとして扱い、判断を後の場面へ先送りする。
      const pointer = hasPointer(cut);

      if (!occ[row][col] && !pointer) {
        squares[row].push(null);
        guesses[row].push(null);
        cells[row].push({ piece: null, score: NaN, margin: NaN });
        continue;
      }
      if (!occ[row][col] && pointer) {
        // ポインタしか無いように見えないが、その下に駒が隠れているかもしれない。
        // 「空」と断定できないので未確定にする。
        squares[row].push(UNKNOWN);
        guesses[row].push(null);
        cells[row].push({ piece: null, score: NaN, margin: NaN });
        lowConfidence.push({ row, col, score: NaN, margin: NaN, guess: null, pointer: true });
        continue;
      }
      const match = classify(cut, templates);
      if (!match) {
        squares[row].push(null);
        guesses[row].push(null);
        cells[row].push({ piece: null, score: NaN, margin: NaN });
        continue;
      }
      const piece: Square = { kind: match.template.kind, side: match.template.side };
      guesses[row].push(piece);
      cells[row].push({ piece, score: match.score, margin: match.margin });

      // ⚠ 一致度が閾値を下回るなら、**第一候補であっても盤に置かない**。
      // 実測では 0.208 の当てずっぽうが 1 位を取ることがあり、それを置くと
      // 駒数が上限を超えて盤面ごと捨てられる。
      const confident = match.score >= unknownThreshold && !pointer;
      squares[row].push(confident ? piece : UNKNOWN);
      if (!confident) {
        lowConfidence.push({ row, col, score: match.score, margin: match.margin, guess: piece, pointer });
      }
    }
  }

  return { board: squares, cells, lowConfidence, guesses };
}

/**
 * 未確定のマスを、直前の配置で埋める。
 *
 * `extra` には、照合の外から疑わしいと分かったマスを渡す（駒数が規定を
 * 超えている、など）。渡したマスも未確定として扱われる。
 *
 * 中身は `markUnknown` + `resolveWith`。判断の先送りと解決を 1 か所にまとめた
 * 呼び名として残してある。
 */
export function carryUnknowns(
  board: VisionSquare[][],
  extra: { row: number; col: number }[],
  previous: Square[][],
): Square[][] {
  return resolveWith(markUnknown(board, extra), previous);
}

function same(a: VisionSquare, b: VisionSquare): boolean {
  if (isUnknown(a) || isUnknown(b)) return isUnknown(a) && isUnknown(b);
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.side === b.side;
}

/** 2 つの配置が同じか。未確定どうしは同じ、未確定と駒は違うものとして扱う。 */
export function boardsEqual(a: VisionSquare[][], b: VisionSquare[][]): boolean {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (!same(a[row][col], b[row][col])) return false;
    }
  }
  return true;
}

/** 食い違うマスを列挙する（デバッグ用） */
export function boardDiff(
  a: VisionSquare[][],
  b: VisionSquare[][],
): { row: number; col: number; before: VisionSquare; after: VisionSquare }[] {
  const out: { row: number; col: number; before: VisionSquare; after: VisionSquare }[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (!same(a[row][col], b[row][col])) {
        out.push({ row, col, before: a[row][col], after: b[row][col] });
      }
    }
  }
  return out;
}
