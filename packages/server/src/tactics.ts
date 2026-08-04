/**
 * 戦型ラベルの保存（prd/01 §6.4 / prd/03 §2.1）。
 *
 * 判定そのものは `shared` の純関数（`detectTactics`）が持つ。ここは
 * **`usiMoves` の変化に追随して `kifuTactics` を置き換える**責務だけを持つ。
 *
 * ⚠ **ロジックはここに置き、スクリプトは薄い entry point にする。**
 * 一括再判定は現状 CLI（`redetect-tactics.ts`）から呼ぶが、将来スクリプトを本番イメージへ
 * 含める形へ移す予定があるため、呼び出し口が変わっても中身に触らずに済むようにしておく。
 */
import { eq } from 'drizzle-orm';
import { detectTactics } from 'shared';
import { db } from './db';
import { kifuTactics } from './db/schema';

/**
 * `db.transaction` のコールバックが受け取るトランザクションハンドル。
 * 手で型を書くと drizzle の更新で静かにずれるので、**db から導出する**。
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 1 局ぶんの戦型ラベルを**原子的に置き換える**（prd/03 §2.1）。
 *
 * 旧ラベルの DELETE と新ラベルの INSERT を**同じトランザクションで**行う。
 * この表は一覧の絞り込みと勝率集計に使われるため、DELETE 済み・INSERT 前の状態が読まれると
 * **その棋譜だけ黙って条件から外れ、件数や集計が静かに狂う**（エラーにならないので気づけない）。
 *
 * `usiMoves` が null（パース失敗・非平手）のときは**ラベルを空に置換する**。
 * 指し手列が無い以上、戦型は「不明」であって「以前の値」ではない。
 *
 * @returns 書き込んだ行数
 */
export async function replaceTactics(
  tx: Tx,
  kifuId: number,
  usiMoves: string[] | null,
): Promise<number> {
  await tx.delete(kifuTactics).where(eq(kifuTactics.kifuId, kifuId));
  if (!usiMoves || usiMoves.length === 0) return 0;

  const labels = detectTactics(usiMoves);
  if (labels.length === 0) return 0;

  await tx.insert(kifuTactics).values(
    labels.map((l) => ({
      kifuId,
      side: l.side,
      label: l.label,
      turn: l.turn,
    })),
  );
  return labels.length;
}
