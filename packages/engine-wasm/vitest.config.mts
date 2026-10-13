import { defineConfig } from 'vitest/config';

// 成果物（dist/engine）を node で実際に動かす統合テストだけを持つ。
// 成果物が無い環境では skip になる（test/engine.integration.test.ts）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 既定のレポーターは、テストが 1 つも走らないとき skip の理由（console.warn）を出さない。
    reporters: ['verbose'],
  },
});
