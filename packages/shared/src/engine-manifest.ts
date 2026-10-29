// ブラウザ解析のエンジン（やねうら王の WASM ビルド）と評価関数の配信物の一覧（manifest）の型と検証。
// prd/14-multi-user.md §5.5（配信・評価関数の選択）・§5.9（来歴）。
//
// manifest を書くのは packages/engine-wasm のビルドスクリプトで、読むのは web（エンジンの読み込み）。
// 型をここに置くのは、GPL のパッケージ（engine-wasm）から TS を import させないため。
// engine-wasm の側はこの形に合う JSON を出すだけにする。
//
// 形: 評価関数の一覧（`evals`）と既定（`defaultId`）。評価関数の型（arch）はエンジンのコンパイル時に固定なので、
// 各エントリが自分のエンジン（arch ごとのビルド）を持つ。arch が同じエントリはエンジンを共有してよい。
import { z } from 'zod';
import { ENGINE_PATH_SEGMENT_PATTERN } from './engine-paths';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 は 64 桁の 16 進');

// 1 階層ぶんの名前（形は engine-paths.ts の 1 か所で決める）。
const segmentRegex = new RegExp(`^${ENGINE_PATH_SEGMENT_PATTERN}$`);

const pathSegment = z.string().regex(segmentRegex, '名前に使えない文字がある');

// manifest の置き場からの相対パス（1 階層以上）。
const relativePath = z
  .string()
  .regex(
    new RegExp(`^${ENGINE_PATH_SEGMENT_PATTERN}(\\/${ENGINE_PATH_SEGMENT_PATTERN})*$`),
    '相対パスに使えない文字がある',
  );

const engineFiles = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ js: value, worker: value, wasm: value });

/** 評価関数のファイル（`nn.bin` / `progress.bin`） */
const evalFileSchema = z.object({
  /** manifest の置き場からの相対・内容ハッシュ入りの名前 */
  file: relativePath,
  bytes: z.number().int().positive(),
  sha256: sha256Hex,
});

export const engineManifestEntrySchema = z.object({
  /** 評価関数の id（端末の設定に保存する。例: `tsuyo11mini`） */
  id: z.string().regex(/^[a-z0-9]+$/, 'id は英小文字と数字').max(32),
  /** 表示名（例: つようら王11mini） */
  name: z.string().min(1).max(64),
  engine: z.object({
    /** 来歴に記録する短い識別子（上流のコミットと、実際にできた wasm で決まる。arch ごとに別） */
    buildId: z.string().regex(/^[0-9a-f]+-[0-9a-f]+$/, 'buildId の形が違う'),
    /** ビルドした上流のコミット（40 桁）。対応ソースの所在を示すのに使う。 */
    upstreamSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, '上流の SHA は 40 桁の 16 進'),
    /** ビルドに使った Emscripten の Docker イメージ（タグが版）。 */
    emsdk: z.string().min(1),
    /** 上流の Makefile の `YANEURAOU_EDITION`（arch を決める） */
    edition: z.string().regex(/^YANEURAOU_ENGINE_[A-Za-z0-9_]+$/, 'EDITION の形が違う'),
    /** グルーが公開する関数名（classic の Worker で importScripts した後のグローバル名）。 */
    exportName: z
      .string()
      .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, '識別子として使えない'),
    /** エンジンの 3 ファイルを置いたディレクトリ（manifest の置き場からの相対・内容ハッシュ）。 */
    dir: pathSegment,
    /** `dir` の中のファイル名。グルーが worker と wasm の名前を固定で持つ。 */
    files: engineFiles(pathSegment),
    sha256: engineFiles(sha256Hex),
  }),
  /** 評価関数の本体。来歴の `evalHash` はこの sha256 */
  nn: evalFileSchema,
  /** 進行度（つようら王11 の SFNN が `nn.bin` と別に `EvalDir` から読む）。manifest の sha256 で照合し、来歴には載せない */
  progress: evalFileSchema,
  /** エンジンに渡す `FV_SCALE`。手元 worker と揃える（評価値の尺度が変わると悪手判定の閾値が合わない）。 */
  fvScale: z.number().int().positive(),
  /** 評価関数のライセンスと出典（設定ページに出す） */
  license: z.object({
    name: z.string().min(1).max(64),
    sourceUrl: z.string().regex(/^https:\/\/[^\s"<>]+$/, '出典は https の URL'),
    /** 許諾文（manifest の置き場からの相対） */
    file: relativePath.optional(),
  }),
});

export type EngineManifestEntry = z.infer<typeof engineManifestEntrySchema>;

export const engineManifestSchema = z
  .object({
    /** 既定の評価関数の id（端末で選んでいない・選んだものが無いとき） */
    defaultId: z.string().min(1),
    evals: z.array(engineManifestEntrySchema).min(1),
  })
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    for (const [index, entry] of manifest.evals.entries()) {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evals', index, 'id'],
          message: `評価関数の id が重複している: ${entry.id}`,
        });
      }
      ids.add(entry.id);
    }
    if (!ids.has(manifest.defaultId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultId'],
        message: `既定の評価関数が一覧に無い: ${manifest.defaultId}`,
      });
    }
  });

export type EngineManifest = z.infer<typeof engineManifestSchema>;

/** manifest.json を読んだ値を検証して返す。形が違えば投げる。 */
export function parseEngineManifest(input: unknown): EngineManifest {
  return engineManifestSchema.parse(input);
}

/**
 * 選んだ評価関数のエントリ。選んでいない（null）・一覧に無い id なら既定を返す（prd/14 §5.10）。
 */
export function engineEntryOf(
  manifest: EngineManifest,
  id: string | null | undefined,
): EngineManifestEntry {
  const chosen = id ? manifest.evals.find((entry) => entry.id === id) : undefined;
  // 既定が一覧にあることは検証済み
  return chosen ?? manifest.evals.find((entry) => entry.id === manifest.defaultId)!;
}

/** 評価関数のダウンロードの大きさ（`nn.bin` と `progress.bin` の合計・圧縮前） */
export function engineEntryDownloadBytes(entry: EngineManifestEntry): number {
  return entry.nn.bytes + entry.progress.bytes;
}

/** 配信物の、manifest の置き場からの相対パス。 */
export interface EngineAssetPaths {
  js: string;
  worker: string;
  wasm: string;
  nn: string;
  progress: string;
}

export function engineAssetPaths(entry: EngineManifestEntry): EngineAssetPaths {
  const { dir, files } = entry.engine;
  return {
    js: `${dir}/${files.js}`,
    worker: `${dir}/${files.worker}`,
    wasm: `${dir}/${files.wasm}`,
    nn: entry.nn.file,
    progress: entry.progress.file,
  };
}
