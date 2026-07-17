// drizzle-kit generate で作った drizzle/*.sql を順に適用する（バージョン管理マイグレーション）。
//
// __drizzle_migrations テーブルに未記録のマイグレーションだけを流す
// （判定は名前ベース。drizzle-orm/mysql2 migrator に従う）。
// 本番は DDL 権限を持つ管理ユーザで実行する前提。
//
// 既存 DB を初めて管理下に載せる時は、先に `pnpm db:baseline` で 0000 を
// 「適用済み」登録してから実行すること（さもないと 0000 の CREATE TABLE が
// 既存テーブルに衝突する）。新規 DB では baseline 不要でそのまま流せる。
//
// 実行: pnpm db:migrate（接続先は DB_HOST / DB_PORT / MYSQL_* 環境変数）

import { migrate } from 'drizzle-orm/mysql2/migrator';
import { db, client } from './src/db/index.js';

// 一発限りの CLI。処理は各文 autocommit 済みなので、完了後はプールの
// 終了待ちに頼らず明示的に exit する（cloudflared tunnel 越しだと client.end() の
// ソケット close が返らずプロセスが終了しないことがあるため）。
try {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('migrations applied (up to date)');
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
