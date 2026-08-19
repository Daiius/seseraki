/**
 * 局面索引の保存（prd/10 §3.2）。
 *
 * 局面キーの計算そのものは `shared`（`positionKey`）が持つ。ここは
 * **`usiMoves` の変化に追随して `kifuPositions` を置き換える**責務だけを持つ
 * （`tactics.ts` と同じ立場）。
 *
 * ⚠ **ロジックはここに置き、スクリプトは薄い entry point にする。**
 */
import { eq } from 'drizzle-orm';
import { buildPositions, positionKey } from 'shared';
import { kifuPositions } from './db/schema';
import type { Tx } from './tactics';

/** 一度に INSERT する行数。1 局 100 手程度なので普通は 1 回で収まる */
const CHUNK = 500;

/**
 * 1 局ぶんの局面索引を**原子的に置き換える**。
 *
 * 旧行の DELETE と新行の INSERT を**同じトランザクションで**行う。
 * この表は局面検索の索引なので、DELETE 済み・INSERT 前の状態が読まれると
 * **その棋譜だけ黙って検索から外れる**（`kifuTactics` と同じ理由。prd/03 §2.1）。
 *
 * `usiMoves` が null（パース失敗・非平手）のときは**空に置換する**。
 * 指し手列が無い以上、局面は「不明」であって「以前の値」ではない。
 *
 * @returns 書き込んだ行数（初期局面を含むので手数 + 1）
 */
export async function replacePositions(
  tx: Tx,
  kifuId: number,
  usiMoves: string[] | null,
): Promise<number> {
  await tx.delete(kifuPositions).where(eq(kifuPositions.kifuId, kifuId));
  if (!usiMoves || usiMoves.length === 0) return 0;

  // buildPositions は [初期局面, 1手目後, ...] を返す。
  // ⭐ moveNumber = i の行が持つ `move` は **i 手目の指し手**（その局面に至った手）
  const states = buildPositions(usiMoves);
  const rows = states.map((state, i) => {
    const key = positionKey(state);
    return {
      kifuId,
      moveNumber: i,
      move: i === 0 ? null : usiMoves[i - 1],
      sfen: key.sfen,
      senteSfen: key.senteSfen,
      goteSfen: key.goteSfen,
      // drizzle の binary 列は Buffer を受ける（shared は環境非依存なので Uint8Array を返す）
      board: Buffer.from(key.board),
      hands: Buffer.from(key.hands),
      sideToMove: key.sideToMove,
    };
  });

  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(kifuPositions).values(rows.slice(i, i + CHUNK));
  }
  return rows.length;
}
