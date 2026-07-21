// 解析の進捗表示（`GET /api/analysis/progress` の整形）。
//
// 進捗は N/M と「最終更新からの経過」を必ず組で出す。2 値の「解析中」だけでは worker が
// ハングしても「解析中」のままになり、**進捗が動くこと自体が生存確認になる**という利点が消える。
// 一方で「何分更新が無ければ死んでいる」の閾値は置かない。1 局面あたりの所要時間は
// エンジン構成（MATERIAL/NNUE・depth/byoyomi）で桁が変わり、根拠のある値を選べないため
// （prd/05-analysis.md §1.3・§2.5）。経過時間を出して判断は人に委ねる。

/** server のメモリ上の進捗（`packages/server/src/analysis-progress.ts` と対応） */
export interface AnalysisProgress {
  kifuId: number;
  revision: number;
  analyzed: number;
  total: number;
  updatedAt: string;
}

/** 最終更新からの経過を日本語にする（分単位で読めればよいので秒は 1 分未満のみ） */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  return `${hours}時間${minutes % 60}分前`;
}

/** 「3分前に更新」。`updatedAt` が読めないときは空文字（経過を出さない） */
export function formatUpdatedAgo(
  progress: AnalysisProgress,
  now: number,
): string {
  const updatedAt = Date.parse(progress.updatedAt);
  if (Number.isNaN(updatedAt)) return '';
  return `${formatElapsed(now - updatedAt)}に更新`;
}
