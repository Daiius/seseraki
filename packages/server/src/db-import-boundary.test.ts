/**
 * 🔒 **DB の接続（プール）に触れてよいモジュールを限る**（prd/14 §4「RLS の形」・prd/15 §2）。
 *
 * - **server ロールのプール**（`src/db/index.ts` の `db`。RLS が効く）: ログインの経路（`route.ts` の
 *   ハンドラと、そこから呼ぶクエリ関数）は、ユーザーとして開いたトランザクション（`user-tx.ts`）を
 *   引数で受け取る。`db` を直接使うと `app.user_id` を設定しないまま問い合わせることになる
 *   （RLS で「何も見えない」になる。それより前にここで落とす）
 * - **system ロールのプール**（`src/db/system.ts`。BYPASSRLS）: 全員ぶんを扱う経路だけ。
 *   🔴 **ログインの経路から import すると、RLS もアプリ層の所有者の条件も素通りできる**
 * - **接続の組み立て**（`src/db/connection.ts`）: プールを作れるので、作る側のモジュールだけ
 *
 * 型だけの import（`import type`・`{ type Tx }` だけ）は許す（実行時に接続を持ち込まない）。
 * **値の import** は下の許可リストのモジュールだけ。足すときは理由を書く。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Boundary {
  /** 守るモジュール（パッケージルートからの相対パス） */
  module: string;
  /** 値として import してよいモジュールと理由 */
  allowed: Record<string, string>;
}

const BOUNDARIES: Boundary[] = [
  {
    module: 'src/db/index.ts',
    allowed: {
      'src/user-tx.ts': 'ログインの経路の唯一の入口（リクエストごとに tx を開いて app.user_id を設定する）',
      'src/auth.ts': 'Better Auth のアダプタ（user / session / account / verification。RLS の対象外）',
      'src/dev-login.ts': '手元の development だけの dev ログイン（user / account の作成と付け替え。RLS の対象外）',
      'link-owner-account.ts': '移行時に 1 回だけ流すエントリ（account / users の付け替え。RLS の対象外）',
    },
  },
  {
    module: 'src/db/system.ts',
    allowed: {
      'src/index.ts': '起動時に system ロールの設定漏れを検出する（fail-closed）',
      'src/worker-routes.ts': '全員ぶん: worker の報告（API_KEY）',
      'src/video-analysis.ts': '全員ぶん: 動画解析の取り込み（API_KEY。所有者専用の手元ツールから）',
      'src/db/seed.ts': 'dev のサンプルデータ投入（「表が空か」を全員ぶんで見る）',
      'generate-drills.ts': '全員ぶん: 一括処理のエントリ',
      'rebuild-positions.ts': '全員ぶん: 一括処理のエントリ',
      'rebuild-subjects.ts': '全員ぶん: 一括処理のエントリ',
      'redetect-tactics.ts': '全員ぶん: 一括処理のエントリ',
    },
  },
  {
    module: 'src/db/connection.ts',
    allowed: {
      'src/db/index.ts': 'server ロールのプールを作る',
      'src/db/system.ts': 'system ロールのプールを作る',
      'migrate.ts': '管理ロールのプールを作る（マイグレーション）',
    },
  },
];

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

function importers(target: string): string[] {
  const absolute = join(PACKAGE_ROOT, target);
  return sourceFiles()
    .filter((file) =>
      importsOf(readFileSync(file, 'utf8')).some(
        ({ specifier, typeOnly }) => !typeOnly && resolveSpecifier(file, specifier) === absolute,
      ),
    )
    .map((file) => relative(PACKAGE_ROOT, file));
}

describe('DB の接続の import 境界（prd/14 §4・prd/15 §2）', () => {
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

  it.each(BOUNDARIES)('$module を値として import するのは許可リストのモジュールだけ', ({ module, allowed }) => {
    expect(importers(module).filter((path) => !(path in allowed))).toEqual([]);
  });

  it.each(BOUNDARIES)('$module の許可リストに、もう import していないモジュールを残さない', ({ module, allowed }) => {
    const actual = new Set(importers(module));
    expect(Object.keys(allowed).filter((path) => !actual.has(path))).toEqual([]);
  });

  it('🔴 RLS を迂回するプールと server ロールのプールを両方 import するモジュールは無い（取り違えを接続の単位で防ぐ）', () => {
    const server = new Set(importers('src/db/index.ts'));
    expect(importers('src/db/system.ts').filter((path) => server.has(path))).toEqual([]);
  });

  it('route.ts（ログインの経路）はどのプールも import しない', () => {
    for (const { module } of BOUNDARIES) {
      expect(importers(module)).not.toContain('src/route.ts');
    }
  });
});
