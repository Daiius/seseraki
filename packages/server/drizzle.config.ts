import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit の設定（**生成専用**）。
 * - `db:generate` … schema.ts の差分から drizzle/<ts>_<name>/ を生成（DB には繋がない）
 * - 適用は drizzle-kit ではなく `migrate.ts`（drizzle-orm の migrator。`db:migrate` / `db:migrate:dev`）
 *
 * 🔴 **`drizzle-kit push` は使わない**（`db:push` は廃止。prd/15 §3.4）。push は手で足した
 * `updatedAt` のトリガーを作らないので、dev も migrate に一本化している。
 * 🔴 **drizzle-kit はトリガーを生成しない。** `updatedAt` を持つ表を足したら、生成された
 * `migration.sql` にトリガーを手で足す（0000 の末尾を参照）。
 * ⭐ 列名の snake_case（prd/15 §3.6）は**ここではなく schema の表の定義**（`snakeCase.table`）が決める。
 * drizzle 1.0 の generate は設定の `casing` を読まない（rc.3 で確認）。
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
