/**
 * ログインの経路のルート（`routes/*.ts`）が共有するパス引数・本文の上限。
 */
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { BROWSER_ANALYSIS_LIMITS } from 'shared';
import { apiError } from '../api-error.js';
import { KIFU_CREATE_BODY_MAX_BYTES } from '../kifu-input.js';
import { positiveInt4 } from '../params.js';

/**
 * 棋譜の番号（`kifus.displayNo`。所有者ごとの連番。prd/14 §4.4）。
 * ⚠ 整数でない・正でない・列（`integer`）に収まらない値は 400
 * （`z.coerce.number()` だけだと `1.5` や `NaN` が素通りし、範囲外は DB で 500 になる）
 */
export const kifuNo = positiveInt4;
export const kifuNoParam = z.object({ no: kifuNo });

/**
 * 出題を指すパス引数（棋譜の番号・手数・種類。prd/14 §4.4）。`drills` の一意制約と同じ組。
 * `moveNumber` は出題局面（その手を指す前の局面）
 */
export const drillRefParam = z.object({
  kifuNo,
  moveNumber: z.coerce.number<number>().int().min(0).max(10_000),
  kind: z.enum(['mate', 'best']),
});

/** `YYYY-MM-DD` の日付。名前候補の有効期間（prd/11 §5） */
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * 有効期間は**組として**成り立っていないといけない。
 *
 * 🔴 **逆転した期間（開始 > 終了）を保存すると、その候補は日時のある全棋譜で不活性になり、
 * 同じトランザクションの再導出で `subjectSide` が NULL に落ちる**——成績からも
 * 自分視点の表示からも**静かに脱落する**。個々の値が日付として正しいだけでは足りない。
 */
// ⚠ zod 4 の `z.ZodType<T>` は入力の型が `unknown` になり RPC の入力の型が消えるので、スキーマの型ごと受ける
export const periodRefine = <S extends z.ZodType<{ validFrom?: string | null; validTo?: string | null }>>(
  schema: S,
) =>
  schema.refine((v) => !v.validFrom || !v.validTo || v.validFrom <= v.validTo, {
    error: '期間が逆転している（validTo は validFrom 以降）',
    path: ['validTo'],
  });

/**
 * 本文の大きさの上限（prd/14 §6.2）。超えたら 413（zod の検証より前に、読み切る前に断る）。
 * ブラウザ解析の受け口・担当の切り替え・出題の解答（prd/14 §5.7・§5.8・prd/13 §5.3）・メモに付ける
 */
export const smallBody = bodyLimit({
  maxSize: BROWSER_ANALYSIS_LIMITS.bodyMaxBytes,
  onError: (c) => apiError(c, 413, 'body_too_large'),
});

/** 棋譜の取り込みの本文の上限（KIF の本文を載せるので `smallBody` より大きい）。超えたら 413 */
export const kifuCreateBody = bodyLimit({
  maxSize: KIFU_CREATE_BODY_MAX_BYTES,
  onError: (c) => apiError(c, 413, 'body_too_large'),
});
