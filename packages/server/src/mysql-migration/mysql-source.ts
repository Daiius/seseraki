/**
 * データ移行の **MySQL 側の読み取り**（prd/15 §6）。
 *
 * 🔒 **MySQL には一切書かない**（戻し方の前提。prd/15 §7）。読み取りは `READ ONLY` のトランザクションで
 * 行うので、書く文を流しても MySQL が拒否する。セッション変数（時刻帯）を設定するだけ。
 *
 * ⚠ MySQL のドライバ（`mysql2`）はこの移行のために**一時的に**依存へ戻している。
 * 後片付けの PR（prd/15 §9 の 5）で、このディレクトリ・エントリと一緒に外す。
 */
import mysql from 'mysql2';
import { isUtcSessionZone } from './convert.js';
import type { MigrationSource } from './write.js';

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** 環境変数から MySQL の接続設定を作る。足りなければ何が足りないかを投げる */
export function mysqlConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MysqlConfig {
  const missing = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_DATABASE'].filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`MySQL の接続設定が足りない: ${missing.join(', ')}`);
  return {
    host: env.MYSQL_HOST!,
    port: env.MYSQL_PORT ? Number(env.MYSQL_PORT) : 3306,
    user: env.MYSQL_USER!,
    password: env.MYSQL_PASSWORD ?? '',
    database: env.MYSQL_DATABASE!,
  };
}

const quote = (name: string) => `\`${name.replaceAll('`', '``')}\``;

export interface MysqlSource extends MigrationSource {
  close(): Promise<void>;
}

/** 束の大きさ（読み取りはストリームで、この行数ずつ書き込み側へ渡す） */
const CHUNK_ROWS = 1000;

/**
 * MySQL に繋ぎ、**最初の SELECT の前にセッションを UTC に固定して読み返す**。UTC でなければ投げる
 * （呼び出し側は Postgres に何も書かずに止まる）。
 *
 * 🔴 `TIMESTAMP` はセッションの時刻帯で文字列になる。JST のまま読んで UTC と解釈すると
 * **全行が一律に 9 時間ずれる**（prd/15 §6.3・prd/03 §1.1）。
 * **単一の接続**で読む（プールにしない）——接続を張り直す経路があると、張り直した接続が JST に戻りうる。
 */
export async function openMysqlSource(config: MysqlConfig): Promise<MysqlSource> {
  // 行のストリームは callback 版の接続にしか無いので、callback 版で張って promise 版を被せる（同じ 1 本の接続）
  const raw = mysql.createConnection({
    ...config,
    // 日時は文字列のまま受け、UTC として Date にする（convert.ts の mysqlUtcToDate）。
    // mysql2 の日時変換（接続の timezone で解釈する）を通さない
    dateStrings: true,
    // JSON は文字列のまま受けて jsonb へそのまま渡す（既定は JSON.parse 済みの値を返す）
    jsonStrings: true,
    // bigint は安全な範囲なら number、超えたら文字列（convert.ts が範囲を検査する）
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  const conn = raw.promise();
  try {
    await conn.connect();
    await conn.query("SET time_zone = '+00:00'");
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT @@session.time_zone AS tz');
    const tz: unknown = rows[0]?.tz;
    if (!isUtcSessionZone(tz)) {
      throw new Error(`MySQL のセッションの時刻帯が UTC にならない（${String(tz)}）。何も書かずに中止する`);
    }
    // ストリームは Postgres への書き込みを待つ間止まる。違反した束を 1 行ずつ入れ直す間に
    // MySQL 側が送信待ちで切らないよう、待てる時間を延ばす（セッション変数。データには触らない）
    await conn.query('SET SESSION net_write_timeout = 600');
    // 全表を同じ時点で読む（件数と行が食い違わない）。READ ONLY なので MySQL への書き込みは拒否される
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  } catch (err) {
    await conn.end();
    throw err;
  }

  return {
    async counts(tables) {
      const result: Record<string, number> = {};
      for (const table of tables) {
        const [rows] = await conn.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${quote(table)}`);
        result[table] = Number(rows[0].n);
      }
      return result;
    },
    async *rows(table, columns) {
      const sql = `SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)}`;
      // 行を全部メモリに載せない（局面・候補手は数十万行になりうる）。ストリームで束にして渡す
      const stream = raw.query(sql).stream({ objectMode: true });
      let chunk: Record<string, unknown>[] = [];
      for await (const row of stream as AsyncIterable<Record<string, unknown>>) {
        chunk.push(row);
        if (chunk.length >= CHUNK_ROWS) {
          yield chunk;
          chunk = [];
        }
      }
      if (chunk.length > 0) yield chunk;
    },
    async close() {
      // 読み取りだけのトランザクションを閉じる（何も書いていないので ROLLBACK でよい）
      try {
        await conn.query('ROLLBACK');
      } finally {
        await conn.end();
      }
    },
  };
}
