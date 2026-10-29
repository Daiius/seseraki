/**
 * 棋譜の取り込み・メモの入力の上限（`POST /kifus`・`PATCH /kifus/:no`）と、列の長さへの切り詰め。
 *
 * 上限を設けないと、巨大な本文がそのまま読み込まれ、`varchar` に収まらない値は DB で 500 になる。
 */

/** 棋譜の題名（`kifus.title` は varchar(255)） */
export const KIFU_TITLE_MAX = 255;
/** 対局者名（`kifus.sente` / `kifus.gote` は varchar(100)） */
export const KIFU_PLAYER_MAX = 100;
/** 対局結果（`kifus.result` は varchar(50)） */
export const KIFU_RESULT_MAX = 50;
/**
 * KIF の本文の文字数。長い対局（数百手）にコメントが付いても数万字なので、十分に余裕を持たせた値
 */
export const KIF_TEXT_MAX = 500_000;
/** メモの文字数 */
export const KIFU_MEMO_MAX = 10_000;
/**
 * 取り込みの本文の大きさ（バイト）。KIF の上限の字数がすべて 3 バイトの文字（UTF-8 の日本語）でも収まる大きさ
 */
export const KIFU_CREATE_BODY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 文字列を `max` 文字（コードポイント。Postgres の `varchar(n)` が数える単位）までに切り詰める。
 * null はそのまま返す。サロゲートペアを途中で切らない
 */
export function truncateChars<T extends string | null>(value: T, max: number): T {
  if (value === null) return value;
  // `length`（UTF-16 の単位）が max 以下なら、コードポイントの数も max 以下
  if (value.length <= max) return value;
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  return chars.slice(0, max).join('') as T;
}
