/**
 * 🔒 **グローバルの `db`（`src/db/index.ts`）に触れてよいモジュールを限る**（prd/14 §4「RLS の形」）。
 *
 * ログインの経路（`route.ts` のハンドラと、そこから呼ぶクエリ関数）は、ユーザーとして開いた
 * トランザクション（`user-tx.ts`）を引数で受け取る。グローバルの `db` を直接使うと `app.user_id` を
 * 設定しないまま問い合わせることになり、アプリ層の所有者の条件を書き忘れたときに止めるもの（RLS）が
 * 効かない（2b で RLS を入れると「何も見えない」で表に出るが、それより前にここで落とす）。
 *
 * - 型だけの import（`import type`・`{ type Tx }` だけ）は許す（実行時に接続を持ち込まない）
 * - **値の import** は下の許可リストのモジュールだけ。足すときは「なぜ全員ぶん（ユーザーとして動かない）か」を書く
 *
 * 2b（RLS）で、全員ぶんの経路を BYPASSRLS の別プールに移すときも、同じ仕組みで
 * 「迂回プールを import してよいモジュール」を限る（`ALLOWED` と同じ形の表を足す）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_MODULE = join(PACKAGE_ROOT, 'src/db/index.ts');

/** グローバルの `db` を値として import してよいモジュール（パッケージルートからの相対パス）と理由 */
const ALLOWED: Record<string, string> = {
  'src/user-tx.ts': 'ログインの経路の唯一の入口（リクエストごとに tx を開いて app.user_id を設定する）',
  'src/auth.ts': 'Better Auth のアダプタ（user / session / account / verification。棋譜系の表ではない）',
  'src/dev-login.ts': '手元の development だけの dev ログイン（user / account の作成と付け替え）',
  'src/worker-routes.ts': '全員ぶん: worker の報告・動画解析の取り込み（API_KEY）',
  'src/video-analysis.ts': '全員ぶん: 動画解析の取り込み（API_KEY。所有者専用の手元ツールから）',
  'src/db/seed.ts': 'dev のサンプルデータ投入（手元の CLI）',
  'migrate.ts': '全員ぶん: マイグレーション（管理ロール）',
  'generate-drills.ts': '全員ぶん: 一括処理のエントリ',
  'rebuild-positions.ts': '全員ぶん: 一括処理のエントリ',
  'rebuild-subjects.ts': '全員ぶん: 一括処理のエントリ',
  'redetect-tactics.ts': '全員ぶん: 一括処理のエントリ',
  'link-owner-account.ts': '全員ぶん: 移行時に 1 回だけ流すエントリ（account の付け替え）',
};

/** テスト・設定・実 DB テストの補助は見ない（本番のコードではない） */
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
  // パッケージ直下のエントリ（一括処理・マイグレーション）
  for (const name of readdirSync(PACKAGE_ROOT)) {
    const path = join(PACKAGE_ROOT, name);
    if (statSync(path).isFile() && isProductionSource(path)) files.push(path);
  }
  return files;
}

/** import / export … from / 動的 import の指定子と、型だけの import かどうか */
function importsOf(source: string): { specifier: string; typeOnly: boolean }[] {
  const found: { specifier: string; typeOnly: boolean }[] = [];
  const statement = /(?:^|\n)\s*(import|export)\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(statement)) {
    const clause = m[2].trim();
    let typeOnly = clause.startsWith('type ');
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (!typeOnly && braces) {
      const names = braces[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      typeOnly = names.length > 0 && names.every((n) => n.startsWith('type '));
    }
    found.push({ specifier: m[3], typeOnly });
  }
  // 副作用だけの import（`import './db'`）と動的 import は値の import として扱う
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
    found.push({ specifier: m[1], typeOnly: false });
  }
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({ specifier: m[1], typeOnly: false });
  }
  return found;
}

/** 相対指定子を実ファイルに解く（`.js` 付き・拡張子なし・ディレクトリの index のどれでも） */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

describe('グローバルの db の import 境界（prd/14 §4）', () => {
  it('importsOf: 型だけの import と値の import を見分ける', () => {
    expect(
      importsOf(
        [
          "import type { Db } from './db/index.js';",
          "import { type Tx } from './db/index.js';",
          "import { db, type Tx } from './db/index.js';",
          "import { client, db } from './src/db';",
          "import './db';",
          "const m = await import('./db/index.js');",
        ].join('\n'),
      ),
    ).toEqual([
      { specifier: './db/index.js', typeOnly: true },
      { specifier: './db/index.js', typeOnly: true },
      { specifier: './db/index.js', typeOnly: false },
      { specifier: './src/db', typeOnly: false },
      { specifier: './db', typeOnly: false },
      { specifier: './db/index.js', typeOnly: false },
    ]);
  });

  it('値として import するのは許可リストのモジュールだけ（ログインの経路のハンドラ・クエリ関数は tx を受け取る）', () => {
    const offenders = sourceFiles()
      .filter((file) =>
        importsOf(readFileSync(file, 'utf8')).some(
          ({ specifier, typeOnly }) =>
            !typeOnly && resolveSpecifier(file, specifier) === DB_MODULE,
        ),
      )
      .map((file) => relative(PACKAGE_ROOT, file))
      .filter((path) => !(path in ALLOWED));
    expect(offenders).toEqual([]);
  });

  it('許可リストに実在しないモジュールを残さない（消したら外す）', () => {
    const existing = new Set(sourceFiles().map((file) => relative(PACKAGE_ROOT, file)));
    expect(Object.keys(ALLOWED).filter((path) => !existing.has(path))).toEqual([]);
  });

  it('route.ts（ログインの経路）は db を import しない', () => {
    const route = join(PACKAGE_ROOT, 'src/route.ts');
    expect(
      importsOf(readFileSync(route, 'utf8')).filter(
        ({ specifier, typeOnly }) => !typeOnly && resolveSpecifier(route, specifier) === DB_MODULE,
      ),
    ).toEqual([]);
  });
});
