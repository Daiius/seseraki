/**
 * 実 DB テストの各ワーカーで、**テスト対象のモジュールより先に**接続先を差し替える。
 * `src/db/index.ts` は import 時に環境変数から接続設定を読むので、setupFiles で env を書いておく。
 *
 * ⭐ セッションの時刻帯を **Asia/Tokyo** にする（server のコンテナと同じ）。`timestamptz` の読み書きが
 * 接続の時刻帯に依存しないこと（と、`sql` 断片が返すオフセット付きの文字列を正しく読めること）を
 * UTC 以外の時刻帯で確かめるため。
 */
import { inject } from 'vitest';

const url = new URL(inject('testDatabaseUrl'));
process.env.DB_HOST = url.hostname;
process.env.DB_PORT = url.port || '5432';
process.env.DB_NAME = decodeURIComponent(url.pathname.slice(1));
process.env.DB_USER = decodeURIComponent(url.username);
process.env.DB_PASSWORD = decodeURIComponent(url.password);
// node-postgres は PGOPTIONS を接続の起動オプションとして送る
process.env.PGOPTIONS = '-c TimeZone=Asia/Tokyo';
