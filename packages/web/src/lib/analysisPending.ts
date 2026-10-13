/**
 * 「この棋譜は解析の完了を待っているか」の判定（prd/05 §2.5・prd/14 §5.7）。
 *
 * 🔒 **完了の線は、解析する側（担当）で変わる。**
 * - サーバー（手元 worker）で解析: 詳細解析（full）まで終わって完了。簡易解析（quick）だけの棋譜は、
 *   直後に詳細解析が走るので「まだ待っている」
 * - ブラウザで解析: ブラウザは 1 段しか回さず、それを quick として保存する。**quick の完了が完了**
 *   （full の席は空いたまま。待ち続けない）
 *
 * 失敗の記録がある棋譜は進まないので待たない（やり直すのは再解析だけ）。
 */
import type { AnalysisAssignee } from './auth';

export interface AnalysisPendingInput {
  /** 完了した段階（`kifus.analysisProfile`）。どの段階も完了していなければ null */
  analysisProfile: 'quick' | 'full' | null;
  /** 失敗の記録があるか */
  failed: boolean;
}

export function isAnalysisPending(
  kifu: AnalysisPendingInput,
  assignee: AnalysisAssignee,
): boolean {
  if (kifu.failed) return false;
  return assignee === 'browser'
    ? kifu.analysisProfile === null
    : kifu.analysisProfile !== 'full';
}
