/**
 * パス引数・本文の数値の共通の形。
 *
 * ⚠ `z.coerce.number()` だけだと `NaN`・`1.5`・列（`integer`）に収まらない値が素通りし、
 * DB に届いてから 500 になる。整数・正・int4 の上限までを 400 で断る。
 */
import { z } from 'zod';

/** Postgres の `integer` の上限 */
export const INT4_MAX = 2_147_483_647;

/** 正の int4（棋譜の番号・名前候補の ID・worker の経路の棋譜 ID）。パス引数の文字列も数に直す */
export const positiveInt4 = z.coerce.number<number>().int().positive().max(INT4_MAX);

/** `:id` のパス引数（正の int4） */
export const idParam = z.object({ id: positiveInt4 });
