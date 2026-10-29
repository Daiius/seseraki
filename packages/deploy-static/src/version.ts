// 送るビルドの版（`dist/version.json`。prd/02-architecture.md §5「版の確かめ方」）を読んで、
// デプロイの計画と一緒に表示する。`version.json` はトップレベルとして index.html と一緒に送られる。

/** `version.json` を読んで 1 行にする。読めなければ投げる（取り違えたビルドを送らないため） */
export function describeBuildVersion(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('version.json を JSON として読めない。web をビルドし直す');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { commit?: unknown }).commit !== 'string' ||
    typeof (parsed as { builtAt?: unknown }).builtAt !== 'string' ||
    typeof (parsed as { dirty?: unknown }).dirty !== 'boolean'
  ) {
    throw new Error('version.json の形が違う（commit / builtAt / dirty）。web をビルドし直す');
  }
  const { commit, builtAt, dirty } = parsed as {
    commit: string;
    builtAt: string;
    dirty: boolean;
  };
  const notes: string[] = [];
  if (commit === 'unknown') notes.push('⚠ コミットが分からない（git が無い環境でビルドした）');
  if (dirty) notes.push('⚠ 未コミットの変更を含むビルド');
  return [`版: ${commit}（ビルド ${builtAt}）`, ...notes].join('\n');
}
