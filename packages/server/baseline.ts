// 既に稼働している DB を drizzle マイグレーション管理下に載せる一回限りの初期化。
//
// drizzle/0000（現行スキーマのベースライン）を「SQL を実行せず適用済みとして記録」する。
// これにより以降の `pnpm db:migrate` は 0000 を飛ばして 0001 以降だけを流す。
// 適用判定は名前ベースなので、記録するのは 0000 の name で十分
// （hash / created_at も migrator と同じ値で入れておく）。
//
// 【安全確認】記録前に、対象 DB が 0000 のスキーマを実際に備えているかを information_schema で検証する。
// テーブル・カラム・NOT NULL に加え、PRIMARY / UNIQUE / 通常 INDEX と FK を「名前だけでなく構造
// （対象テーブル・順序付き列・UNIQUE 性・FK の子/参照テーブル・列・ON DELETE 規則）」まで照合する。
// 空 DB / 接続先の取り違え / schema drift のときは何も記録せず異常終了する（誤って baseline を
// 打つと、以後 db:migrate が 0000 の CREATE TABLE を恒久スキップし、制約が欠けたまま後続を適用するため）。
// ※ 列の型・default の厳密一致は正規化差（serial→auto_increment 等）で正当な本番 DB を誤って止める
//   リスクがあるため比較しない。存在・NULL 制約・PK/UNIQUE/INDEX 構造・FK 構造を検証する。
//
// 冪等: 既に 0000 が記録済みなら何もしない。新規 DB では不要（db:migrate が 0000 から順に流す）。
// 実行: pnpm db:baseline（本番は DDL/INSERT 可能な管理ユーザで）

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { db, client } from './src/db/index.js';

const MIGRATIONS_TABLE = '__drizzle_migrations';

interface IndexDef {
  table: string;
  unique: boolean;
  columns: string[]; // 順序付き
}
interface FkDef {
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  deleteRule: string;
}
interface ExpectedSchema {
  tables: Map<string, Map<string, boolean>>; // table -> (col -> NOT NULL)
  indexes: Map<string, IndexDef>; // `table.indexName` -> def（PRIMARY 含む）
  fks: Map<string, FkDef>; // fk name -> def
}

/** バッククォート識別子の並びを配列で取り出す（例: "`a`,`b`" -> ["a","b"]） */
function backticked(s: string): string[] {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** 0000 の SQL からテーブル・カラム・INDEX・FK の期待構造を取り出す */
function parseExpected(statements: string[]): ExpectedSchema {
  const tables = new Map<string, Map<string, boolean>>();
  const indexes = new Map<string, IndexDef>();
  const fks = new Map<string, FkDef>();

  for (const stmt of statements) {
    const ct = stmt.match(/CREATE TABLE\s+`([^`]+)`\s*\(([\s\S]*)\)/i);
    if (ct) {
      const table = ct[1];
      const cols = new Map<string, boolean>();
      const pk: string[] = [];
      for (const raw of ct[2].split('\n')) {
        const line = raw.trim().replace(/,$/, '');
        const col = line.match(/^`([^`]+)`\s+(.+)$/);
        if (col) {
          const isPk = /\bPRIMARY KEY\b/i.test(line);
          const notNull =
            isPk || /\bNOT NULL\b/i.test(line) || /\bserial\b/i.test(col[2]);
          cols.set(col[1], notNull);
          if (isPk) pk.push(col[1]);
        } else {
          const uq = line.match(/^CONSTRAINT\s+`([^`]+)`\s+UNIQUE[^(]*\(([^)]*)\)/i);
          if (uq) {
            indexes.set(`${table}.${uq[1]}`, {
              table,
              unique: true,
              columns: backticked(uq[2]),
            });
          }
        }
      }
      tables.set(table, cols);
      if (pk.length > 0) {
        indexes.set(`${table}.PRIMARY`, { table, unique: true, columns: pk });
      }
      continue;
    }
    const ci = stmt.match(/CREATE\s+INDEX\s+`([^`]+)`\s+ON\s+`([^`]+)`\s*\(([^)]*)\)/i);
    if (ci) {
      indexes.set(`${ci[2]}.${ci[1]}`, {
        table: ci[2],
        unique: false,
        columns: backticked(ci[3]),
      });
      continue;
    }
    const fk = stmt.match(
      /ALTER TABLE\s+`([^`]+)`\s+ADD CONSTRAINT\s+`([^`]+)`\s+FOREIGN KEY\s*\(([^)]*)\)\s+REFERENCES\s+`([^`]+)`\s*\(([^)]*)\)\s+ON DELETE\s+(\w+)/i,
    );
    if (fk) {
      fks.set(fk[2], {
        table: fk[1],
        columns: backticked(fk[3]),
        refTable: fk[4],
        refColumns: backticked(fk[5]),
        deleteRule: fk[6].toUpperCase(),
      });
    }
  }
  return { tables, indexes, fks };
}

const eqArr = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

try {
  const migrations = readMigrationFiles({ migrationsFolder: './drizzle' });
  const baseline = migrations[0];
  if (!baseline) {
    throw new Error('drizzle/ に 0000 ベースラインが見つかりません（先に db:generate）');
  }

  const expected = parseExpected(baseline.sql);
  if (expected.tables.size === 0) {
    throw new Error('0000 に CREATE TABLE が見当たりません（ベースライン生成を確認）');
  }

  const missing: string[] = [];

  // --- カラム存在 + NOT NULL 制約 ---
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
      if (!got.has(col)) missing.push(`${table}.${col} が存在しない`);
      else if (notNull && got.get(col) === 'YES')
        missing.push(`${table}.${col} は NOT NULL のはずが nullable`);
    }
  }

  // --- PRIMARY / UNIQUE / 通常 INDEX の構造（対象列順・UNIQUE 性）---
  const [idxRows] = await db.execute(sql`
    SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS nu,
           SEQ_IN_INDEX AS seq, COLUMN_NAME AS c
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
  `);
  const actualIdx = new Map<string, { unique: boolean; columns: string[] }>();
  for (const r of idxRows as { t: string; i: string; nu: number; seq: number; c: string }[]) {
    const key = `${r.t}.${r.i}`;
    if (!actualIdx.has(key))
      actualIdx.set(key, { unique: Number(r.nu) === 0, columns: [] });
    actualIdx.get(key)!.columns[Number(r.seq) - 1] = r.c;
  }
  for (const [key, def] of expected.indexes) {
    const got = actualIdx.get(key);
    if (!got) missing.push(`インデックス ${key} が存在しない`);
    else if (got.unique !== def.unique)
      missing.push(`インデックス ${key} の UNIQUE 性が不一致（実 ${got.unique}）`);
    else if (!eqArr(got.columns, def.columns))
      missing.push(`インデックス ${key} の対象列が不一致（実 ${got.columns.join(',')} / 期待 ${def.columns.join(',')}）`);
  }

  // --- FK の構造（子表・子列・参照表・参照列・ON DELETE 規則）---
  const [fkRows] = await db.execute(sql`
    SELECT rc.CONSTRAINT_NAME AS n, rc.DELETE_RULE AS d,
           kcu.TABLE_NAME AS t, kcu.COLUMN_NAME AS c,
           kcu.REFERENCED_TABLE_NAME AS rt, kcu.REFERENCED_COLUMN_NAME AS rcol,
           kcu.ORDINAL_POSITION AS pos
    FROM information_schema.REFERENTIAL_CONSTRAINTS rc
    JOIN information_schema.KEY_COLUMN_USAGE kcu
      ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
     AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
    WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
    ORDER BY rc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
  `);
  const actualFk = new Map<string, FkDef>();
  for (const r of fkRows as {
    n: string; d: string; t: string; c: string; rt: string; rcol: string; pos: number;
  }[]) {
    if (!actualFk.has(r.n))
      actualFk.set(r.n, { table: r.t, columns: [], refTable: r.rt, refColumns: [], deleteRule: r.d.toUpperCase() });
    const f = actualFk.get(r.n)!;
    f.columns[Number(r.pos) - 1] = r.c;
    f.refColumns[Number(r.pos) - 1] = r.rcol;
  }
  for (const [name, def] of expected.fks) {
    const got = actualFk.get(name);
    if (!got) {
      missing.push(`外部キー ${name} が存在しない`);
    } else {
      if (got.table !== def.table || !eqArr(got.columns, def.columns))
        missing.push(`外部キー ${name} の子（表.列）が不一致（実 ${got.table}.${got.columns.join(',')}）`);
      if (got.refTable !== def.refTable || !eqArr(got.refColumns, def.refColumns))
        missing.push(`外部キー ${name} の参照先が不一致（実 ${got.refTable}.${got.refColumns.join(',')}）`);
      if (got.deleteRule !== def.deleteRule)
        missing.push(`外部キー ${name} の ON DELETE が ${got.deleteRule}（期待 ${def.deleteRule}）`);
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
