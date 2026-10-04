/**
 * MySQL の行を Postgres へ渡す値に変換する（prd/15 §6.3）。**純粋な関数だけを置く**（DB に触らない）。
 *
 * 入力は MySQL の読み取り（`mysql-source.ts`）が返す形:
 * - 日時（`TIMESTAMP` / `DATE`）は **文字列のまま**（`dateStrings`）。セッションは UTC に固定してある
 * - JSON は **文字列のまま**（`jsonStrings`）。パースし直さずにそのまま `jsonb` へ渡す
 *   （mysql2 の既定は `JSON.parse` 済みの値を返すが、往復させる理由が無い）。オブジェクトが来ても受ける
 * - `tinyint(1)` は 0 / 1、`binary(N)` は `Buffer`、`bigint unsigned` は number（安全な範囲を超えると文字列）
 */

export type ColumnKind = 'timestamptz' | 'date' | 'jsonb' | 'boolean' | 'bytea' | 'integer' | 'text';

/** Postgres の列の SQL 型（drizzle の `getSQLType()`）から変換の種類を決める */
export function kindOfSqlType(sqlType: string): ColumnKind {
  if (sqlType === 'timestamp with time zone') return 'timestamptz';
  if (sqlType === 'date') return 'date';
  if (sqlType === 'jsonb') return 'jsonb';
  if (sqlType === 'boolean') return 'boolean';
  if (sqlType === 'bytea') return 'bytea';
  if (sqlType === 'bigint' || sqlType === 'integer' || sqlType === 'smallint') return 'integer';
  if (sqlType === 'text' || /^varchar\(\d+\)$/.test(sqlType)) return 'text';
  // 知らない型を黙って素通しにしない（schema に型を足したら、ここで変換を決める）
  throw new Error(`データ移行が知らない列の型です: ${sqlType}`);
}

/** 変換できない値。違反の一覧に `conversion` として載る */
export class ConversionError extends Error {}

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * MySQL の `TIMESTAMP` の文字列（`YYYY-MM-DD HH:MM:SS[.ffffff]`）を **UTC の壁時計として** `Date` にする。
 *
 * 🔴 **UTC と読んでよいのは、読み取りの接続のセッションを UTC に固定してあるときだけ**（prd/15 §6.3）。
 * `TIMESTAMP` はセッションの時刻帯で文字列になるので、JST の接続で読むと全行が一律に 9 時間ずれる。
 * 旧 server の drizzle も同じ解釈（`new Date(value + "+0000")`）だった（prd/03 §1.1）。
 */
export function mysqlUtcToDate(value: string): Date {
  const m = DATETIME_RE.exec(value);
  if (!m) throw new ConversionError(`日時の形が違う: ${JSON.stringify(value)}`);
  const [, y, mo, d, h, mi, s, frac = ''] = m;
  // Date はミリ秒までしか持てない。それより細かい値があれば黙って切り捨てずに止める
  if (/[1-9]/.test(frac.slice(3))) {
    throw new ConversionError(`ミリ秒より細かい日時は運べない: ${value}`);
  }
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms));
  // ゼロ日付（0000-00-00）や 2 月 30 日のような値は Date.UTC が繰り上げてしまうので、往復で弾く
  if (
    date.getUTCFullYear() !== +y ||
    date.getUTCMonth() !== +mo - 1 ||
    date.getUTCDate() !== +d ||
    date.getUTCHours() !== +h ||
    date.getUTCMinutes() !== +mi ||
    date.getUTCSeconds() !== +s
  ) {
    throw new ConversionError(`存在しない日時: ${value}`);
  }
  return date;
}

/** MySQL の `DATE`（`YYYY-MM-DD`）。日付だけの値なので**文字列のまま**渡す（schema も `mode: 'string'`） */
export function mysqlDate(value: string): string {
  const m = DATE_RE.exec(value);
  if (!m) throw new ConversionError(`日付の形が違う: ${JSON.stringify(value)}`);
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) {
    throw new ConversionError(`存在しない日付: ${value}`);
  }
  return value;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Buffer.isBuffer(value)) return 'Buffer';
  if (value instanceof Date) return 'Date';
  return typeof value;
}

/**
 * 1 つの値を変換する。`null` はどの種類でも `null`（NOT NULL の検査は Postgres に任せる）。
 * 返す値は node-postgres にそのまま渡せる形（`Date` / `Buffer` / string / number / boolean）。
 */
export function convertValue(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'timestamptz':
      // 🔴 Date で来たら、どこかで mysql2 の日時変換（接続の時刻帯で解釈する）を通っている。受けない
      if (typeof value !== 'string') {
        throw new ConversionError(`日時は文字列で受ける（dateStrings）はずが ${typeName(value)} だった`);
      }
      return mysqlUtcToDate(value);
    case 'date':
      if (typeof value !== 'string') {
        throw new ConversionError(`日付は文字列で受ける（dateStrings）はずが ${typeName(value)} だった`);
      }
      return mysqlDate(value);
    case 'jsonb':
      if (typeof value === 'string') {
        // 形だけ確かめてそのまま渡す（壊れていれば Postgres も弾くが、ここで理由を付けて止める）
        try {
          JSON.parse(value);
        } catch {
          throw new ConversionError(`JSON として読めない: ${value.slice(0, 80)}`);
        }
        return value;
      }
      // ⚠ 配列を node-postgres にそのまま渡すと Postgres の配列リテラル（`{…}`）になる。必ず文字列にする
      return JSON.stringify(value);
    case 'boolean':
      if (value === 0 || value === 1) return value === 1;
      if (typeof value === 'boolean') return value;
      throw new ConversionError(`真偽値（0 / 1）ではない: ${String(value)}`);
    case 'bytea':
      if (Buffer.isBuffer(value)) return value;
      throw new ConversionError(`バイト列ではない: ${typeName(value)}`);
    case 'integer': {
      const n = typeof value === 'number' ? value : typeof value === 'string' || typeof value === 'bigint' ? Number(value) : NaN;
      if (!Number.isSafeInteger(n)) {
        throw new ConversionError(`安全な整数の範囲にない: ${String(value)}`);
      }
      return n;
    }
    case 'text':
      if (typeof value === 'string') return value;
      throw new ConversionError(`文字列ではない: ${typeName(value)}`);
  }
}

/** 行を列の順の値の配列にする。どの列で失敗したかを付けて投げ直す */
export function convertRow(
  columns: readonly { name: string; kind: ColumnKind }[],
  row: Record<string, unknown>,
): unknown[] {
  return columns.map(({ name, kind }) => {
    if (!(name in row)) throw new ConversionError(`列 ${name} が読み取り結果に無い`);
    try {
      return convertValue(kind, row[name]);
    } catch (err) {
      if (err instanceof ConversionError) throw new ConversionError(`${name}: ${err.message}`);
      throw err;
    }
  });
}

/** 違反の一覧で行を示す文字列（例 `kifuId=3,side=sente,label=四間飛車`） */
export function rowKey(keys: readonly string[], row: Record<string, unknown>): string {
  return keys.map((k) => `${k}=${String(row[k])}`).join(',');
}

export interface CountMismatch {
  table: string;
  source: number;
  target: number;
}

/** 表ごとの件数を照合する。移行元にある表の件数が移行先と合わなければ並べて返す */
export function compareCounts(
  source: Readonly<Record<string, number>>,
  target: Readonly<Record<string, number>>,
): CountMismatch[] {
  const mismatches: CountMismatch[] = [];
  for (const table of Object.keys(source)) {
    const t = target[table];
    if (t !== source[table]) mismatches.push({ table, source: source[table], target: t ?? NaN });
  }
  return mismatches;
}

/**
 * `SELECT @@session.time_zone` の値が UTC か。
 * `SET time_zone = '+00:00'` の後に読み返すと `+00:00` が返る。名前付きの UTC も受ける。
 */
export function isUtcSessionZone(zone: unknown): boolean {
  return typeof zone === 'string' && ['+00:00', '-00:00', 'UTC', 'Etc/UTC'].includes(zone);
}
