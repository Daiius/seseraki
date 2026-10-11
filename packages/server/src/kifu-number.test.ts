/**
 * 🔴 **`kifus` を作る経路はすべて番号の採番（`insertKifu`）を通す**（prd/14 §4.4）。
 *
 * `displayNo` は NOT NULL なので、採番を通さない挿入は型（`$inferInsert`）でも DB でも落ちる。
 * それでも `insert(kifus)` を他所に書くと、**`max(displayNo) + 1` のような別の振り方**を持ち込める
 * （末尾を消すと番号が再利用される）。振り方を 1 か所に保つため、挿入の書き場所を限る。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 本番のコード（テスト・設定・実 DB テストの補助を除く）。`db-import-boundary.test.ts` と同じ範囲 */
function isProductionSource(path: string): boolean {
  return (
    path.endsWith('.ts') &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.d.ts') &&
    !path.includes('/test-db/') &&
    !/\/(vitest|drizzle|esbuild)[^/]*\.config\.ts$/.test(path)
  );
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (isProductionSource(path)) files.push(path);
    }
  };
  walk(join(PACKAGE_ROOT, 'src'));
  for (const name of readdirSync(PACKAGE_ROOT)) {
    const path = join(PACKAGE_ROOT, name);
    if (statSync(path).isFile() && isProductionSource(path)) files.push(path);
  }
  return files;
}

/** drizzle の `insert(kifus)` と、手書きの `insert into kifus` */
const INSERT_KIFUS = /\.insert\(\s*kifus\s*\)|insert\s+into\s+"?kifus"?[\s(]/i;

describe('棋譜の番号（prd/14 §4.4）', () => {
  it('検出の正規表現が両方の書き方に当たる（空振りしていない）', () => {
    expect(INSERT_KIFUS.test('await tx.insert(kifus).values({})')).toBe(true);
    expect(INSERT_KIFUS.test('insert into "kifus" ("title") values')).toBe(true);
    expect(INSERT_KIFUS.test('INSERT INTO kifus (title)')).toBe(true);
    expect(INSERT_KIFUS.test('await tx.insert(kifuTactics).values({})')).toBe(false);
  });

  it('🔴 kifus に挿入するのは kifu-number.ts だけ（他の経路は insertKifu を通す）', () => {
    const offenders = sourceFiles()
      .filter((file) => INSERT_KIFUS.test(readFileSync(file, 'utf8')))
      .map((file) => relative(PACKAGE_ROOT, file));
    expect(offenders).toEqual(['src/kifu-number.ts']);
  });
});
