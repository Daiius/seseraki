/**
 * 「読めなかったマス」を盤面そのもので表す
 *
 * ⚠ これが無かったせいで長く遠回りした。`Square = 駒 | null` の 2 値では
 * **「駒はあるが何か分からない」が書けない**。だから `recognizeBoard` は
 * NCC が 0.2 しかない当てずっぽうでも駒を置くしかなく、`lowConfidence` に
 * 名前を控えるだけだった。控えを見ない経路（素の読み・二分探索）では、
 * その幻の駒がそのまま `checkBoard` と `inferMove` に渡っていた。
 *
 * 実測（6:40 の 4e・マウスポインタしか無い空マス）:
 *
 * ```
 * ▽と 0.208  ← 1 位。だが UNKNOWN_NCC_THRESHOLD は 0.45
 * ▽玉 0.144
 * ```
 *
 * 「読めていない」と判定できているのに盤には置いてしまう。盤上の駒には枚数の
 * 上限があるので、幻が 1 枚湧くだけで `checkBoard` が 81 マスぶんの情報を捨てる。
 *
 * **未確定を未確定のまま持てれば、判断を後の場面へ先送りできる。**
 * ポインタは動けば退くし、成駒はいずれテンプレートが手に入る。
 * いま決められないことを、いま決めなくてよくなる。
 */

import type { Square } from 'shared';

/** 駒はあるが、何かは分からない */
export const UNKNOWN = 'unknown';

/** 駒 / 空 / 未確定 の 3 値。認識の途中でだけ使い、外へ出すときは解決しておく。 */
export type VisionSquare = Square | typeof UNKNOWN;

export function isUnknown(square: VisionSquare): square is typeof UNKNOWN {
  return square === UNKNOWN;
}

export interface CellRef {
  row: number;
  col: number;
}

/** 未確定のマスを列挙する */
export function unknownCells(board: VisionSquare[][]): CellRef[] {
  const out: CellRef[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (isUnknown(board[row][col])) out.push({ row, col });
    }
  }
  return out;
}

/**
 * 指定したマスを未確定にする。
 *
 * 一致度は高いのに駒数が規定を超えている、のように**照合の外から疑わしいと
 * 分かった**マスに使う（テンプレートの無い駒が別の駒として高い一致度で
 * 読まれる場合がこれ）。
 */
export function markUnknown(board: VisionSquare[][], cells: CellRef[]): VisionSquare[][] {
  if (cells.length === 0) return board;
  const out = board.map((r) => r.slice());
  for (const c of cells) out[c.row][c.col] = UNKNOWN;
  return out;
}

/**
 * 未確定のマスを、直前の配置で埋める。
 *
 * **覆われただけなら駒はそこにあり続けている**ので、「変わっていない」と
 * 仮定するのが最もありそうな読み。誤った駒として読むと差分が壊れるが、
 * 引き継げば壊れない。
 *
 * 駒が取られて消えた場合は駒の有無の方が変わるので、引き継いでも 1 手差分に
 * ならず、呼び出し側で別の経路に落ちる。覆われている間に相手の駒へ置き換わった
 * 場合だけは見逃しうるが、次に読める時点で辻褄が合わなくなるので気付ける。
 *
 * ⚠ 成った駒もテンプレートが無いうちは未確定になる。引き継ぐと成りが消えるので、
 * **引き継いだ版で説明が付かないときは当てずっぽうの版でも試す**こと。
 */
export function resolveWith(board: VisionSquare[][], previous: Square[][]): Square[][] {
  const out: Square[][] = [];
  for (let row = 0; row < 9; row++) {
    out.push([]);
    for (let col = 0; col < 9; col++) {
      const s = board[row][col];
      out[row].push(isUnknown(s) ? previous[row][col] : s);
    }
  }
  return out;
}

/**
 * 未確定のマスを、照合の第一候補で埋める（従来どおりの当てずっぽう）。
 *
 * ⚠ **既定の経路にしてはいけない。** 一致度 0.2 の当てずっぽうでも駒を置くので、
 * 盤面の枚数制限を壊して `checkBoard` に丸ごと捨てさせる。
 * 成りは引き継ぎでは検出できないので、**そのときだけ**使う。
 */
export function fillGuesses(board: VisionSquare[][], guesses: Square[][]): Square[][] {
  const out: Square[][] = [];
  for (let row = 0; row < 9; row++) {
    out.push([]);
    for (let col = 0; col < 9; col++) {
      const s = board[row][col];
      out[row].push(isUnknown(s) ? guesses[row][col] : s);
    }
  }
  return out;
}

/** 未確定が 1 つも残っていなければ普通の盤面として返す。残っていれば null。 */
export function settle(board: VisionSquare[][]): Square[][] | null {
  const out: Square[][] = [];
  for (let row = 0; row < 9; row++) {
    out.push([]);
    for (let col = 0; col < 9; col++) {
      const s = board[row][col];
      if (isUnknown(s)) return null;
      out[row].push(s);
    }
  }
  return out;
}
