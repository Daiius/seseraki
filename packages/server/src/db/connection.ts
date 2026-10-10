import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { relations } from './schema.js';

/**
 * 接続の設定と drizzle の組み立て（**プールを作らない**）。ロールの使い分けは `index.ts` の冒頭。
 * プールを作るのは `index.ts`（server ロール）と `system.ts`（system ロール）と `migrate.ts`（管理ロール）で、
 * 互いを import しない——import しただけで別のロールのプールが作られないように。
 */
export type DbRole = 'server' | 'admin' | 'system';

/** ロールごとの資格情報の環境変数 */
const CREDENTIAL_ENV: Record<DbRole, { user: string; password: string }> = {
  server: { user: 'DB_USER', password: 'DB_PASSWORD' },
  admin: { user: 'DB_ADMIN_USER', password: 'DB_ADMIN_PASSWORD' },
  system: { user: 'DB_SYSTEM_USER', password: 'DB_SYSTEM_PASSWORD' },
};

/**
 * 接続設定。🔒 **system ロールは資格情報が無ければ throw する（fail-closed）**——未設定のまま
 * 別のロール（libpq の既定ユーザーなど）で繋がると、RLS で 0 行になって worker の報告が黙って消える。
 */
export function connectionConfig(role: DbRole, env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  const names = CREDENTIAL_ENV[role];
  const user = env[names.user];
  const password = env[names.password];
  if (role === 'system' && (!user || !password)) {
    throw new Error(
      `${names.user} / ${names.password}（RLS を迂回する system ロール。prd/15 §2）が未設定です`,
    );
  }
  return {
    host: env.DB_HOST ?? 'localhost',
    port: env.DB_PORT ? Number(env.DB_PORT) : 5432,
    database: env.DB_NAME ?? 'seseraki',
    user,
    password,
  };
}

/** プールから drizzle を組み立てる（server 用の `db` と、migrate・実 DB テストが同じ形で使う） */
export function createDb(client: pg.Pool) {
  return drizzle({ client, relations });
}

export type Db = ReturnType<typeof createDb>;

/**
 * `db.transaction` のコールバックが受け取るトランザクションハンドル。
 * 手で型を書くと drizzle の更新で静かにずれるので、**db から導出する**。
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
