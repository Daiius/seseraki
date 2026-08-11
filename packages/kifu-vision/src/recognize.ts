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
import { occupancy, OCCUPANCY_THRESHOLD } from './occupancy.ts';
import { cellImage, classify, type Template } from './template.ts';

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
}

export interface RecognizedBoard {
  board: Square[][];
  cells: RecognizedCell[][];
  /** NCC が低く、テンプレートに無い駒の可能性があるマス */
  lowConfidence: LowConfidenceCell[];
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
  const squares: Square[][] = [];
  const cells: RecognizedCell[][] = [];
  const lowConfidence: LowConfidenceCell[] = [];

  for (let row = 0; row < 9; row++) {
    squares.push([]);
    cells.push([]);
    for (let col = 0; col < 9; col++) {
      if (!occ[row][col]) {
        squares[row].push(null);
        cells[row].push({ piece: null, score: NaN, margin: NaN });
        continue;
      }
      const match = classify(cellImage(board, row, col), templates);
      if (!match) {
        squares[row].push(null);
        cells[row].push({ piece: null, score: NaN, margin: NaN });
        continue;
      }
      const piece: Square = { kind: match.template.kind, side: match.template.side };
      squares[row].push(piece);
      cells[row].push({ piece, score: match.score, margin: match.margin });

      if (match.score < unknownThreshold) {
        lowConfidence.push({ row, col, score: match.score, margin: match.margin, guess: piece });
      }
    }
  }

  return { board: squares, cells, lowConfidence };
}

/** 2 つの配置が同じか */
export function boardsEqual(a: Square[][], b: Square[][]): boolean {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const pa = a[row][col];
      const pb = b[row][col];
      if (!pa && !pb) continue;
      if (!pa || !pb) return false;
      if (pa.kind !== pb.kind || pa.side !== pb.side) return false;
    }
  }
  return true;
}

/** 食い違うマスを列挙する（デバッグ用） */
export function boardDiff(
  a: Square[][],
  b: Square[][],
): { row: number; col: number; before: Square; after: Square }[] {
  const out: { row: number; col: number; before: Square; after: Square }[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const pa = a[row][col];
      const pb = b[row][col];
      if (!pa && !pb) continue;
      if (!pa || !pb || pa.kind !== pb.kind || pa.side !== pb.side) {
        out.push({ row, col, before: pa, after: pb });
      }
    }
  }
  return out;
}
