// web のビルドの版（コミットの SHA・ビルド日時・dirty）を埋め込む Vite のプラグイン。
// prd/02-architecture.md §5「版の確かめ方」。
//
// - build: `dist/version.json` を出す（`deploy:web` はトップレベルとして index.html と一緒に送る）
// - アプリ内: `__BUILD_VERSION__`（`define`。型は `src/vite-env.d.ts`）で読める
// - dev: `/version.json` を同じ中身で返す（dev サーバーの起動時点の値）
//
// git が無い・失敗したら `unknown` にして、ビルドは止めない。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { buildVersionFromGit, versionJson, type BuildVersion } from './version.ts';

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));

/** git を呼んで出力を返す。git が無い・リポジトリの外・失敗は null */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: WEB_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** いまの作業ツリーの版。未追跡のファイルは数えない（追跡しているファイルの変更だけを dirty とする） */
export function collectBuildVersion(now = new Date()): BuildVersion {
  return buildVersionFromGit(
    {
      head: git(['rev-parse', 'HEAD']),
      status: git(['status', '--porcelain', '--untracked-files=no']),
    },
    now,
  );
}

const VERSION_PATH = '/version.json';

export function buildVersionPlugin(): Plugin {
  const version = collectBuildVersion();
  const json = versionJson(version);
  return {
    name: 'seseraki-build-version',
    config: () => ({
      define: { __BUILD_VERSION__: JSON.stringify(version) },
    }),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split(/[?#]/, 1)[0];
        if (pathname !== VERSION_PATH) return next();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(json);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: json });
    },
  };
}
