// 既に稼働している DB を drizzle マイグレーション管理下に載せる一回限りの初期化。
//
// drizzle/0000（現行スキーマのベースライン）を「SQL を実行せず適用済みとして記録」する。
// これにより以降の `pnpm db:migrate` は 0000 を飛ばして 0001 以降だけを流す。
// 適用判定は名前ベースなので、記録するのは 0000 の name で十分
// （hash / created_at も migrator と同じ値で入れておく）。
//
// 冪等: 既に 0000 が記録済みなら何もしない。
// 新規 DB では不要（db:migrate が 0000 から順に流す）。
//
// 実行: pnpm db:baseline（本番は DDL/INSERT 可能な管理ユーザで）

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { db, client } from './src/db/index.js';

const MIGRATIONS_TABLE = '__drizzle_migrations';

try {
  const migrations = readMigrationFiles({ migrationsFolder: './drizzle' });
  const baseline = migrations[0];
  if (!baseline) {
    throw new Error('drizzle/ に 0000 ベースラインが見つかりません（先に db:generate）');
  }

  // migrator が使うのと同一スキーマで作成（無ければ）
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATIONS_TABLE)} (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT,
      name TEXT,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [rows] = await db.execute(
    sql`SELECT name FROM ${sql.identifier(MIGRATIONS_TABLE)} WHERE name = ${baseline.name}`,
  );

  if (Array.isArray(rows) && rows.length > 0) {
    console.log(`already baselined: ${baseline.name} (何もしません)`);
  } else {
    await db.execute(sql`
      INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} (hash, created_at, name)
      VALUES (${baseline.hash}, ${baseline.folderMillis}, ${baseline.name})
    `);
    console.log(`baseline recorded: ${baseline.name}（DDL は実行していません）`);
  }
} finally {
  await client.end();
}
