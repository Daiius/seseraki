/**
 * **全員ぶんを扱う経路の接続**（RLS を迂回する system ロール。prd/14 §4「RLS の形」・prd/15 §2）。
 *
 * worker の報告・動画解析の取り込み（API_KEY）と一括処理のエントリは、ユーザーとして動かない。
 * これらは BYPASSRLS のロール（`DB_SYSTEM_USER` / `DB_SYSTEM_PASSWORD`）で、**リクエスト用のプール
 * （server ロール。`db/index.ts` の `db`）とは別のプール**で繋ぐ。取り違えを接続の単位で防ぐため。
 *
 * 🔒 **ログインの経路から import しない**（`db-import-boundary.test.ts` が許可リストで検査する）。
 * 🔒 **環境変数が無ければ throw する（fail-closed）。** 未設定のまま server ロールなどで繋ぐと、
 *   worker の報告が RLS で 0 行になり**エラーにならずに黙って何もしない**。常駐 server は起動時に
 *   {@link systemDb} を呼んで、設定漏れを起動の失敗として出す（`src/index.ts`）。
 *   プールは最初に呼んだときに作る（import しただけでは env を読まない——unit テストが route を読めるように）。
 * ⚠ ロールはマイグレーションでは作らない（BYPASSRLS の付与には superuser が要る）。
 *   dev は `scripts/postgres-init/20-system-role.sh`、本番は手順で作る（prd/15 §2）。
 */
import pg from 'pg';
import { connectionConfig, createDb, type Db } from './connection.js';

let pool: pg.Pool | null = null;
let instance: Db | null = null;

/** system ロールの drizzle。初回にプールを作る。`DB_SYSTEM_USER` / `DB_SYSTEM_PASSWORD` が無ければ throw */
export function systemDb(): Db {
  if (!instance) {
    pool = new pg.Pool(connectionConfig('system'));
    instance = createDb(pool);
  }
  return instance;
}

/** 一括処理のエントリの後始末（プールを閉じる。作っていなければ何もしない） */
export async function endSystemDb(): Promise<void> {
  await pool?.end();
  pool = null;
  instance = null;
}
