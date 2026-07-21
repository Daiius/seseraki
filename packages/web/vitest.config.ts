import { defineConfig } from 'vitest/config';

// vite.config.ts とは独立させる。あちらは TanStack Router のルート生成・React Compiler の
// babel 変換・Tailwind を積んでおり、テスト実行のたびに副作用（routeTree.gen.ts の再生成）と
// 変換コストが乗る。web のテストは純ロジック（node 環境）だけを対象にするため、
// プラグインを一切持たない最小構成にする（prd/02-architecture.md §7）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
