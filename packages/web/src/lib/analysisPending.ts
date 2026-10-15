/**
 * 「この棋譜は解析の完了を待っているか」の判定（prd/05 §2.5・prd/14 §5.7）。
 *
 * 🔒 **完了は解析する側（担当）によらず、詳細解析（full）まで終わったとき。**
 * 簡易解析（quick）だけの棋譜は、続けて詳細解析が走るので「まだ待っている」。
 * サーバー（手元 worker）でもブラウザでも、2 段（quick → full）で回す。
 * ⚠ 改定前（ブラウザが 1 段だった頃）は、ブラウザで解析するユーザーは quick の完了を完了としていた。
 *
 * 失敗の記録がある棋譜は進まないので待たない（やり直すのは再解析だけ）。
 */
export interface AnalysisPendingInput {
  /** 完了した段階（`kifus.analysisProfile`）。どの段階も完了していなければ null */
  analysisProfile: 'quick' | 'full' | null;
  /** 失敗の記録があるか */
  failed: boolean;
}

export function isAnalysisPending(kifu: AnalysisPendingInput): boolean {
  if (kifu.failed) return false;
  return kifu.analysisProfile !== 'full';
}
