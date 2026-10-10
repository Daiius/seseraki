import pg from 'pg';
import { connectionConfig, createDb } from './connection.js';

/**
 * DB 接続（Postgres。node-postgres + drizzle。prd/15 §2）。
 *
 * **ロールを 3 つに分ける**（prd/15 §2・prd/14 §4「RLS の形」）:
 * - **server ロール**（DML のみ・RLS が効く）… 常駐の server のログインの経路。`DB_USER` / `DB_PASSWORD`。
 *   このファイルの `db`。リクエストごとに `user-tx.ts` がユーザーとして tx を開く
 * - **system ロール**（DML のみ・BYPASSRLS）… 全員ぶんを扱う経路（worker の報告・動画解析の取り込み・
 *   一括処理のエントリ）。`DB_SYSTEM_USER` / `DB_SYSTEM_PASSWORD`。別のプール（`db/system.ts`）
 * - **管理ロール**（DDL）… マイグレーションの適用（`migrate.ts`）だけ。`DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`
 *
 * 接続先（`DB_HOST` / `DB_PORT` / `DB_NAME`）は共通。ホストから dev の DB へ繋ぐ `*:dev` の scripts は
 * `DB_HOST=localhost` だけを差し替える（`scripts/db-forward.sh` が都度 port-forward する）。
 *
 * ⭐ 日時は `timestamptz` なので、**接続の時刻帯に依存しない**（MySQL の頃にあった
 * 「セッションを UTC に固定する」処理と自前の typeCast は要らなくなった。prd/03 §1.1）。
 * ⚠ **node-postgres は bigint（`count(*)`・`sum(…)`）を文字列で返す。** 列ではなく `sql` 断片で
 * 集計を取るときは `.mapWith(Number)` を通す（prd/15 §3.5）。
 */
export { connectionConfig, createDb, type Db, type DbRole, type Tx } from './connection.js';

/**
 * server ロールの接続（RLS が効く。ログインの経路）。接続は最初のクエリまで張られない（import しただけでは繋がない）。
 * 🔒 ログインの経路でこれを直接使ってよいのは `user-tx.ts` だけ（`db-import-boundary.test.ts`）
 */
export const client = new pg.Pool(connectionConfig('server'));

export const db = createDb(client);
