// 解析結果のチャンク submit（`POST /api/worker/analyses`）の判定ロジック。
// DB 接続を持たない純粋な関数だけを置き、route.ts から使う（テスト可能に保つため）。
//
// 冪等性の担保は 3 箇所に分かれる（prd/03 §3）:
//   1. 同一 `moveNumber` の重複防止 → `UNIQUE(kifuId, moveNumber)` と `resolveExistingMoveAnalyses`
//   2. 前世代の全消去 → `reanalyze` の DELETE（submit 側は DELETE しない）
//   3. 完了の確定 → `isAnalysisComplete`（件数が `usiMoves.length + 1` に達したら）

/** submit を受理してよいか（取得時と同一世代 かつ 失敗記録なし）。prd/05 §1.1a */
export function isChunkAcceptable<
  T extends { revision: number; error: string | null },
>(current: T | undefined, revision: number): current is T {
  if (!current) return false;
  return current.revision === revision && current.error === null;
}

/**
 * 解析が完了したか（`moveAnalyses` の件数が全局面数に達したか）。
 *
 * worker の `isFinal` ではなく **server が件数で判定する**。「揃っていれば完了」という
 * 不変条件で決まるため、worker のクラッシュ位置やチャンク境界に依存しない（prd/05 §1.1c）。
 *
 * @param storedCount 当該棋譜の `moveAnalyses` 件数（`UNIQUE(kifuId, moveNumber)` があるので = 揃った局面数）
 * @param usiMoves 棋譜の指し手列。全局面数は `usiMoves.length + 1`（初期局面を含む）
 */
export function isAnalysisComplete(
  storedCount: number,
  usiMoves: string[] | null,
): boolean {
  if (usiMoves === null) return false;
  return storedCount >= usiMoves.length + 1;
}

/**
 * チャンクの各局面に、既存の `moveAnalyses.id`（あれば）を対応づける。
 *
 * 同一 `moveNumber` の再送（server 側だけ成功した submit を worker が送り直す等）で行が
 * 二重に増えないよう、既存があれば **その行を使い回して `candidateMoves` を入れ直す**。
 * 新規挿入は `existingId === null` のものだけ。
 */
export function resolveExistingMoveAnalyses<T extends { moveNumber: number }>(
  chunk: T[],
  existing: { id: number; moveNumber: number }[],
): { analysis: T; existingId: number | null }[] {
  const idByMoveNumber = new Map(existing.map((r) => [r.moveNumber, r.id]));
  return chunk.map((analysis) => ({
    analysis,
    existingId: idByMoveNumber.get(analysis.moveNumber) ?? null,
  }));
}
