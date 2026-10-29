/**
 * `Dockerfile.prod` の照合（`esbuild.config.ts` がビルド時に呼ぶ。テストからも呼ぶ）。
 *
 * 🔴 `Dockerfile.prod` は dist を丸ごとではなく**1 本ずつ** COPY するので、エントリを足して
 * COPY を書き忘れると**本番でだけファイルが無い**。実際に踏んだ（`generate-drills.js`）。
 *
 * 🔒 本番イメージの最終ステージは `NODE_ENV=production` を明示する（prd/07 §6.1）。
 * 未設定でも dev ログインの抜け道は閉じる（fail-closed）が、明示してここで確かめる。
 */

/** COPY されていないエントリ名 */
export function missingEntryCopies(
  dockerfile: string,
  entryNames: string[],
): string[] {
  return entryNames.filter((name) => !dockerfile.includes(`dist/${name}.js`));
}

/** 最終ステージ（最後の FROM 以降）が `ENV NODE_ENV=production` を持つか */
export function finalStageIsProduction(dockerfile: string): boolean {
  const lines = dockerfile.split('\n').map((l) => l.trim());
  const lastFrom = lines.findLastIndex((l) => /^FROM\s/i.test(l));
  return lines
    .slice(lastFrom + 1)
    .some((l) => /^ENV\s+NODE_ENV\s*=\s*"?production"?\s*$/i.test(l));
}

/** `GET /api/version` が読む ENV（prd/02 §5）。ビルド引数から最終ステージの ENV へ渡す */
export const VERSION_ENV_NAMES = ['GIT_COMMIT', 'BUILD_TIME', 'GIT_DIRTY'] as const;

/** 最終ステージで `ARG <名前>` と `<名前>=$<名前>` の ENV が揃っていない名前 */
export function missingVersionEnv(dockerfile: string): string[] {
  const lines = dockerfile.split('\n').map((l) => l.trim());
  const lastFrom = lines.findLastIndex((l) => /^FROM\s/i.test(l));
  const stage = lines.slice(lastFrom + 1);
  return VERSION_ENV_NAMES.filter((name) => {
    const hasArg = stage.some((l) =>
      new RegExp(`^ARG\\s+${name}(=|\\s*$)`, 'i').test(l),
    );
    const hasEnv = stage.some(
      (l) => /^ENV\s/i.test(l) && l.includes(`${name}=$${name}`),
    );
    return !(hasArg && hasEnv);
  });
}
