// 解析の進捗表示（`GET /api/analysis/progress` の整形）。
//
// 進捗は N/M と「最終更新からの経過」を必ず組で出す。2 値の「解析中」だけでは worker が
// ハングしても「解析中」のままになり、**進捗が動くこと自体が生存確認になる**という利点が消える。
// 一方で「何分更新が無ければ死んでいる」の閾値は置かない。1 局面あたりの所要時間は
// エンジン構成（MATERIAL/NNUE・depth/byoyomi）で桁が変わり、根拠のある値を選べないため
// （prd/05-analysis.md §1.3・§2.5）。経過時間を出して判断は人に委ねる。

/** 解析の段階（prd/05 §1.1d）。**2 つ固定**で、名前に強さの順序を持たせる（quick < full） */
export type AnalysisProfile = 'quick' | 'full';

/** server のメモリ上の進捗（`packages/server/src/analysis-progress.ts` と対応） */
export interface AnalysisProgress {
  kifuId: number;
  revision: number;
  /** 実行中の段階。「簡易解析中 / 詳細解析中」の出し分けに使う（prd/05 §2.5） */
  profile: AnalysisProfile;
  analyzed: number;
  total: number;
  updatedAt: string;
}

/**
 * 進捗の見出し（「簡易解析中」/「詳細解析中」）。
 *
 * 段階を文言に出すのは、**quick が終わった後も解析が続く**ため
 * （「解析中」のままだと、済んだはずの棋譜がまた解析中に見える）。prd/05 §2.5
 */
export function analyzingTitle(profile: AnalysisProfile): string {
  return profile === 'quick' ? '簡易解析中' : '詳細解析中';
}

/** 段階の短い印（一覧・候補手欄に添える）。full は無印（それが既定の解析だから） */
export function profileBadgeText(
  profile: AnalysisProfile | null | undefined,
): string | null {
  return profile === 'quick' ? '簡易' : null;
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
