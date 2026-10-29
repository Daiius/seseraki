/**
 * 棋譜の番号（`kifus.displayNo`。prd/14 §4.4）を振って棋譜を作る。
 *
 * 🔴 **`kifus` を作る経路はすべてここの `insertKifu` を通す**（KIF/CSA の貼り付け・動画解析の取り込み・
 * seed・テストのフィクスチャ）。`kifu-number.test.ts` が「`insert(kifus)` はこのモジュールだけ」を検査する。
 *
 * - 番号は所有者ごとの連番。所有者の `users.lastKifuNo` を `UPDATE … RETURNING` で 1 進めて振る。
 *   **その行のロックで同じユーザーの取り込みどうしが順に並ぶ**（他のユーザーは待たない）。
 *   ロックは呼び出し側のトランザクションの終わりまで持つので、棋譜の挿入と同じ tx で呼ぶこと
 * - 🔒 **消した番号は再利用しない**（欠番を許す）。カウンタは減らさない。
 *   ⚠ `max(displayNo) + 1` で振らない——末尾を消すと同じ番号がまた振られ、古いメモの「42 番」が別の棋譜を指す
 * - ⚠ カウンタを進めると `users.updated_at` もトリガーで進む（取り込みの時刻になる）
 *
 * tx はログインの経路（ユーザーとして開いた tx）でも system ロールの tx でもよい。`users` には
 * RLS を掛けていない（Better Auth の表）ので、どちらでも所有者の行を進められる。
 */
import { eq, sql } from 'drizzle-orm';
import type { Tx } from './db/index.js';
import { kifus, users } from './db/schema.js';

/** 所有者の次の棋譜番号を振る（カウンタを 1 進める）。所有者の行が無ければ投げる */
export async function allocateKifuNo(q: Tx, ownerId: string): Promise<number> {
  const [row] = await q
    .update(users)
    .set({ lastKifuNo: sql`${users.lastKifuNo} + 1` })
    .where(eq(users.id, ownerId))
    .returning({ no: users.lastKifuNo });
  if (!row) throw new Error(`棋譜の番号を振れない: ユーザー ${ownerId} が無い`);
  return row.no;
}

export type NewKifu = Omit<typeof kifus.$inferInsert, 'id' | 'displayNo'>;

/**
 * 棋譜を 1 局作る（番号を振ってから挿入する）。内部 ID と番号を返す。
 * ⚠ 呼び出し側のトランザクションの中で呼ぶ（番号の割り当てと挿入を 1 つにする）
 */
export async function insertKifu(
  q: Tx,
  values: NewKifu,
): Promise<{ id: number; displayNo: number }> {
  const displayNo = await allocateKifuNo(q, values.ownerId);
  const [row] = await q
    .insert(kifus)
    .values({ ...values, displayNo })
    .returning({ id: kifus.id, displayNo: kifus.displayNo });
  return row;
}
