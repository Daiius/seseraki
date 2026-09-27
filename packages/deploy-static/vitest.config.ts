import { defineConfig } from 'vitest/config';

// 判断は純粋な関数、実行は差し替えられる runner に分けてあるので、
// 本物の ssh / rsync を呼ばずに node 環境だけで回る（prd/02-architecture.md §5・§7）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
