// エンジンの配信物（packages/engine-wasm の dist/engine）を配るときの、純粋な判断。
// prd/14-multi-user.md §5.5。プラグイン本体（index.ts）から使い、ここだけを unit テストする。
// ⚠ `shared` からではなく相対パスで読む——Vite の設定の読み込みは `shared` をバンドルせずに外へ出し、node が
// `shared` の `src/index.ts`（拡張子なしの import）を読めずに落ちる。`engine-paths.ts` は何も import しない
import { ENGINE_BASE_PATH, isEnginePathSegment } from '../../shared/src/engine-paths.ts';

export { ENGINE_BASE_PATH };

/** エンジンのホスト（classic の Worker のスクリプト）を dev / preview で配る URL */
export const ENGINE_HOST_DEV_URL = '/engine-host.js';

/**
 * SharedArrayBuffer を使うためのヘッダ（cross-origin isolation）。
 *
 * 🔒 **全応答に付ける**（ページだけでなく、Worker のスクリプト・`/engine/*`・`/api` の応答にも）。
 * Worker のスクリプトに COEP が無いと、その Worker は読み込めない。
 * Safari は `credentialless` に対応していないので `require-corp` にする。
 */
export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

/** URL からクエリとフラグメントを落としたパス */
export function pathnameOf(url: string): string {
  return url.split(/[?#]/, 1)[0];
}

/**
 * Vite の `base` を剥がしたパス（`/` から始まる）。`base` の下でなければ null（このプラグインでは扱わない）。
 * プラグインのミドルウェアは Vite の内部のミドルウェア（`base` を剥がすもの）より前に置くので、自分で剥がす。
 * `base` が `/` や相対（`./`・空。build だけで使う形）なら何もしない
 */
export function stripBase(url: string, base: string): string | null {
  if (!base.startsWith('/') || base === '/') return url;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  if (!url.startsWith(prefix)) return null;
  return `/${url.slice(prefix.length)}`;
}

/**
 * リクエストの URL（`base` を剥がしたもの）を、配信物のディレクトリからの相対パスにする。`/engine/` の下でなければ null。
 *
 * 🔒 ディレクトリの外へ出るパス（`..`・空の区間・バックスラッシュ・先頭のドット）は null（配らない）。
 * 通すのは manifest と同じ形の名前だけ（`shared` の `isEnginePathSegment`）。
 */
export function engineRelativePath(url: string): string | null {
  const pathname = pathnameOf(url);
  if (!pathname.startsWith(ENGINE_BASE_PATH)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(ENGINE_BASE_PATH.length));
  } catch {
    return null;
  }
  if (rel === '') return null;
  const segments = rel.split('/');
  if (!segments.every(isEnginePathSegment)) {
    return null;
  }
  return segments.join('/');
}

/** 配信物の Content-Type。⚠ wasm は `application/wasm` でないとストリーミングのコンパイルが失敗する */
export function engineContentType(rel: string): string {
  if (rel.endsWith('.wasm')) return 'application/wasm';
  if (rel.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (rel.endsWith('.json')) return 'application/json; charset=utf-8';
  // 評価関数の許諾文（MIT。engine/eval/license-<hash>.txt）
  if (rel.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * 配信物の Cache-Control。
 * - `manifest.json` は同じパスで中身が変わるので、毎回確かめさせる
 * - ほかは内容ハッシュ入りのパスなので、長期キャッシュに載せる
 */
export function engineCacheControl(rel: string): string {
  return rel === 'manifest.json'
    ? 'no-cache'
    : 'public, max-age=31536000, immutable';
}

/**
 * ビルドで出すエンジンのホストのファイル名（`assets/` の下・内容ハッシュ入り）。
 * `assets/` に置くのは、長期キャッシュと「今回と 1 つ前だけ残す」デプロイ（deploy-static）に載せるため。
 */
export function engineHostAssetName(contentHash: string): string {
  return `assets/engine-host-${contentHash.slice(0, 12)}.js`;
}

/** エンジンの配信物が無いときにビルドを落とすか（`ENGINE_REQUIRED=1`。デプロイ用のビルドで立てる） */
export function isEngineRequired(
  env: Record<string, string | undefined>,
): boolean {
  const value = env.ENGINE_REQUIRED;
  return value === '1' || value === 'true';
}
