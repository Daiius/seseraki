/**
 * ブラウザ解析の案内（同意・ダウンロードの進捗・設定のページ）に出す値の書き方。
 */

/** バイト数を「8.7MB」の形にする（10MB 未満は小数 1 桁。「約」は文の側に書く） */
export function megabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb < 10 ? `${mb.toFixed(1)}MB` : `${Math.round(mb)}MB`;
}
