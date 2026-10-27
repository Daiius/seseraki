/**
 * `@hono/zod-validator` の `zValidator` に、検証失敗の 400 の本文を zod 3 のときの形にそろえるフックを既定で付けたもの。
 *
 * ⚠ zod 4 の `ZodError` は `issues` を JSON に出さない（`message` に issues を文字列にしたものが入る）。既定のままだと
 * 400 の本文が `{ success: false, error: { issues: [...], name: 'ZodError' } }` から変わるので、ここで同じ形に組み直す。
 * issue の中身（文言など）は zod 4 のもの。フックを渡したときはそちらを使う。
 */
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const failureAsBefore = (result: { success: boolean; error?: unknown }, c: Context) => {
  if (!result.success && result.error instanceof z.ZodError) {
    return c.json({ success: false, error: { issues: result.error.issues, name: 'ZodError' } }, 400);
  }
};

type Args = Parameters<typeof zValidator>;

// 型は `zValidator` のまま（RPC の入力・出力の型を変えない）。実体だけ既定のフックを差し込む
export const zv = ((target: Args[0], schema: Args[1], hook?: Args[2], options?: Args[3]) =>
  zValidator(target, schema, hook ?? failureAsBefore, options)) as typeof zValidator;
