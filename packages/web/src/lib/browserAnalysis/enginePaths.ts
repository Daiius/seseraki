/**
 * ブラウザ解析のエンジンの配信物の URL（prd/14 §5.5）。
 *
 * 配信物は web と同じオリジンの `/engine/` に置く（dev は Vite のプラグインが配り、build は `dist/engine/` へ
 * コピーする。`packages/web/engine-plugin`）。一覧は `manifest.json` で、ほかは内容ハッシュ入りのパス。
 */
import {
  engineAssetPaths,
  parseEngineManifest,
  type EngineManifest,
} from 'shared';

/** 配信物を置くパス（`engine-plugin/serving.ts` の `ENGINE_URL_PREFIX` と同じ値） */
export const ENGINE_BASE_PATH = '/engine/';

export interface EngineUrls {
  /** グルー（`importScripts` で読む。`mainScriptUrlOrBlob` にも渡す） */
  glue: string;
  /** グルーが `.worker.js` と `.wasm` を探すディレクトリ（末尾は `/`。`locateFile` で前に付ける） */
  base: string;
  /** 評価関数 */
  eval: string;
}

/** manifest の URL。`origin` は末尾に `/` を付けない（`https://example.com`） */
export function engineManifestUrl(origin: string): string {
  return `${origin}${ENGINE_BASE_PATH}manifest.json`;
}

/**
 * manifest から、エンジンのホスト（Worker）に渡す URL を組み立てる。
 * ⚠ **絶対 URL にする**——Worker の中の `importScripts` と `fetch` は Worker のスクリプトの場所を基準に解くので、
 * 相対のままだと `assets/` の下を探しに行く。
 */
export function engineUrls(origin: string, manifest: EngineManifest): EngineUrls {
  const paths = engineAssetPaths(manifest);
  const root = `${origin}${ENGINE_BASE_PATH}`;
  return {
    glue: `${root}${paths.js}`,
    base: `${root}${manifest.engine.dir}/`,
    eval: `${root}${paths.eval}`,
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
