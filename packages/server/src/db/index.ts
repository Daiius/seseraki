import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';
import { relations } from './schema.js';

/**
 * 接続のセッションタイムゾーン。**必ず UTC に固定する。**
 *
 * 🔴 **drizzle は DB から返る日時の壁時計を無条件に UTC として読む。**
 * `drizzle-orm/mysql2` の session は自前の `typeCast` を渡していて、
 * `TIMESTAMP` / `DATETIME` / `DATE` を `field.string()`（生の文字列）のまま受け取る
 * ——**mysql2 側の日時変換は通らない**。その文字列を
 * `mysql-core/columns/timestamp.js` の `mapFromDriverValue` が
 * `new Date(value + "+0000")` で組み立てる。書く側も `toISOString()` なので、
 * **drizzle は「DB の壁時計 ＝ UTC」を前提にしている**。
 *
 * 🔴 **`mysql.createPool({ timezone })` を足しても直らない。** あのオプションは
 * mysql2 の日時変換で使われるが、上記のとおりその経路を drizzle が潰している。
 * 効くのは**セッションの時刻帯そのもの**を UTC にすることだけ。
 *
 * これを入れないと、MySQL の `time_zone` が `SYSTEM`（＝コンテナの JST）のとき
 * `now()` 由来の列（`defaultNow()` / `onUpdateNow()` の `createdAt` / `updatedAt`）が
 * **JST の壁時計を UTC と読まれて +9h 未来に見える**。
 * 逆に JS が書いた列（`playedAt` / `analysisCompletedAt`）は
 * **UTC の壁時計を JST として保存**していたので、読み書きの誤解釈が打ち消し合って
 * 画面上は正しく見えていた（保存されている instant の方が 9h 手前にずれている）。
 * → 既存行の是正は一度きりの `shift-js-timestamps.ts`。
 */
const SET_SESSION_UTC = "SET time_zone = '+00:00'";

export const client = mysql.createPool({
  host: process.env.DB_HOST ?? 'localhost',
  // 既定 3306。cloudflared tunnel やローカル検証用 DB を別ポートに立てたときに
  // DB_PORT で差し替える（未設定なら 3306）。
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? '',
  database: process.env.MYSQL_DATABASE ?? 'seseraki',
});

/**
 * 新しく張られた接続ごとにセッションを UTC へ寄せる。
 *
 * mysql2 のプールには「接続確立時に流す SQL」の設定が無いので `connection` イベントで流す。
 * この**イベントはプールが呼び出し元へ接続を渡す前に同期的に発火**し、発行したクエリは
 * その接続のコマンド待ち行列に先に積まれる（mysql2 `lib/base/pool.js`）。
 * だから利用側のクエリより必ず先に適用される。
 *
 * ⚠ 型は promise 版（`PoolConnection`）だが、**実体は callback 版の接続**が流れてくる
 * （`inheritEvents` がコアプールのイベントをそのまま中継するため）。だからコールバックで受ける。
 * 失敗したら**黙って JST のまま使わせない**——接続を壊して取り直させる。
 */
client.on('connection', (connection) => {
  const raw = connection as unknown as {
    query: (sql: string, cb: (err: unknown) => void) => void;
    destroy: () => void;
  };
  raw.query(SET_SESSION_UTC, (err) => {
    if (err) {
      console.error('セッションのタイムゾーンを UTC にできませんでした', err);
      raw.destroy();
    }
  });
});

export const db = drizzle({
  client,
  schema,
  relations,
  mode: 'default',
});
