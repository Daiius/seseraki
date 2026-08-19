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
// **生成は drizzle-kit（dev 専用）、適用は drizzle-orm の migrator**（本番の実行時依存）。
// これにより本番イメージに drizzle-kit を入れずに適用でき、**dev と本番で適用経路が 1 本になる**
// ——本番で初めて走らせる経路が無くなる。
//
//   dev / ホストから … pnpm db:migrate    → tsx migrate.ts
//   本番イメージ内   … docker compose run → node /app/migrate.js
//
// ⚠ **このファイルはパッケージルート直下に置く**（`src/` ではない）。下の migrationsFolder を
// **このファイルからの相対**で解くため、`./drizzle` が dev では `packages/server/drizzle` を、
// バンドル後は `/app/drizzle` を指す必要がある。`src/` に置くと両者がずれる。

import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { db, client } from './src/db/index.js';

// ⚠ **cwd 相対にしない。** 実行のしかた（どこから叩くか）で壊れる。
// `pnpm --filter` は cwd を packages/server へ移すが、本番の使い捨てコンテナは WORKDIR 次第。
// ファイル相対なら dev もバンドル後も同じ場所を指す。
const migrationsFolder = fileURLToPath(new URL('./drizzle', import.meta.url));

// 一発限りの CLI。処理は各文 autocommit 済みなので、完了後はプールの
// 終了待ちに頼らず明示的に exit する（cloudflared tunnel 越しだと client.end() の
// ソケット close が返らずプロセスが終了しないことがあるため）。
try {
  await migrate(db, { migrationsFolder });
  console.log('migrations applied (up to date)');
  process.exit(0);
} catch (err) {
  // ⚠ `err.message` だけを出さない。drizzle の DrizzleQueryError は message が
  // 「Failed query: <SQL>」で、**本当の失敗理由（Access denied / 型不整合など）は
  // `cause` に連なっている**。message だけだと失敗した SQL しか見えず、権限エラーと
  // スキーマ不整合の区別すら付かない（2026-08-19 の本番適用で実際に踏んだ）。
  // console.error は Error をそのまま渡すと cause 連鎖まで再帰的に印字する。
  console.error(err);
  process.exit(1);
}
