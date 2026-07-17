import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit の設定。
 * - `db:generate` … schema.ts の差分から drizzle/<ts>_<name>/ を生成
 * - `db:migrate`  … 未適用の drizzle/* を順に適用（本番。tsx migrate.ts）
 * - `db:baseline` … 既存 DB を 0000 で「適用済み」登録する一回限りの初期化（tsx baseline.ts）
 * - `db:push`     … スキーマ強制同期（履歴なし）。dev / 使い捨て DB 専用。本番では使わない
 * dbCredentials は push / pull / studio 等 CLI 用。generate はオフライン、migrate/baseline は src/db 経由で env を読む。
 */
export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'seseraki',
  },
});
