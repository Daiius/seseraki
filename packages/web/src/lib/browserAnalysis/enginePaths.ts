/**
 * ブラウザ解析のエンジンの配信物の URL（prd/14 §5.5）。
 *
 * 配信物は web と同じオリジンの `/engine/` に置く（dev は Vite のプラグインが配り、build は `dist/engine/` へ
 * コピーする。`packages/web/engine-plugin`）。一覧は `manifest.json` で、ほかは内容ハッシュ入りのパス。
 */
import {
  ENGINE_BASE_PATH,
  engineAssetPaths,
  parseEngineManifest,
  type EngineManifest,
  type EngineManifestEntry,
} from 'shared';

export interface EngineUrls {
  /** グルー（`importScripts` で読む。`mainScriptUrlOrBlob` にも渡す） */
  glue: string;
  /** グルーが `.worker.js` と `.wasm` を探すディレクトリ（末尾は `/`。`locateFile` で前に付ける） */
  base: string;
  /** 評価関数の本体（`nn.bin`） */
  nn: string;
  /** 進行度（`progress.bin`） */
  progress: string;
}

/**
 * 配信物の URL の基準（オリジンと、web の `base` から末尾の `/` を除いたもの）。`base` が `/`・相対ならオリジンだけ。
 * dev / preview の配信（`engine-plugin`）も `base` を剥がしてから比べるので、`base` の下に置いても揃う
 */
export function engineOriginOf(origin: string, baseUrl: string): string {
  if (!baseUrl.startsWith('/') || baseUrl === '/') return origin;
  return `${origin}${baseUrl.replace(/\/+$/, '')}`;
}

/** manifest の URL。`origin` は末尾に `/` を付けない（`https://example.com`。{@link engineOriginOf}） */
export function engineManifestUrl(origin: string): string {
  return `${origin}${ENGINE_BASE_PATH}manifest.json`;
}

/** manifest の置き場からの相対パス（許諾文など）を絶対 URL にする */
export function engineAssetUrl(origin: string, relativePath: string): string {
  return `${origin}${ENGINE_BASE_PATH}${relativePath}`;
}

/**
 * 選んだ評価関数のエントリから、エンジンのホスト（Worker）に渡す URL を組み立てる。
 * ⚠ **絶対 URL にする**——Worker の中の `importScripts` と `fetch` は Worker のスクリプトの場所を基準に解くので、
 * 相対のままだと `assets/` の下を探しに行く。
 */
export function engineUrls(origin: string, entry: EngineManifestEntry): EngineUrls {
  const paths = engineAssetPaths(entry);
  return {
    glue: engineAssetUrl(origin, paths.js),
    base: engineAssetUrl(origin, `${entry.engine.dir}/`),
    nn: engineAssetUrl(origin, paths.nn),
    progress: engineAssetUrl(origin, paths.progress),
  };
}

/**
 * manifest を取得する。**置かれていなければ null**（エンジンを含めずにビルド・配信した環境）。
 *
 * ⚠ 無いパスに index.html を 200 で返す配信（SPA のフォールバック）でも null になるよう、
 * ステータスだけでなく中身（JSON として読めて、形が合うこと）で判定する。
 * 通信の失敗は投げる（「置かれていない」と区別する）。
 */
export async function fetchEngineManifest(
  origin: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<EngineManifest | null> {
  // manifest は同じパスで中身が変わるので、キャッシュを確かめさせる
  const response = await fetchFn(engineManifestUrl(origin), { cache: 'no-cache' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`エンジンの一覧を取得できません (${response.status})`);
  }
  try {
    return parseEngineManifest(JSON.parse(await response.text()));
  } catch {
    return null;
  }
}
