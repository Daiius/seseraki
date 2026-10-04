/**
 * MySQL → Postgres のデータ移行（prd/15 §6）で**何をどの順に移すか**。
 *
 * 列の一覧と型は **Postgres の schema（`db/schema.ts`）から導く**——移行のために列を 2 か所に書かない。
 *
 * 🔴 **列名は移行元と移行先で違う**（prd/15 §3.6）:
 * - MySQL（旧 schema）の列名は camelCase ＝ **pg schema の TS のプロパティ名**（`getTableColumns` のキー）
 * - Postgres の列名は snake_case ＝ **drizzle の casing で変換した名前**（列の `.name`）
 * 読み取りは前者、書き込みは後者で行う。どちらも schema から引くので対応表は書かない。
 * MySQL に列が無ければ SELECT が落ちて、何も書かずに止まる。
 *
 * ⚠ 後片付けの PR（prd/15 §9 の 5）で、このディレクトリごと消す。
 */
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import {
  account,
  candidateMoves,
  drillAttempts,
  drills,
  kifuPositions,
  kifus,
  kifuTactics,
  moveAnalyses,
  session,
  userAliases,
  users,
  verification,
  videoKifuSources,
} from '../db/schema.js';
import { OWNER_USER_ID } from '../users.js';
import { kindOfSqlType, type ColumnKind } from './convert.js';

export interface PlannedColumn {
  /** 移行元（MySQL）の列名。camelCase（pg schema の TS のプロパティ名と同じ） */
  name: string;
  /** 移行先（Postgres）の列名。snake_case（drizzle の casing で変換した名前） */
  target: string;
  kind: ColumnKind;
}

export interface PlannedTable {
  name: string;
  columns: PlannedColumn[];
  /** 違反の一覧で行を示す列（PK。移行元の列名） */
  keys: string[];
  /**
   * identity 列の**移行先の**列名（`OVERRIDING SYSTEM VALUE` で元の値を入れ、最後に `RESTART WITH` で
   * 採番を合わせる）
   */
  identity: string | null;
}

function plan<T extends Table>(table: T, keys: (keyof T['_']['columns'] & string)[]): PlannedTable {
  const columns = Object.entries(getTableColumns(table));
  const identity = columns.find(([, c]) => c.generatedIdentity)?.[1].name ?? null;
  return {
    name: getTableName(table),
    columns: columns.map(([key, c]) => ({ name: key, target: c.name, kind: kindOfSqlType(c.getSQLType()) })),
    keys,
    identity,
  };
}

/**
 * **移す表**（FK の順。親を先に入れる）。prd/15 §6.2。
 *
 * - `users` の `"1"`（所有者）は 0000 が仮の値で入れているので、**挿入ではなく UPDATE で置き換える**（PK が衝突する）
 * - `candidate_moves` はエンジンの解析結果で、作り直すと高いので移す
 * - `drills` は `drill_attempts` が ID で指すので **ID ごと移す**
 */
export const MIGRATED_TABLES: readonly PlannedTable[] = [
  plan(users, ['id']),
  plan(account, ['id']),
  plan(userAliases, ['id']),
  plan(kifus, ['id']),
  plan(videoKifuSources, ['kifuId']),
  plan(moveAnalyses, ['id']),
  plan(candidateMoves, ['id']),
  plan(kifuTactics, ['kifuId', 'side', 'label']),
  plan(drills, ['id']),
  plan(drillAttempts, ['id']),
];

/**
 * **移さない表**。移行先で空であることだけを確かめる（二重実行・取り違えの検出）。
 * - `kifu_positions` … 移さず作り直す（移行後に `rebuild-positions`）
 * - `session` / `verification` … 移さない（切り替え後に一度ログインし直すだけ）
 */
export const SKIPPED_TABLES: readonly string[] = [
  getTableName(kifuPositions),
  getTableName(session),
  getTableName(verification),
];

/** 所有者の ID（0000 が仮の値で入れている行） */
export const OWNER_ID = OWNER_USER_ID;

/**
 * 移行先に適用済みであるべき**唯一の**マイグレーション（Postgres の 0000。`drizzle/` のフォルダ名）。
 * 移行は 0000 の直後の DB にだけ流す。⚠ 切り替えの前に後続のマイグレーションを足したら、
 * この移行が新しい表・列を扱えるかを見直してからここを更新する。
 */
export const EXPECTED_MIGRATION = '20261004065007_postgres';
