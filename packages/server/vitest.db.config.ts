import { defineConfig } from 'vitest/config';

// 実 Postgres に当てるテスト（prd/15 §8.2）。`TEST_DATABASE_URL` が要る:
//   TEST_DATABASE_URL=postgres://<user>:<pass>@<host>:<port>/<db> pnpm --filter server test:db
// 実行ごとにランダム名の DATABASE を作ってマイグレーションを当て、終わったら DROP する
// （src/test-db/global-setup.ts）。
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    globalSetup: ['./src/test-db/global-setup.ts'],
    setupFiles: ['./src/test-db/setup.ts'],
    // ファイル間で 1 つの DATABASE を共有するので、ファイルは順に流す（各テストは自分の行だけを見る）
    fileParallelism: false,
  },
});
