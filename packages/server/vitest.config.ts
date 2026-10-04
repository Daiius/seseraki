import { configDefaults, defineConfig } from 'vitest/config';

// 通常のテスト（DB 無し）。実 DB に当てるテスト（`*.db.test.ts`）は `vitest.db.config.ts` で別に流す
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.db.test.ts'],
  },
});
