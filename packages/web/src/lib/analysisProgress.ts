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
  /**
   * 実行中の段階。**文字では出さず**、解析中スピナーの見え方（濃さ）の出し分けに使う
   * （prd/05 §2.5・決定 2026-09-05 後段）。
   */
  profile: AnalysisProfile;
  analyzed: number;
  total: number;
  updatedAt: string;
}

/**
 * 解析中の表示を段階で見分けるための不透明度クラス（prd/05 §2.5・決定 2026-09-05 後段）。
 *
 * 🔴 **段階は文字で出さない。** 簡易解析だけが終わっている状態は**直後に詳細解析が走る
 * 一時的な状態**で、そこに「簡易」の語を割くと、**主に使うモバイルで横幅を恒久的に食う**。
 * 見分けが要るのは「いま動いているのがどちらか」だけなので、**解析中のスピナーの濃さ**で示す
 * ——quick 進行中は半透明、full 進行中は通常。
 *
 * ⚠ **不透明度だけを変える**（大きさ・行の高さ・幅は 1px も動かさない）。
 */
export function progressDimClass(profile: AnalysisProfile): string {
  return profile === 'quick' ? 'opacity-50' : '';
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
