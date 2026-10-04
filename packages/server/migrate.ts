// drizzle-kit generate で作った drizzle/*/migration.sql を順に適用する（バージョン管理マイグレーション）。
//
// drizzle.__drizzle_migrations に未記録のマイグレーションだけを流す
// （drizzle-orm/node-postgres の migrator に従う）。
// 🔒 **管理ロール（DDL）で実行する**（`DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`。prd/15 §2）。
// 常駐 server のロールには DDL の権限が無い。
// ⭐ Postgres は DDL もトランザクションに入るので、**途中で失敗したら丸ごと戻る**（prd/15 §5）。
//
// **生成は drizzle-kit（dev 専用）、適用は drizzle-orm の migrator**（本番の実行時依存）。
// これにより本番イメージに drizzle-kit を入れずに適用でき、**dev と本番で適用経路が 1 本になる**
// ——本番で初めて走らせる経路が無くなる。
//
//   dev / ホストから … pnpm db:migrate:dev → tsx migrate.ts
//   本番イメージ内   … docker compose run → node /app/migrate.js
//
// ⚠ **このファイルはパッケージルート直下に置く**（`src/` ではない）。下の migrationsFolder を
// **このファイルからの相対**で解くため、`./drizzle` が dev では `packages/server/drizzle` を、
// バンドル後は `/app/drizzle` を指す必要がある。`src/` に置くと両者がずれる。

import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { connectionConfig, createDb } from './src/db/index.js';

// ⚠ **cwd 相対にしない。** 実行のしかた（どこから叩くか）で壊れる。
// `pnpm --filter` は cwd を packages/server へ移すが、本番の使い捨てコンテナは WORKDIR 次第。
// ファイル相対なら dev もバンドル後も同じ場所を指す。
const migrationsFolder = fileURLToPath(new URL('./drizzle', import.meta.url));

const config = connectionConfig('admin');
if (!config.user) {
  console.error('DB_ADMIN_USER が未設定です（マイグレーションは管理ロールで流す。prd/15 §2）');
  process.exit(1);
}
const client = new pg.Pool({ ...config, max: 1 });

try {
  await migrate(createDb(client), { migrationsFolder });
  console.log('migrations applied (up to date)');
  await client.end();
  process.exit(0);
} catch (err) {
  // ⚠ `err.message` だけを出さない。drizzle の DrizzleQueryError は message が
  // 「Failed query: <SQL>」で、**本当の失敗理由（権限不足・型不整合など）は
  // `cause` に連なっている**。message だけだと失敗した SQL しか見えず、権限エラーと
  // スキーマ不整合の区別すら付かない（2026-08-19 の本番適用で実際に踏んだ）。
  // console.error は Error をそのまま渡すと cause 連鎖まで再帰的に印字する。
  console.error(err);
  process.exit(1);
}
