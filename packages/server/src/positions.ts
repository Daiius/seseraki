/**
 * 局面索引の保存（prd/10 §3.2）。
 *
 * 局面キーの計算そのものは `shared`（`positionKey`）が持つ。ここは
 * **`usiMoves` の変化に追随して `kifuPositions` を置き換える**責務だけを持つ
 * （`tactics.ts` と同じ立場）。
 *
 * ⚠ **ロジックはここに置き、スクリプトは薄い entry point にする。**
 */
import { and, eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  buildPositions,
  parseSfen,
  positionHash,
  positionKey,
  positionSfen,
  sideLayoutKey,
  stateFromBytes,
  type PositionKey,
  type Side,
} from 'shared';
import { kifuPositions } from './db/schema';
import type { KifuRef, Tx } from './tactics';

/** 局面キー文字列 → 索引に入れる 8 バイト（drizzle の bytea 列は Buffer を受ける） */
export function hashOf(key: string): Buffer {
  return Buffer.from(positionHash(key));
}

/**
 * SFEN（手数付きの 4 フィールドも可）を読んで局面キーにする。読めなければ `null`。
 *
 * ⭐ 引く側は**必ずここを通す**。ハッシュは正規化した文字列（`positionSfen`）に対して
 * 取っているので、書き方の揺れた SFEN をそのままハッシュしても当たらない。
 */
export function parsePositionKey(sfen: string): PositionKey | null {
  const state = parseSfen(sfen);
  return state ? positionKey(state) : null;
}

/** 照合に使う列（`kifuPositions` とその別名のどちらでも渡せるよう、列だけを要求する） */
type PositionColumns = Record<'sfenHash' | 'board' | 'hands' | 'sideToMove', AnyColumn>;

/**
 * 局面索引の行が**その局面そのもの**である条件（prd/14 §6.3）。
 *
 * 🔒 **ハッシュで引いて、盤・持ち駒・手番で照合する。** ハッシュの一致だけでは衝突した
 * 別の局面を拾いうるが、`(board, hands, sideToMove)` は局面キーの文字列と 1 対 1 なので、
 * この条件を満たす行は**文字列の一致と同じ集合**になる。照合を SQL に入れているので、
 * `limit` や `count(*) over ()` は照合後の行に対してかかる（件数がずれない）。
 *
 * ⚠ 自己結合の別名（`alias(kifuPositions, …)`）にも使えるよう、表を引数で受ける。
 */
export function samePosition(
  table: PositionColumns,
  key: Pick<PositionKey, 'sfen' | 'board' | 'hands' | 'sideToMove'>,
): SQL {
  return and(
    eq(table.sfenHash, hashOf(key.sfen)),
    eq(table.board, Buffer.from(key.board)),
    eq(table.hands, Buffer.from(key.hands)),
    eq(table.sideToMove, key.sideToMove),
  )!;
}

/**
 * SFEN 文字列で `samePosition` を作る。読めない SFEN は**どの行にも一致しない**条件にする
 * （保存されている局面はすべて読める SFEN なので、文字列で引いていた頃と同じ結果になる）。
 */
export function samePositionAsSfen(table: PositionColumns, sfen: string): SQL {
  const key = parsePositionKey(sfen);
  return key ? samePosition(table, key) : sql`false`;
}

/**
 * 片側の配置の照合（`/positions/subject`。prd/14 §6.3）。
 *
 * 行の盤・持ち駒から**その側の配置のキー（`sideLayoutKey`。小文字化した `sideSfen`）を
 * 組み立て直し**、基準と比べる。ハッシュが一致した行に対して呼び、衝突した別の配置を落とす。
 *
 * 🔴 **大小文字を区別しない**（先後をまたいで一致させる）。文字列を保存していた頃の
 * `senteSfen = ?` / `goteSfen = ?` は、列の照合順序（`utf8mb4_0900_ai_ci`）で大小文字を
 * 区別せずに比べていた。それと同じ判定にする。
 *
 * @param baseLayoutKey 基準局面の `sideLayoutKey`
 */
export function sameSideLayout(
  row: { board: Uint8Array; hands: Uint8Array; sideToMove: 'b' | 'w' },
  side: Side,
  baseLayoutKey: string,
): boolean {
  return (
    sideLayoutKey(stateFromBytes(row.board, row.hands, row.sideToMove), side) === baseLayoutKey
  );
}

/** 索引の行（盤・持ち駒・手番）から局面キーの SFEN を組み立てる。文字列は保存していないため */
export function sfenOfRow(row: {
  board: Uint8Array;
  hands: Uint8Array;
  sideToMove: 'b' | 'w';
}): string {
  return positionSfen(stateFromBytes(row.board, row.hands, row.sideToMove));
}

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
  kifu: KifuRef,
  usiMoves: string[] | null,
): Promise<number> {
  await tx.delete(kifuPositions).where(eq(kifuPositions.kifuId, kifu.id));
  if (!usiMoves || usiMoves.length === 0) return 0;

  // buildPositions は [初期局面, 1手目後, ...] を返す。
  // ⭐ moveNumber = i の行が持つ `move` は **i 手目の指し手**（その局面に至った手）
  const states = buildPositions(usiMoves);
  const rows = states.map((state, i) => {
    const key = positionKey(state);
    return {
      kifuId: kifu.id,
      ownerId: kifu.ownerId,
      moveNumber: i,
      move: i === 0 ? null : usiMoves[i - 1],
      // 🔒 文字列は保存しない（prd/14 §6.3）。検索はハッシュで引いて盤・持ち駒で照合する
      sfenHash: hashOf(key.sfen),
      // ⚠ 片側は**小文字にしてから**ハッシュする（先後をまたいで一致させる。`sideLayoutKey`）
      senteSfenHash: hashOf(sideLayoutKey(state, 'sente')),
      goteSfenHash: hashOf(sideLayoutKey(state, 'gote')),
      // drizzle の bytea 列は Buffer を受ける（shared は環境非依存なので Uint8Array を返す）
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
