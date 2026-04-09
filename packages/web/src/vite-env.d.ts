/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_CLIENT_API_KEY?: string;
  readonly VITE_SWARS_USER_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
