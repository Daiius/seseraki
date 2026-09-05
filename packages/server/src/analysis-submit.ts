// 解析結果のチャンク submit（`POST /api/worker/analyses`）の判定ロジック。
// DB 接続を持たない純粋な関数だけを置き、route.ts から使う（テスト可能に保つため）。
//
// 冪等性の担保は 3 箇所に分かれる（prd/03 §3）:
//   1. 同一 `moveNumber` の重複防止 → `UNIQUE(kifuId, moveNumber)` と `resolveExistingMoveAnalyses`
//   2. 前世代の全消去 → `reanalyze` の DELETE（submit 側は DELETE しない）
//   3. 完了の確定 → `isAnalysisComplete`（**段階ごとの**件数が `usiMoves.length + 1` に達したら）
//   4. 段階の後退防止 → `canWriteRow`（既存行の段階以上のときだけ書く）
//
// 2 段階解析（quick / full。prd/05 §1.1d）では、**完了は段階ごとに読む**。
// `analysisCompletedAt` は quick 完了で立つので、これを段階と無関係に使うと
// **full のチャンクが最初から全部拒否される**。

/**
 * **解析状態をリセットするときに戻す列**（`reanalyze` と動画棋譜の上書き。prd/05 §1.1a・§1.1d）。
 *
 * 🔴 **3 列は必ず揃えて戻す。** `analysisProfile` を戻し忘れると、
 * **worker は拾えるのに submit が全部拒否される**棋譜ができる——poll は
 * `analysisCompletedAt IS NULL` で拾うのに、submit の受理判定は `analysisProfile='full'` を
 * 「full 完了済み」と読むため、そのチャンクが毎回捨てられ**解析キューに残り続ける**
 * （レビュー `OCL-4EB35091`。動画棋譜の再取り込みで実際に踏んだ）。
 *
 * 呼び出し側は `analysisRevision` の +1 と `usiMoves` の差し替えを添える
 * （世代は SQL 式・指し手は経路ごとに違うのでここには入れない）。
 */
export const ANALYSIS_STATE_RESET = {
  analysisError: null,
  analysisCompletedAt: null,
  analysisProfile: null,
} as const;

/** 解析の段階（prd/05 §1.1d）。**2 つ固定**で、名前に強さの順序を持たせる（quick < full） */
export type AnalysisProfile = 'quick' | 'full';

/** 段階の強さ。上書き規則（既存行の段階以上なら書く）と完了判定の比較に使う */
const PROFILE_RANK: Record<AnalysisProfile, number> = { quick: 1, full: 2 };

/**
 * その棋譜で `stage` が完了しているか。
 *
 * 🔴 **完了は段階ごとに読む。** `analysisCompletedAt`（＝「初めて全局面が揃った時刻」）は
 * quick 完了で立つため、段階と無関係に使うと **quick 完了後の full が
 * 「もう終わっている」と誤判定され、チャンクも進捗も全部弾かれる**（prd/05 §1.1b・§1.1d）。
 *
 * 完了した段階のうち最も高いものは `kifus.analysisProfile` にある。
 * `analysisProfile` が null のまま `analysisCompletedAt` だけ立っている行（移行前の取りこぼし）は
 * **quick は完了**と読む——全局面が揃っている以上、quick をやり直させる理由がない。
 */
export function isStageComplete(
  kifu: { completedAt: Date | null; analysisProfile: AnalysisProfile | null },
  stage: AnalysisProfile,
): boolean {
  if (kifu.analysisProfile !== null) {
    return PROFILE_RANK[kifu.analysisProfile] >= PROFILE_RANK[stage];
  }
  // 段階が記録されていない完了済み棋譜は quick 相当（full は未完了）
  return stage === 'quick' && kifu.completedAt !== null;
}

/**
 * submit を受理してよいか（取得時と同一世代 かつ 失敗記録なし かつ **その段階が未完了**）。
 * prd/05 §1.1a・§1.1d
 *
 * **完了済みへのチャンクは破棄する**。同じ世代を掴んだ worker が 2 つあると（`GET /api/worker/kifus`
 * に lease は無い）、片方が完了させた後に遅れて届いたチャンクが完了済みの結果を部分的に上書きし、
 * 異なる実行の評価値が混ざる。完了後の解析結果は不変にする（作り直しは `reanalyze` の経路のみ）。
 * ⚠ **「完了済み」は段階ごと**——full 完了済みへのチャンクは破棄し、
 * quick 完了済みの棋譜への full チャンクは受理する。
 */
export function isChunkAcceptable<
  T extends {
    revision: number;
    error: string | null;
    completedAt: Date | null;
    analysisProfile: AnalysisProfile | null;
  },
>(
  current: T | undefined,
  revision: number,
  stage: AnalysisProfile,
): current is T {
  if (!current) return false;
  return (
    current.revision === revision &&
    current.error === null &&
    !isStageComplete(current, stage)
  );
}

/**
 * その局面に届いたチャンクを書いてよいか（**既存行の段階以上のときだけ**。prd/05 §1.1d）。
 *
 * 既存が full の局面に quick が届いたら**書かずに無視する**（単一 worker では起きないが安い保険）。
 * 同段階の再送は受け入れる（入れ直し・現行どおり）。
 */
export function canWriteRow(
  existing: AnalysisProfile | null | undefined,
  incoming: AnalysisProfile,
): boolean {
  if (existing === null || existing === undefined) return true;
  return PROFILE_RANK[incoming] >= PROFILE_RANK[existing];
}

/**
 * 完了した段階を踏まえた `kifus.analysisProfile` の次の値。
 *
 * **後退させない**（既に full なら quick へ落とさない）。行数から導く値なので、
 * 遅れて届いたチャンクや段階の混在で下がることがないようにする。
 */
export function nextKifuProfile(
  existing: AnalysisProfile | null,
  completed: { quick: boolean; full: boolean },
): AnalysisProfile | null {
  const reached: AnalysisProfile | null = completed.full
    ? 'full'
    : completed.quick
      ? 'quick'
      : null;
  if (reached === null) return existing;
  if (existing === null) return reached;
  return PROFILE_RANK[existing] >= PROFILE_RANK[reached] ? existing : reached;
}

/**
 * チャンクの `moveNumber` がすべて棋譜の有効範囲（`0..usiMoves.length`）に収まるか。
 *
 * 完了を件数で判定する（{@link isAnalysisComplete}）以上、**範囲外の行を受け入れると
 * 「必要な局面が欠けたまま件数だけ達する」ことがありうる**（例: 2 手の棋譜に 0/1/99 が入ると
 * 3 件で完了扱いになる）。しかも完了すると poll 対象から外れるため、自動再開でも修復されない。
 *
 * 範囲を保証すれば、`UNIQUE(kifuId, moveNumber)` が値の重複を防ぐので
 * **件数 = `usiMoves.length + 1` ⇒ 全局面が揃っている**が成り立つ。
 */
export function isChunkInRange(
  chunk: { moveNumber: number }[],
  usiMoves: string[] | null,
): boolean {
  // usiMoves が無い棋譜は解析対象にならない（poll から除外される）。書き込みは受け付けない
  if (usiMoves === null) return chunk.length === 0;
  return chunk.every(
    (a) =>
      Number.isInteger(a.moveNumber) &&
      a.moveNumber >= 0 &&
      a.moveNumber <= usiMoves.length,
  );
}

/**
 * 解析が完了したか（`moveAnalyses` の件数が全局面数に達したか）。
 *
 * worker の `isFinal` ではなく **server が件数で判定する**。「揃っていれば完了」という
 * 不変条件で決まるため、worker のクラッシュ位置やチャンク境界に依存しない（prd/05 §1.1c）。
 *
 * ⚠ **2 段階解析では段階ごとに数える**（prd/05 §1.1d）: quick は全行数、full は
 * `profile='full'` の行数（full は 0 から順に上書きするので、full 行は常に先頭からの連続区間になる）。
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
