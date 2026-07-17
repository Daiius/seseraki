// 既に稼働している DB を drizzle マイグレーション管理下に載せる一回限りの初期化。
//
// drizzle/0000（現行スキーマのベースライン）を「SQL を実行せず適用済みとして記録」する。
// これにより以降の `pnpm db:migrate` は 0000 を飛ばして 0001 以降だけを流す。
// 適用判定は名前ベースなので、記録するのは 0000 の name で十分
// （hash / created_at も migrator と同じ値で入れておく）。
//
// 【安全確認】記録前に、対象 DB が 0000 のテーブル・カラムを実際に備えているかを
// information_schema で検証する。空 DB / 接続先の取り違え / schema drift のときは
// 何も記録せず異常終了する（誤って baseline を打つと、以後 db:migrate が 0000 の
// CREATE TABLE を恒久スキップし、テーブル・カラムが欠けたまま後続を適用してしまうため）。
//
// 冪等: 既に 0000 が記録済みなら何もしない。
// 新規 DB では不要（db:migrate が 0000 から順に流す）。
//
// 実行: pnpm db:baseline（本番は DDL/INSERT 可能な管理ユーザで）

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { db, client } from './src/db/index.js';

const MIGRATIONS_TABLE = '__drizzle_migrations';

/** 0000 の CREATE TABLE 文から テーブル名 → カラム名集合 を取り出す */
function expectedSchema(statements: string[]): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const stmt of statements) {
    const head = stmt.match(/CREATE TABLE\s+`([^`]+)`\s*\(/i);
    if (!head) continue;
    const table = head[1];
    const columns = new Set<string>();
    for (const rawLine of stmt.slice(head.index! + head[0].length).split('\n')) {
      const line = rawLine.trim();
      // カラム行は バッククォート識別子で始まる。CONSTRAINT/PRIMARY KEY 等は除外
      const col = line.match(/^`([^`]+)`\s+\S/);
      if (col) columns.add(col[1]);
    }
    tables.set(table, columns);
  }
  return tables;
}

try {
  const migrations = readMigrationFiles({ migrationsFolder: './drizzle' });
  const baseline = migrations[0];
  if (!baseline) {
    throw new Error('drizzle/ に 0000 ベースラインが見つかりません（先に db:generate）');
  }

  // --- 安全確認: 対象 DB が 0000 のスキーマを実際に備えているか ---
  const expected = expectedSchema(baseline.sql);
  if (expected.size === 0) {
    throw new Error('0000 に CREATE TABLE が見当たりません（ベースライン生成を確認）');
  }
  const [actualRows] = await db.execute(sql`
    SELECT TABLE_NAME as t, COLUMN_NAME as c
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
  `);
  const actual = new Map<string, Set<string>>();
  for (const row of actualRows as { t: string; c: string }[]) {
    if (!actual.has(row.t)) actual.set(row.t, new Set());
    actual.get(row.t)!.add(row.c);
  }
  const missing: string[] = [];
  for (const [table, cols] of expected) {
    const got = actual.get(table);
    if (!got) {
      missing.push(`テーブル ${table} が存在しない`);
      continue;
    }
    for (const col of cols) {
      if (!got.has(col)) missing.push(`${table}.${col} が存在しない`);
    }
  }
  if (missing.length > 0) {
    const dbHint = `DB_HOST=${process.env.DB_HOST ?? '(unset)'} DB=${process.env.MYSQL_DATABASE ?? '(unset)'}`;
    throw new Error(
      `対象 DB は 0000 のスキーマを備えていません。空 DB / 接続先取り違え / schema drift の可能性があるため baseline を中止します（${dbHint}）。\n` +
        `新規 DB なら baseline は不要で db:migrate が 0000 から流します。\n不足:\n  - ${missing.join('\n  - ')}`,
    );
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
