/**
 * web と server の版の表示（prd/02 §5「版の確かめ方」）。設定ページの隅に小さく出す。
 * web の版はビルドで埋め込んだ `__BUILD_VERSION__`、server の版は `GET /api/version`。
 */

export type BuildVersion = { commit: string; builtAt: string; dirty: boolean };

const UNKNOWN = 'unknown';
const UNKNOWN_VERSION: BuildVersion = { commit: UNKNOWN, builtAt: UNKNOWN, dirty: false };

/** この web のビルドの版。埋め込みが無い（vitest など）ときは unknown */
export function webBuildVersion(): BuildVersion {
  return typeof __BUILD_VERSION__ === 'undefined' ? UNKNOWN_VERSION : __BUILD_VERSION__;
}

const SHORT_SHA_LENGTH = 7;

/** 短い SHA。40 桁の SHA でなければ `unknown` */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{40}$/i.test(commit) ? commit.slice(0, SHORT_SHA_LENGTH).toLowerCase() : UNKNOWN;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** ビルド日時を端末の時刻帯で `YYYY-MM-DD HH:mm` にする。読めなければ null */
export function formatBuiltAt(builtAt: string): string | null {
  const t = Date.parse(builtAt);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 1 行の表示（例: `aa0922b* 2026-10-30 10:02`）。dirty なら短い SHA の後に `*` を付ける。
 * コミットが分からなければ `unknown` だけ（日時が付いていても、どのコミットか分からないので添えない）
 */
export function formatBuildVersion(v: BuildVersion): string {
  const commit = shortCommit(v.commit);
  if (commit === UNKNOWN) return UNKNOWN;
  const at = formatBuiltAt(v.builtAt);
  const head = `${commit}${v.dirty ? '*' : ''}`;
  return at === null ? head : `${head} ${at}`;
}
