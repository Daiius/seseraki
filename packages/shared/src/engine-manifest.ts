// ブラウザ解析のエンジン（やねうら王の WASM ビルド）の配信物の一覧（manifest）の型と検証。
// prd/14-multi-user.md §5.5（配信）・§5.9（来歴）。
//
// manifest を書くのは packages/engine-wasm のビルドスクリプトで、読むのは web（エンジンの読み込み）と
// server（来歴の検証）。型をここに置くのは、GPL のパッケージ（engine-wasm）から TS を import させないため。
// engine-wasm の側はこの形に合う JSON を出すだけにする。
import { z } from 'zod';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 は 64 桁の 16 進');

// 1 階層ぶんの名前（区切り・親ディレクトリへの参照・先頭のドットを通さない）。
// manifest の値をそのまま URL やパスに継ぐので、外へ出る値をここで弾く。
const pathSegment = z
  .string()
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/, '名前に使えない文字がある');

// manifest の置き場からの相対パス（1 階層以上）。
const relativePath = z
  .string()
  .regex(
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/,
    '相対パスに使えない文字がある',
  );

const engineFiles = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ js: value, worker: value, wasm: value });

export const engineManifestSchema = z.object({
  engine: z.object({
    /** 来歴に記録する短い識別子（上流のコミットと、実際にできた wasm で決まる）。 */
    buildId: z.string().regex(/^[0-9a-f]+-[0-9a-f]+$/, 'buildId の形が違う'),
    /** ビルドした上流のコミット（40 桁）。対応ソースの所在を示すのに使う。 */
    upstreamSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, '上流の SHA は 40 桁の 16 進'),
    /** ビルドに使った Emscripten の Docker イメージ（タグが版）。 */
    emsdk: z.string().min(1),
    /** 上流のビルド対象（例: halfkp.noeval）。 */
    target: z.string().min(1),
    /** グルーが公開する関数名（classic の Worker で importScripts した後のグローバル名）。 */
    exportName: z
      .string()
      .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, '識別子として使えない'),
    /** エンジンの 3 ファイルを置いたディレクトリ（manifest の置き場からの相対・内容ハッシュ）。 */
    dir: pathSegment,
    /** `dir` の中のファイル名。グルーが worker と wasm の名前を固定で持つので、名前は上流のまま。 */
    files: engineFiles(pathSegment),
    sha256: engineFiles(sha256Hex),
  }),
  eval: z.object({
    name: z.string().min(1),
    /** 評価関数のファイル（manifest の置き場からの相対・内容ハッシュ入りの名前）。 */
    file: relativePath,
    bytes: z.number().int().positive(),
    sha256: sha256Hex,
  }),
  /** エンジンに渡す `FV_SCALE`。手元 worker と揃える（評価値の尺度が変わると悪手判定の閾値が合わない）。 */
  fvScale: z.number().int().positive(),
});

export type EngineManifest = z.infer<typeof engineManifestSchema>;

/** manifest.json を読んだ値を検証して返す。形が違えば投げる。 */
export function parseEngineManifest(input: unknown): EngineManifest {
  return engineManifestSchema.parse(input);
}

/** 配信物の、manifest の置き場からの相対パス。 */
export interface EngineAssetPaths {
  js: string;
  worker: string;
  wasm: string;
  eval: string;
}

export function engineAssetPaths(manifest: EngineManifest): EngineAssetPaths {
  const { dir, files } = manifest.engine;
  return {
    js: `${dir}/${files.js}`,
    worker: `${dir}/${files.worker}`,
    wasm: `${dir}/${files.wasm}`,
    eval: manifest.eval.file,
  };
}
