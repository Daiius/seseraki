/**
 * ログインしたリクエストを「そのユーザーとして」DB に流す入口（所有者スコープ。prd/14 §4「RLS の形」）。
 *
 * リクエストごとにトランザクションを開き、最初に `set_config('app.user_id', <id>, true)` を流す
 * （`true` = そのトランザクションの間だけ。`SET LOCAL` と同じ）。プールの接続を使い回しても設定が
 * 次のリクエストに漏れない。ハンドラとクエリ関数はグローバルの `db` ではなく、ここで開いた tx を使う。
 *
 * 🔒 **ログインの経路でグローバルの `db` に触れてよいのはこのモジュールだけ**
 * （`db-import-boundary.test.ts` が import を検査する）。
 * 🔒 user id は**必ずセッションから**取る（呼び出し側の `sessionRequired`）。リクエスト本文・クエリ文字列から取らない。
 * ⚠ **長い待ち（エンジンの完了待ちなど外部の待ち）を tx の中に入れない。** 接続を握ったまま待つことになる。
 *   評価はジョブを積んで即座に返す（prd/12 §2.4）。
 */
import { sql } from 'drizzle-orm';
import { db, type Db, type Tx } from './db/index.js';

/**
 * `database` の上でトランザクションを開き、`app.user_id` を設定してから `fn` を流す。
 * 実 DB テストは自分の `Db` を渡して同じ形で呼ぶ。
 */
export async function withUserTx<T>(
  database: Db,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/** 常駐 server のリクエスト用（server ロールのプール） */
export function runAsUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withUserTx(db, userId, fn);
}
