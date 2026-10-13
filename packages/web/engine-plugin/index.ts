// ブラウザ解析のエンジン（packages/engine-wasm の成果物）を web から配るための Vite プラグイン。
// prd/14-multi-user.md §5.5・prd/02-architecture.md §5。
//
// - dev / preview: `/engine/*` を `ENGINE_DIST_DIR`（既定は ../engine-wasm/dist/engine）から配る
// - build: 同じディレクトリを `dist/engine/` へコピーする
// - 全応答に COOP / COEP を付ける（dev / preview。本番は静的配信の側で付ける）
// - エンジンのホスト（classic の Worker のスクリプト）を、変換を通さずそのまま配る
//
// 🔒 **エンジン本体もホストも Vite のバンドルに通さない。** エンジンのグルーはグローバルの名前と、隣にある
// `.worker.js` / `.wasm` の名前に依存する（engine-wasm の README）。ホストは `importScripts` でそれを読む
// classic の Worker なので、モジュールとして変換されると動かない。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin, ResolvedConfig } from 'vite';
import {
  ENGINE_HOST_DEV_URL,
  ENGINE_URL_PREFIX,
  ISOLATION_HEADERS,
  engineCacheControl,
  engineContentType,
  engineHostAssetName,
  engineRelativePath,
  isEngineRequired,
} from './serving.ts';

/** web のコードがホストの URL を受け取る仮想モジュール（型は `src/vite-env.d.ts`） */
const VIRTUAL_ID = 'virtual:engine-host';
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;

export function enginePlugin(): Plugin {
  let config: ResolvedConfig;
  let engineDir = '';
  let hostSourcePath = '';
  /** ビルドで出したホストのファイル名（`assets/engine-host-<hash>.js`） */
  let hostAssetName: string | null = null;

  const readHostSource = () => fs.readFileSync(hostSourcePath, 'utf8');

  /** dev / preview のミドルウェア。ヘッダを全応答に付け、`/engine/*` とホストを配る */
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
      res.setHeader(name, value);
    }
    const url = req.url ?? '';
    const pathname = url.split(/[?#]/, 1)[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    if (pathname === ENGINE_HOST_DEV_URL) {
      const body = readHostSource();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    if (!pathname.startsWith(ENGINE_URL_PREFIX)) return next();
    // ⚠ `/engine/` の下は、無ければ 404 を返す（next へ流すと SPA のフォールバックが index.html を 200 で返す）
    const rel = engineRelativePath(url);
    const file = rel === null ? null : path.join(engineDir, rel);
    const stat =
      file === null ? undefined : fs.statSync(file, { throwIfNoEntry: false });
    if (rel === null || file === null || !stat?.isFile()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end('not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', engineContentType(rel));
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', engineCacheControl(rel));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file)
      .on('error', (error) => res.destroy(error))
      .pipe(res);
  };

  return {
    name: 'seseraki:engine',

    configResolved(resolved) {
      config = resolved;
      engineDir = path.resolve(
        resolved.root,
        process.env.ENGINE_DIST_DIR ?? '../engine-wasm/dist/engine',
      );
      hostSourcePath = path.join(resolved.root, 'engine-plugin/engine-host.js');
    },

    configureServer(server) {
      // 返り値の関数にせず、ここで登録する（Vite の内部ミドルウェアより前。全応答にヘッダを付けるため）
      server.middlewares.use(middleware);
      if (!fs.existsSync(path.join(engineDir, 'manifest.json'))) {
        config.logger.warn(
          `[engine] ${engineDir} に manifest.json がありません。ブラウザ解析は動きません（pnpm engine:build で作る）`,
        );
      }
    },

    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },

    buildStart() {
      if (config.command !== 'build') return;
      const source = readHostSource();
      const hash = createHash('sha256').update(source).digest('hex');
      hostAssetName = engineHostAssetName(hash);
      this.emitFile({ type: 'asset', fileName: hostAssetName, source });
    },

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : null;
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return null;
      const url =
        config.command === 'build' && hostAssetName !== null
          ? `${config.base}${hostAssetName}`
          : `${config.base}${ENGINE_HOST_DEV_URL.slice(1)}`;
      return `export const engineHostUrl = ${JSON.stringify(url)};\n`;
    },

    closeBundle() {
      if (config.command !== 'build') return;
      const required = isEngineRequired(process.env);
      if (!fs.existsSync(path.join(engineDir, 'manifest.json'))) {
        const message = `[engine] ${engineDir} に manifest.json がありません（pnpm engine:build で作る）`;
        if (required) throw new Error(message);
        config.logger.warn(
          `${message}。エンジンを含めずにビルドします（ブラウザ解析は動きません）`,
        );
        return;
      }
      const outDir = path.resolve(config.root, config.build.outDir, 'engine');
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.cpSync(engineDir, outDir, { recursive: true });
      config.logger.info(`[engine] ${engineDir} → ${outDir}`);
    },
  };
}
