// `kifuAnalyses`（prd/16）の読み書き。形の解釈は `kifu-analysis-detail.ts` に任せ、
// ここは行の取得と保存（`minMate*` の計算し直しを含む）だけを持つ。

import { eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { kifuAnalyses } from './db/schema.js';
import {
  EMPTY_ANALYSIS,
  minMateBySide,
  type StoredAnalysis,
} from './kifu-analysis-detail.js';
import type { KifuRef, Tx } from './tactics.js';

/**
 * 1 棋譜ぶんを読む。行が無ければ（未解析）空。
 * `forUpdate` はチャンク submit 用（読み → 重ねる → 書き戻すの間に他の submit を挟ませない。prd/16 §4.1）。
 */
export async function loadAnalysis(
  tx: Tx | Db,
  kifuId: number,
  options: { forUpdate?: boolean } = {},
): Promise<StoredAnalysis & { exists: boolean }> {
  const query = tx
    .select({
      detail: kifuAnalyses.detail,
      runs: kifuAnalyses.runs,
      fullCount: kifuAnalyses.fullCount,
    })
    .from(kifuAnalyses)
    .where(eq(kifuAnalyses.kifuId, kifuId));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row ? { ...row, exists: true } : { ...EMPTY_ANALYSIS, exists: false };
}

/**
 * 1 棋譜ぶんを書く（無ければ作る）。
 * 🔴 **`minMate*` は必ずここで `detail` から計算し直す**（prd/16 §3.2）——呼び出し側に渡させない。
 */
export async function saveAnalysis(
  tx: Tx,
  kifu: KifuRef,
  analysis: StoredAnalysis,
): Promise<void> {
  const mate = minMateBySide(analysis.detail);
  const values = {
    detail: analysis.detail,
    runs: analysis.runs,
    fullCount: analysis.fullCount,
    minMateSente: mate.sente,
    minMateGote: mate.gote,
  };
  await tx
    .insert(kifuAnalyses)
    .values({ kifuId: kifu.id, ownerId: kifu.ownerId, ...values })
    .onConflictDoUpdate({ target: kifuAnalyses.kifuId, set: values });
}
