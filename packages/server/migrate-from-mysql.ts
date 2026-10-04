/**
 * MySQL → Postgres のデータ移行（prd/15 §6）。**一度きり**のエントリ。
 *
 * **薄い entry point に徹する。** 読み取りは `src/mysql-migration/mysql-source.ts`、
 * 書き込み・違反の列挙・件数の照合は `src/mysql-migration/write.ts`。
 *
 * - 🔒 **MySQL には一切書かない**（読み取りは READ ONLY のトランザクション。戻し方の前提。prd/15 §7）
 * - 🔒 **Postgres へは全体を 1 つのトランザクションで書く。** 途中で失敗したら元のまま
 * - **既定は dry-run**: 同じトランザクションで全部入れてみて（DB の CHECK・FK で実際に検査する）、
 *   **最後に ROLLBACK** する。`MIGRATE_APPLY=1` で COMMIT
 * - 制約違反があるか、表ごとの件数が MySQL と合わなければ ROLLBACK して非 0 で終わる（apply でも）
 * - 移行先が「0000 適用済み・所有者の仮の行 `"1"` 以外は空」でなければ何もせずに中止する
 * - 移さない: `session`・`verification`。作り直す: `kifu_positions`（後で `rebuild-positions`）
 *
 * 接続:
 * - Postgres … `DB_HOST` / `DB_PORT` / `DB_NAME` と **管理ロール**（`DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`）。
 *   identity の採番を `ALTER TABLE … RESTART WITH` で合わせるには表の所有者（管理ロール）が要る
 *   （server ロールは DML だけ。scripts/postgres-init/10-server-role.sh）
 * - MySQL … `MYSQL_HOST` / `MYSQL_PORT`（既定 3306）/ `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`
 *
 *   dev（compose 網の中から。ホストからは MySQL に届かない）:
 *     docker compose run --rm --no-deps server pnpm --filter server exec tsx migrate-from-mysql.ts
 *   本番（イメージに同梱）:
 *     docker compose run --rm --no-deps <server サービス> /app/migrate-from-mysql.js
 *     docker compose run --rm --no-deps -e MIGRATE_APPLY=1 <server サービス> /app/migrate-from-mysql.js
 *
 * ⚠ 後片付けの PR（prd/15 §9 の 5）で、このエントリ・`src/mysql-migration/`・`mysql2` の依存を外す。
 */
import pg from 'pg';
import { connectionConfig } from './src/db/index.js';
import { mysqlConfigFromEnv, openMysqlSource, type MysqlSource } from './src/mysql-migration/mysql-source.js';
import {
  assertTargetPristine,
  canCommit,
  formatReport,
  migrateInto,
  TargetNotReadyError,
} from './src/mysql-migration/write.js';

const APPLY = process.env.MIGRATE_APPLY === '1';

async function main(): Promise<number> {
  const pgConfig = connectionConfig('admin');
  if (!pgConfig.user) {
    console.error('DB_ADMIN_USER が未設定です（データ移行は管理ロールで流す。採番の調整に表の所有者の権限が要る）');
    return 1;
  }
  const mysqlConfig = mysqlConfigFromEnv();
  console.log(
    `MySQL ${mysqlConfig.host}:${mysqlConfig.port}/${mysqlConfig.database} → Postgres ${pgConfig.host}:${pgConfig.port}/${pgConfig.database}` +
      (APPLY ? '（MIGRATE_APPLY=1: 問題が無ければ COMMIT する）' : '（dry-run: 最後に ROLLBACK する。MIGRATE_APPLY=1 で実書込）'),
  );

  const client = new pg.Client(pgConfig);
  await client.connect();
  let source: MysqlSource | null = null;
  try {
    await client.query('begin');
    await assertTargetPristine(client);
    // 🔴 セッションを UTC に固定して読み返す。UTC でなければここで投げ、Postgres には何も書かない
    source = await openMysqlSource(mysqlConfig);

    const report = await migrateInto(client, source, {
      onProgress: (table, written) => process.stdout.write(`\r  ${table}: ${written} 行`.padEnd(48)),
    });
    process.stdout.write('\n');
    console.log(formatReport(report));

    if (!canCommit(report)) {
      await client.query('rollback');
      console.error('✗ 制約違反か件数の不一致がある。ROLLBACK した（Postgres は元のまま）');
      return 1;
    }
    if (!APPLY) {
      await client.query('rollback');
      console.log('✓ dry-run: 全件が制約を満たし、件数も一致した。ROLLBACK した（MIGRATE_APPLY=1 で実書込）');
      return 0;
    }
    await client.query('commit');
    console.log('✓ COMMIT した。続けて局面索引を作り直す（移していない）:');
    console.log('    REBUILD_POSITIONS_APPLY=1 で rebuild-positions を流す（本番: /app/rebuild-positions.js）');
    return 0;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    if (err instanceof TargetNotReadyError) {
      console.error(`✗ 中止（何も書いていない）: ${err.message}`);
    } else {
      // cause まで出す（pg のエラーは detail・constraint に理由がある）
      console.error(err);
      console.error('✗ 失敗。ROLLBACK した（Postgres は元のまま）');
    }
    return 1;
  } finally {
    await source?.close().catch((e) => console.error('MySQL の切断に失敗', e));
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
