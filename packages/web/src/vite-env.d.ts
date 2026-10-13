/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// エンジンのホスト（classic の Worker のスクリプト）の URL。Vite のプラグイン（engine-plugin）が解決する
declare module 'virtual:engine-host' {
  export const engineHostUrl: string;
}
