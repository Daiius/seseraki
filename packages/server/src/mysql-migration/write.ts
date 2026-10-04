/**
 * データ移行の **Postgres 側**（prd/15 §6）。MySQL には依存しない——入力は `MigrationSource`
 * （本番は `mysql-source.ts`、実 DB テストは行を直接与える）。
 *
 * 🔒 **トランザクションは呼び出し側が持つ**（`BEGIN` してから `migrateInto` を呼び、結果を見て
 * `COMMIT` / `ROLLBACK` する）。ここは途中で `SAVEPOINT` を使うだけで、確定も取り消しもしない。
 *
 * 制約違反は**違反した行で止まらず全部列挙する**（prd/15 §6.4）。まとめて INSERT し、失敗した束だけ
 * `SAVEPOINT` まで戻して 1 行ずつ入れ直す（違反の無い大部分は速く、違反した行は行ごとに理由が取れる）。
 */
import type pg from 'pg';
import {
  compareCounts,
  ConversionError,
  convertRow,
  rowKey,
  type CountMismatch,
} from './convert.js';
import {
  EXPECTED_MIGRATION,
  MIGRATED_TABLES,
  OWNER_ID,
  SKIPPED_TABLES,
  type PlannedTable,
} from './plan.js';

/** 移行元。MySQL の読み取りと、テストの行の注入が同じ形を満たす */
export interface MigrationSource {
  /** 表ごとの件数（行を読むのと同じ時点のもの） */
  counts(tables: readonly string[]): Promise<Record<string, number>>;
  /** 表の行を束で返す。列は `columns` の名前をキーに持つ */
  rows(table: string, columns: readonly string[]): AsyncIterable<Record<string, unknown>[]>;
}

export interface Violation {
  table: string;
  /** 行を示す PK（`id=12` など） */
  key: string;
  /** 制約名。変換できなかった値は `conversion`、所有者の行が移行元に無ければ `owner_missing` */
  constraint: string;
  /** SQLSTATE（23503 = FK・23514 = CHECK・23505 = UNIQUE・23502 = NOT NULL） */
  code?: string;
  message: string;
}

export interface MigrationReport {
  /** 移行元の表ごとの件数 */
  sourceCounts: Record<string, number>;
  /** 書き込み後の移行先の表ごとの件数 */
  targetCounts: Record<string, number>;
  violations: Violation[];
  mismatches: CountMismatch[];
  /** identity の採番を合わせた結果（表 → 次に振られる値） */
  sequences: Record<string, number>;
}

/** 移行先が条件を満たさない（中止する）。何も書いていない */
export class TargetNotReadyError extends Error {}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** pg のエラー（drizzle を通さないので素のまま来る） */
interface PgError {
  code?: string;
  constraint?: string;
  message: string;
  detail?: string;
}

function asViolation(table: string, key: string, err: unknown): Violation {
  if (err instanceof ConversionError) {
    return { table, key, constraint: 'conversion', message: err.message };
  }
  const e = err as PgError;
  return {
    table,
    key,
    constraint: e.constraint ?? '(なし)',
    code: e.code,
    message: e.detail ? `${e.message}（${e.detail}）` : e.message,
  };
}

/**
 * 移行先が「0000 適用済み・所有者の仮の行 `"1"` 以外は空」であることを確かめる（prd/15 §6.4）。
 * 二重実行と、接続先の取り違え（本番を使い始めた DB に流す等）を止める。満たさなければ投げる。
 */
export async function assertTargetPristine(client: pg.ClientBase): Promise<void> {
  const { rows: reg } = await client.query<{ migrations: string | null }>(
    `select to_regclass('drizzle.__drizzle_migrations')::text as migrations`,
  );
  if (!reg[0]?.migrations) {
    throw new TargetNotReadyError('マイグレーションが当たっていない（drizzle.__drizzle_migrations が無い）。先に migrate.js を流す');
  }
  // 「0000 の直後」であること。件数と識別子の両方で見る——後続のマイグレーションが当たった DB は、
  // 足された表やスキーマの変更をこの移行が知らないので始めない（OCL-9F31E62E）
  const { rows: applied } = await client.query<{ name: string | null }>(
    'select name from drizzle.__drizzle_migrations order by id',
  );
  const names = applied.map((r) => r.name);
  if (names.length !== 1 || names[0] !== EXPECTED_MIGRATION) {
    throw new TargetNotReadyError(
      names.length === 0
        ? 'マイグレーションが 1 本も適用されていない。先に migrate.js を流す'
        : `移行先のマイグレーションが 0000（${EXPECTED_MIGRATION}）の 1 本だけではない: ${names.map((n) => JSON.stringify(n)).join(', ')}`,
    );
  }

  const problems: string[] = [];
  const { rows: userIds } = await client.query<{ id: string }>('select id from users order by id');
  if (userIds.length !== 1 || userIds[0].id !== OWNER_ID) {
    problems.push(
      `users が所有者の仮の行 "${OWNER_ID}" だけではない（${userIds.length} 行: ${userIds
        .slice(0, 5)
        .map((r) => JSON.stringify(r.id))
        .join(', ')}${userIds.length > 5 ? ' …' : ''}）`,
    );
  }
  const others = [...MIGRATED_TABLES.map((t) => t.name).filter((n) => n !== 'users'), ...SKIPPED_TABLES];
  for (const table of others) {
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from ${quote(table)}`);
    if (rows[0].n !== 0) problems.push(`${table} が空ではない（${rows[0].n} 行）`);
  }
  if (problems.length > 0) {
    throw new TargetNotReadyError(
      `移行先が空の DB（0000 適用直後）ではない。二重実行か接続先の取り違えを疑う:\n  - ${problems.join('\n  - ')}`,
    );
  }
}

let savepointSeq = 0;

/**
 * `fn` を SAVEPOINT の中で流す。失敗したらそこまで戻して例外を返す（トランザクションは生きたまま）。
 * 成功なら null。
 */
async function trySavepoint(client: pg.ClientBase, fn: () => Promise<unknown>): Promise<unknown | null> {
  const name = `mig_${++savepointSeq}`;
  await client.query(`savepoint ${name}`);
  try {
    await fn();
    await client.query(`release savepoint ${name}`);
    return null;
  } catch (err) {
    await client.query(`rollback to savepoint ${name}`);
    await client.query(`release savepoint ${name}`);
    return err;
  }
}

function insertSql(table: PlannedTable, rowCount: number): string {
  const cols = table.columns.map((c) => quote(c.name)).join(', ');
  const width = table.columns.length;
  const tuples = Array.from(
    { length: rowCount },
    (_, r) => `(${table.columns.map((_, c) => `$${r * width + c + 1}`).join(', ')})`,
  ).join(', ');
  // 🔴 identity が `generated always` なので、元の ID のまま入れるには OVERRIDING SYSTEM VALUE が要る
  const overriding = table.identity ? ' overriding system value' : '';
  return `insert into ${quote(table.name)} (${cols})${overriding} values ${tuples}`;
}

/** 所有者の仮の行を、移行元の値で置き換える（PK が衝突するので INSERT しない） */
async function replaceOwner(client: pg.ClientBase, table: PlannedTable, values: unknown[]): Promise<void> {
  const sets = table.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.name !== 'id')
    .map(({ c, i }) => ({ sql: `${quote(c.name)} = $${i + 1}`, i }));
  const idIndex = table.columns.findIndex((c) => c.name === 'id');
  const res = await client.query(
    `update ${quote(table.name)} set ${sets.map((s) => s.sql).join(', ')} where "id" = $${idIndex + 1}`,
    values,
  );
  if (res.rowCount !== 1) throw new Error(`所有者の行 "${OWNER_ID}" が移行先に無い`);
}

export interface MigrateOptions {
  /** 1 回の INSERT に載せる行数の上限（パラメータ数の上限 65535 にも収める） */
  batchRows?: number;
  /** 表ごとの進み具合を知らせる */
  onProgress?: (table: string, written: number) => void;
}

/**
 * 移行元の全行を移行先へ入れ、採番を合わせ、件数を照合する。**確定はしない**（呼び出し側の役目）。
 * 呼ぶ前に `assertTargetPristine` を通しておく。
 */
export async function migrateInto(
  client: pg.ClientBase,
  source: MigrationSource,
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const tableNames = MIGRATED_TABLES.map((t) => t.name);
  const sourceCounts = await source.counts(tableNames);
  const violations: Violation[] = [];

  for (const table of MIGRATED_TABLES) {
    const batchRows = Math.max(
      1,
      Math.min(options.batchRows ?? 500, Math.floor(60000 / table.columns.length)),
    );
    let written = 0;
    let sawOwner = false;

    const flush = async (batch: { key: string; values: unknown[] }[]) => {
      if (batch.length === 0) return;
      const err = await trySavepoint(client, () =>
        client.query(insertSql(table, batch.length), batch.flatMap((b) => b.values)),
      );
      if (!err) {
        written += batch.length;
        return;
      }
      // 束のどこかが違反した。1 行ずつ入れ直して、違反した行をすべて拾う
      for (const row of batch) {
        const rowErr = await trySavepoint(client, () => client.query(insertSql(table, 1), row.values));
        if (rowErr) violations.push(asViolation(table.name, row.key, rowErr));
        else written++;
      }
    };

    const columnNames = table.columns.map((c) => c.name);
    for await (const chunk of source.rows(table.name, columnNames)) {
      let pending: { key: string; values: unknown[] }[] = [];
      for (const raw of chunk) {
        const key = rowKey(table.keys, raw);
        let values: unknown[];
        try {
          values = convertRow(table.columns, raw);
        } catch (err) {
          if (!(err instanceof ConversionError)) throw err;
          violations.push(asViolation(table.name, key, err));
          continue;
        }
        if (table.name === 'users' && raw.id === OWNER_ID) {
          sawOwner = true;
          const err = await trySavepoint(client, () => replaceOwner(client, table, values));
          if (err) violations.push(asViolation(table.name, key, err));
          else written++;
          continue;
        }
        pending.push({ key, values });
        if (pending.length >= batchRows) {
          await flush(pending);
          pending = [];
        }
      }
      await flush(pending);
      options.onProgress?.(table.name, written);
    }

    if (table.name === 'users' && !sawOwner) {
      violations.push({
        table: 'users',
        key: `id=${OWNER_ID}`,
        constraint: 'owner_missing',
        message: `移行元に所有者の行 "${OWNER_ID}" が無い（移行先の仮の行が残る）`,
      });
    }
  }

  // 🔴 identity の採番の続きを合わせる。忘れると次の挿入が PK 衝突で落ちる。空の表は「次は 1」。
  // 🔴 **`setval` は使わない。** setval はトランザクションの外の操作で、ROLLBACK しても戻らない
  // （dry-run や失敗の後にも採番が動いたまま残る。OCL-FE485ABC）。
  // `ALTER TABLE … ALTER COLUMN … RESTART WITH` は DDL なのでトランザクションに入り、ROLLBACK で戻る
  // （表の所有者＝管理ロールで流す）。
  const sequences: Record<string, number> = {};
  for (const table of MIGRATED_TABLES) {
    if (!table.identity) continue;
    const col = quote(table.identity);
    const { rows } = await client.query<{ next: string }>(
      `select coalesce(max(${col}), 0) + 1 as next from ${quote(table.name)}`,
    );
    const next = Number(rows[0].next);
    if (!Number.isSafeInteger(next)) throw new Error(`採番の続きが整数にならない: ${table.name} ${rows[0].next}`);
    await client.query(`alter table ${quote(table.name)} alter column ${col} restart with ${next}`);
    sequences[table.name] = next;
  }

  const targetCounts: Record<string, number> = {};
  for (const name of tableNames) {
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from ${quote(name)}`);
    targetCounts[name] = rows[0].n;
  }

  return {
    sourceCounts,
    targetCounts,
    violations,
    mismatches: compareCounts(sourceCounts, targetCounts),
    sequences,
  };
}

/** 確定してよいか（違反が 0 件・件数が全表で一致） */
export function canCommit(report: MigrationReport): boolean {
  return report.violations.length === 0 && report.mismatches.length === 0;
}

/** 結果を人が読む形にする（エントリの出力。違反は全件出す） */
export function formatReport(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push('表ごとの件数（移行元 → 移行先）:');
  for (const table of Object.keys(report.sourceCounts)) {
    const s = report.sourceCounts[table];
    const t = report.targetCounts[table];
    lines.push(`  ${s === t ? ' ' : '✗'} ${table.padEnd(20)} ${String(s).padStart(8)} → ${String(t).padStart(8)}`);
  }
  if (Object.keys(report.sequences).length > 0) {
    lines.push('採番の続き（次に振られる ID）:');
    for (const [table, next] of Object.entries(report.sequences)) {
      lines.push(`    ${table.padEnd(20)} ${next}`);
    }
  }
  if (report.violations.length === 0) {
    lines.push('制約違反: なし');
  } else {
    // 制約ごとの件数を先に（親の行が落ちると子の FK 違反が連なるので、まず何が根かを見る）
    const byConstraint = new Map<string, number>();
    for (const v of report.violations) {
      const k = `${v.table} / ${v.constraint}`;
      byConstraint.set(k, (byConstraint.get(k) ?? 0) + 1);
    }
    lines.push(`制約違反: ${report.violations.length} 行`);
    for (const [k, n] of byConstraint) lines.push(`    ${k}: ${n} 行`);
    lines.push('違反した行（全件）:');
    for (const v of report.violations) {
      lines.push(`    ${v.table} [${v.key}] ${v.constraint}${v.code ? ` (${v.code})` : ''}: ${v.message}`);
    }
  }
  if (report.mismatches.length > 0) {
    lines.push(`件数の不一致: ${report.mismatches.map((m) => `${m.table}（${m.source} → ${m.target}）`).join(', ')}`);
  }
  return lines.join('\n');
}
