import { defineConfig } from 'vitest/config';

// 将棋ドメインの純ロジックだけを置くパッケージなので、node 環境の最小構成でよい
// （web の vitest.config.ts と同じ方針。prd/02-architecture.md §7）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
