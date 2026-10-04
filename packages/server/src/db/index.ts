import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { relations } from './schema.js';

/**
 * DB 接続（Postgres。node-postgres + drizzle。prd/15 §2）。
 *
 * **ロールを 2 つに分ける**（prd/15 §2）:
 * - **server ロール**（DML のみ）… 常駐の server と一括処理のエントリ。`DB_USER` / `DB_PASSWORD`
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
export type DbRole = 'server' | 'admin';

export function connectionConfig(role: DbRole, env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  return {
    host: env.DB_HOST ?? 'localhost',
    port: env.DB_PORT ? Number(env.DB_PORT) : 5432,
    database: env.DB_NAME ?? 'seseraki',
    user: role === 'admin' ? env.DB_ADMIN_USER : env.DB_USER,
    password: role === 'admin' ? env.DB_ADMIN_PASSWORD : env.DB_PASSWORD,
  };
}

/** プールから drizzle を組み立てる（server 用の `db` と、migrate・実 DB テストが同じ形で使う） */
export function createDb(client: pg.Pool) {
  return drizzle({ client, relations });
}

/** server ロールの接続。接続は最初のクエリまで張られない（import しただけでは繋がない） */
export const client = new pg.Pool(connectionConfig('server'));

export const db = createDb(client);

export type Db = typeof db;
