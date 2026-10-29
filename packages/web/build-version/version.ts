// web のビルドの版を組み立てる純粋な関数（prd/02-architecture.md §5「版の確かめ方」）。
// git を呼ぶのは `index.ts`（Vite のプラグイン）。ここは git の出力を受け取って形を決めるだけにし、テストする。

export const UNKNOWN_VERSION = 'unknown';

/** `dist/version.json` とアプリ内（`__BUILD_VERSION__`）に埋め込む値。server の `GET /api/version` と同じ形 */
export type BuildVersion = {
  /** コミットの SHA（40 桁・小文字）。git が無い・取れなければ `unknown` */
  commit: string;
  /** ビルド日時（ISO 8601・UTC） */
  builtAt: string;
  /** 追跡しているファイルに未コミットの変更がある状態でビルドしたか */
  dirty: boolean;
};

export type GitOutputs = {
  /** `git rev-parse HEAD` の出力。失敗したら null */
  head: string | null;
  /** `git status --porcelain --untracked-files=no` の出力。失敗したら null */
  status: string | null;
};

/** 40 桁の SHA なら小文字にして返す。それ以外は `unknown`（どのコミットか言い切れないため） */
export function normalizeCommit(value: string | null): string {
  const v = value?.trim().toLowerCase() ?? '';
  return /^[0-9a-f]{40}$/.test(v) ? v : UNKNOWN_VERSION;
}

/**
 * git の出力から版を組み立てる。コミットが分からないときは dirty も言えないので false にする
 * （`unknown` の表示だけで「どのコミットか分からない」は伝わる）。
 */
export function buildVersionFromGit(git: GitOutputs, now: Date): BuildVersion {
  const commit = normalizeCommit(git.head);
  const dirty =
    commit !== UNKNOWN_VERSION && git.status !== null && git.status.trim() !== '';
  return { commit, builtAt: now.toISOString(), dirty };
}

/** `dist/version.json` の中身 */
export function versionJson(version: BuildVersion): string {
  return `${JSON.stringify(version, null, 2)}\n`;
}
