import { isAnalysisPending, type AnalysisPendingInput } from './analysisPending';

/**
 * 棋譜詳細の「問題 N」のボタンの状態（prd/13 §7.10）。押せないときは理由の文を添える。
 *
 * 判定の順（レビュー `OCL-477E7FBE`）:
 * 1. 問題が 1 問でもあれば押せる（解析の状態によらない）——再解析しても問題は消さず、作り直しは full の完了のとき（§8）。
 *    再解析の最中でも、ある問題は解ける
 * 2. 解析が終わっていない（`isAnalysisPending`）
 * 3. 解析に失敗した
 * 4. それ以外（full まで終わって 0 問）
 */
export type KifuDrillsState = { enabled: true } | { enabled: false; reason: string };

export function kifuDrillsState(kifu: AnalysisPendingInput & { drillCount: number }): KifuDrillsState {
  if (kifu.drillCount > 0) return { enabled: true };
  if (isAnalysisPending(kifu)) return { enabled: false, reason: '解析が終わると問題ができます' };
  if (kifu.failed) return { enabled: false, reason: '解析が終わらなかったため、問題はありません' };
  return { enabled: false, reason: 'この対局から問題はできませんでした' };
}
