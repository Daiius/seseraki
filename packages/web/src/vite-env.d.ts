/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// web のビルドの版（prd/02 §5）。`build-version/index.ts` のプラグインが `define` で埋め込む。
// vitest（プラグインを積まない）では未定義なので、直接は読まず `lib/buildVersion.ts` の `webBuildVersion` を通す
declare const __BUILD_VERSION__: { commit: string; builtAt: string; dirty: boolean } | undefined;

// エンジンのホスト（classic の Worker のスクリプト）の URL。Vite のプラグイン（engine-plugin）が解決する
declare module 'virtual:engine-host' {
  export const engineHostUrl: string;
}
