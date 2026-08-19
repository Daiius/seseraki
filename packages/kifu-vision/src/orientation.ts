/**
 * 画面の下が先手とは限らない
 *
 * 読みは一貫して「画面の下＝先手」として組み立ててある。盤の絵だけを見ている
 * 限りそれで閉じるし、駒の向きも下の陣が上を向くので矛盾しない。
 *
 * 🔴 **だがこのアプリは対局者の視点で盤を描く。** 録画した人が後手の対局では、
 * 画面の下は後手であり、読み取った棋譜は**盤を 180° 回して先後を入れ替えた
 * 別の棋譜**になる。将棋の初期局面はこの変換で自分自身に移るので、
 * **出来上がった棋譜は合法なまま**——通しで再生しても何も起きない。
 * 実測（1 局目）: 変換後も 92 手すべて合法。合法性では原理的に検出できない。
 *
 * ⭐ **1 手目を指した側が先手。** これは追跡の状態にも画面の向きにも依らない
 * 絶対の事実で、こちらは判定に使える。初期局面から最初に動いた側が
 * 画面の上なら、その対局は「画面の下＝後手」だと分かる。
 *
 * 🔴 **同じ事実を、逆向きに使って間違えた**（追記 111・2026-08-14）。
 * 「1 手目は必ず先手」を「1 手目が後手の手なら断る」として使ったが、
 * それは「画面の下＝先手」を前提にしていた。実際には 1 局目の 1 手目は
 * 画面の上の `3c3d` で**それが正しい 1 手目**であり、断ったせいで 1・2 手目の
 * 順序が入れ替わった。🔒 **絶対の事実は、疑うべき前提と組み合わせると凶器になる。**
 * 断るのではなく、**向きを知るために使う。**
 *
 * ⚠ 対局ごとに向きは変わる（実測: 1 局目は画面の下が後手、2 局目は先手）。
 * 対局をまたいで 1 つに決めない。
 */

import type { Side } from 'shared';

export const flipSide = (side: Side): Side => (side === 'sente' ? 'gote' : 'sente');

/** USI のマス表記を 180° 回す（"7g" → "3c"） */
export function rotateSquare(square: string): string {
  const file = 10 - Number(square[0]);
  const rank = String.fromCharCode(97 + (8 - (square.charCodeAt(1) - 97)));
  return `${file}${rank}`;
}

/** USI の指し手を 180° 回す。打つ駒の種類と成りはそのまま。 */
export function rotateUsi(usi: string): string {
  if (usi[1] === '*') return `${usi[0]}*${rotateSquare(usi.slice(2))}`;
  const promote = usi.endsWith('+') ? '+' : '';
  return `${rotateSquare(usi.slice(0, 2))}${rotateSquare(usi.slice(2, 4))}${promote}`;
}

export interface OrientedMove {
  usi: string;
  side: Side;
}

/**
 * 「画面の下＝先手」として読んだ手を、実際の先後に直す。
 *
 * @param flipped 画面の下が後手だったか。false なら何もしない。
 */
export function orient<T extends OrientedMove>(move: T, flipped: boolean): T {
  if (!flipped) return move;
  return { ...move, usi: rotateUsi(move.usi), side: flipSide(move.side) };
}

/**
 * 対局の向きを 1 手目から決める。
 *
 * @param firstMoveSide 初期局面から最初に動いた側（画面の下＝先手として読んだもの）
 * @returns 画面の下が後手だったか
 */
export const isFlipped = (firstMoveSide: Side): boolean => firstMoveSide === 'gote';
