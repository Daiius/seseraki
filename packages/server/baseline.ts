// 既に稼働している DB を drizzle マイグレーション管理下に載せる一回限りの初期化。
//
// drizzle/0000（現行スキーマのベースライン）を「SQL を実行せず適用済みとして記録」する。
// これにより以降の `pnpm db:migrate` は 0000 を飛ばして 0001 以降だけを流す。
// 適用判定は名前ベースなので、記録するのは 0000 の name で十分
// （hash / created_at も migrator と同じ値で入れておく）。
//
// 【安全確認】記録前に、対象 DB が 0000 のスキーマ（テーブル・カラム・NOT NULL・
// PRIMARY/UNIQUE/INDEX・FK と ON DELETE）を実際に備えているかを information_schema で検証する。
// 空 DB / 接続先の取り違え / schema drift のときは何も記録せず異常終了する（誤って baseline を
// 打つと、以後 db:migrate が 0000 の CREATE TABLE を恒久スキップし、テーブル・制約が欠けたまま
// 後続を適用してしまうため）。
// ※ 型・default の厳密一致は正規化差（serial→auto_increment 等）で正当な本番 DB を誤って
//   止めるリスクがあるため比較しない。存在・NULL 制約・PK/UNIQUE/INDEX・FK+削除規則を検証する。
//
// 冪等: 既に 0000 が記録済みなら何もしない。
// 新規 DB では不要（db:migrate が 0000 から順に流す）。
//
// 実行: pnpm db:baseline（本番は DDL/INSERT 可能な管理ユーザで）

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { db, client } from './src/db/index.js';

const MIGRATIONS_TABLE = '__drizzle_migrations';

interface ExpectedSchema {
  /** テーブル名 → (カラム名 → NOT NULL か) */
  tables: Map<string, Map<string, boolean>>;
  /** 名前付き UNIQUE / 通常 INDEX 名（PRIMARY は別途チェック） */
  indexes: Set<string>;
  /** FK 制約名 → ON DELETE の規則（例 "CASCADE"） */
  fks: Map<string, string>;
}

/** 0000 の SQL 文からテーブル・カラム・INDEX・FK の期待値を取り出す */
function parseExpected(statements: string[]): ExpectedSchema {
  const tables = new Map<string, Map<string, boolean>>();
  const indexes = new Set<string>();
  const fks = new Map<string, string>();

  for (const stmt of statements) {
    const ct = stmt.match(/CREATE TABLE\s+`([^`]+)`\s*\(([\s\S]*)\)/i);
    if (ct) {
      const cols = new Map<string, boolean>();
      for (const raw of ct[2].split('\n')) {
        const line = raw.trim().replace(/,$/, '');
        const col = line.match(/^`([^`]+)`\s+(.+)$/);
        if (col) {
          const notNull =
            /\bNOT NULL\b/i.test(line) ||
            /\bPRIMARY KEY\b/i.test(line) ||
            /\bserial\b/i.test(col[2]);
          cols.set(col[1], notNull);
        } else {
          const uq = line.match(/^CONSTRAINT\s+`([^`]+)`\s+UNIQUE/i);
          if (uq) indexes.add(uq[1]);
        }
      }
      tables.set(ct[1], cols);
      continue;
    }
    const ci = stmt.match(/CREATE\s+INDEX\s+`([^`]+)`/i);
    if (ci) {
      indexes.add(ci[1]);
      continue;
    }
    const fk = stmt.match(
      /ADD CONSTRAINT\s+`([^`]+)`\s+FOREIGN KEY[\s\S]*?ON DELETE\s+(\w+)/i,
    );
    if (fk) fks.set(fk[1], fk[2].toUpperCase());
  }
  return { tables, indexes, fks };
}

try {
  const migrations = readMigrationFiles({ migrationsFolder: './drizzle' });
  const baseline = migrations[0];
  if (!baseline) {
    throw new Error('drizzle/ に 0000 ベースラインが見つかりません（先に db:generate）');
  }

  // --- 安全確認: 対象 DB が 0000 のスキーマを実際に備えているか ---
  const expected = parseExpected(baseline.sql);
  if (expected.tables.size === 0) {
    throw new Error('0000 に CREATE TABLE が見当たりません（ベースライン生成を確認）');
  }

  const missing: string[] = [];

  // カラム存在 + NOT NULL 制約
  const [colRows] = await db.execute(sql`
    SELECT TABLE_NAME AS t, COLUMN_NAME AS c, IS_NULLABLE AS n
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
  `);
  const actualCols = new Map<string, Map<string, string>>();
  for (const r of colRows as { t: string; c: string; n: string }[]) {
    if (!actualCols.has(r.t)) actualCols.set(r.t, new Map());
    actualCols.get(r.t)!.set(r.c, r.n);
  }
  for (const [table, cols] of expected.tables) {
    const got = actualCols.get(table);
    if (!got) {
      missing.push(`テーブル ${table} が存在しない`);
      continue;
    }
    for (const [col, notNull] of cols) {
      if (!got.has(col)) {
        missing.push(`${table}.${col} が存在しない`);
      } else if (notNull && got.get(col) === 'YES') {
        missing.push(`${table}.${col} は NOT NULL のはずが nullable`);
      }
    }
  }

  // PRIMARY / UNIQUE / INDEX
  const [idxRows] = await db.execute(sql`
    SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS i
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
  `);
  const idxByTable = new Map<string, Set<string>>();
  const allIdx = new Set<string>();
  for (const r of idxRows as { t: string; i: string }[]) {
    if (!idxByTable.has(r.t)) idxByTable.set(r.t, new Set());
    idxByTable.get(r.t)!.add(r.i);
    allIdx.add(r.i);
  }
  for (const table of expected.tables.keys()) {
    if (actualCols.has(table) && !idxByTable.get(table)?.has('PRIMARY')) {
      missing.push(`テーブル ${table} に PRIMARY KEY が無い`);
    }
  }
  for (const idx of expected.indexes) {
    if (!allIdx.has(idx)) missing.push(`インデックス ${idx} が存在しない`);
  }

  // FK + ON DELETE 規則
  const [fkRows] = await db.execute(sql`
    SELECT CONSTRAINT_NAME AS n, DELETE_RULE AS d
    FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
  `);
  const actualFk = new Map<string, string>();
  for (const r of fkRows as { n: string; d: string }[]) actualFk.set(r.n, r.d);
  for (const [name, rule] of expected.fks) {
    if (!actualFk.has(name)) {
      missing.push(`外部キー ${name} が存在しない`);
    } else if (actualFk.get(name)!.toUpperCase() !== rule) {
      missing.push(
        `外部キー ${name} の ON DELETE が ${actualFk.get(name)}（期待 ${rule}）`,
      );
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
