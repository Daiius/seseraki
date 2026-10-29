/**
 * 解析結果の送信の失敗の分類（prd/05 §1.1a・prd/16 §4.1）。HTTP の状態と送信の例外だけを持ち、解析のループには依存しない。
 *
 * 手元 worker（`ChunkSubmitError` / `SubmitRejectedError` を `analyzeKifu` の `onChunk` から投げる）と
 * ブラウザ解析（`isPermanentSubmitStatus` で状態を分類する）で共用する。
 */

/**
 * チャンク submit の失敗（インフラ起因の一時失敗）。
 * `analyzeKifu` の `onChunk` がこれを投げると解析は中断され、次の poll で続きから再開する（prd/05 §1.1a）。
 */
export class ChunkSubmitError extends Error {
  constructor(cause: unknown) {
    super(
      `Failed to submit analysis chunk: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "ChunkSubmitError";
  }
}

/**
 * チャンク submit を server が**入力の誤りとして拒否した**（4xx。prd/05 §1.1a・prd/16 §4.1）。
 *
 * 🔴 **恒久失敗として扱う。** 同じ棋譜を解析し直しても同じ結果を送るので、一時失敗（{@link ChunkSubmitError}）
 * と同じく次の poll へ回すと、**同じ棋譜を解析しては拒否される堂々巡り**になり後続が進まない。
 * 呼び出し側は `analysisError` を記録して poll から外す。
 */
export class SubmitRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Analysis chunk rejected by server: ${status}`);
    this.name = "SubmitRejectedError";
  }
}

/**
 * submit の HTTP ステータスが**恒久失敗**（入力の誤り）か。
 *
 * - 4xx は恒久（範囲外・連続でない・rank の欠番など。送り直しても変わらない）
 * - ⚠ ただし **401 / 403（API_KEY の誤り）・408 / 429（混雑）は除く**——棋譜ではなく構成や
 *   一時的な状況の問題で、恒久扱いにすると**全棋譜が失敗として記録される**
 * - 5xx・通信エラーは一時失敗（今どおり次の poll で続きから再開）
 * - 世代の不一致は 201（`applied: false`）で返るので、ここには来ない
 */
export function isPermanentSubmitStatus(status: number): boolean {
  if (status < 400 || status >= 500) return false;
  return ![401, 403, 408, 429].includes(status);
}
