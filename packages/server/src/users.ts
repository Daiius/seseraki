/**
 * ユーザー（自分）と主体側の導出（prd/11）。
 *
 * ⚠ **ロジックはここに置き、route.ts / スクリプトは薄い entry point にする**
 * （`tactics.ts` / `positions.ts` と同じ立場）。
 *
 * 認証は単一アカウントのまま（prd/07）なので、**セッションは常にただ一人の `users` 行を指す**。
 * 招待の本体はスコープ外（prd/11 §1）。
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db';
import { kifus, userAliases, users, videoKifuSources } from './db/schema';
import type { Tx } from './tactics';

export type SubjectSide = 'sente' | 'gote';

/** 名前候補（`userAliases` の 1 行ぶん）。期間は既定で無期限（両方 null） */
export interface Alias {
  name: string;
  validFrom: string | null;
  validTo: string | null;
}

/**
 * 現在のユーザー（単一）の id。
 *
 * ⚠ **無ければ落とす。** マイグレーションがプレースホルダの行を作っている（prd/11 §6.1）ので、
 * 無いのは移行が済んでいないということ。黙って作ると、**表示名が未設定のユーザーが
 * 静かに増える**（どれが本物か分からなくなる）。
 */
export async function currentUserId(tx: Tx | typeof db = db): Promise<number> {
  const [row] = await tx.select({ id: users.id }).from(users).orderBy(users.id).limit(1);
  if (!row) {
    throw new Error(
      'users に行が無い。prd/11 §6.1 のマイグレーションが適用されていない',
    );
  }
  return row.id;
}

/**
 * 絶対時刻を「対局地の暦日」（`YYYY-MM-DD`）にする。
 *
 * 🔴 **UTC の日付で切ってはいけない。** `playedAt` は `sourceTz` で解釈した**絶対時刻**
 * （prd/03 §2）なので、JST の午前 0 時台の対局を UTC 日付にすると**前日**になる。
 * 名前の有効期間は「対局日」の境界なので、改名の前後で **1 局ずれて誤判定する**。
 *
 * ⚠ `sourceTz` が未設定（列を足す前の古い行）は **JST 扱い**——投入時の既定と揃える
 * （prd/04）。
 */
export function localDay(playedAt: Date, sourceTz: string | null): string {
  const offsetMinutes = sourceTz === 'UTC' ? 0 : 9 * 60;
  return new Date(playedAt.getTime() + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * 対局日時の時点で有効な名前候補を返す（prd/11 §5）。
 *
 * 🔒 **`playedAt` が null なら期間を見ない**（§5.3）。日時の分からない棋譜で主体側が
 * 決まらない方が実害が大きい、という判断。⚠ `createdAt` で代用しない——あれは
 * 「取り込んだ日」であって対局日ではなく、過去の KIF をまとめて貼ると全部「今日」になる。
 */
export function activeAliases(
  aliases: Alias[],
  playedAt: Date | null,
  sourceTz: string | null = null,
): string[] {
  if (playedAt === null) return aliases.map((a) => a.name);
  const day = localDay(playedAt, sourceTz);
  return aliases
    .filter((a) => (!a.validFrom || a.validFrom <= day) && (!a.validTo || day <= a.validTo))
    .map((a) => a.name);
}

/**
 * 対局者名から主体側を決める。
 *
 * **両対局者とも候補に一致したら null**（ambiguous）。側を確定できない対局は実在し、
 * prd/09 §4 でも勝率の分母から外している。**同じものを、ここでは「後手」として数えない。**
 */
export function subjectSideFromNames(
  sente: string | null,
  gote: string | null,
  names: string[],
): SubjectSide | null {
  if (names.length === 0) return null;
  const set = new Set(names);
  const senteIsSelf = sente !== null && set.has(sente);
  const goteIsSelf = gote !== null && set.has(gote);
  if (senteIsSelf && goteIsSelf) return null;
  if (senteIsSelf) return 'sente';
  if (goteIsSelf) return 'gote';
  return null;
}

/** 動画解析の主体側。画面の下が録画者なので、そのまま主体になる（prd/11 §4.1） */
export function subjectSideFromVideo(bottomIsSente: boolean): SubjectSide {
  return bottomIsSente ? 'sente' : 'gote';
}

/** 所有者の名前候補を読む */
export async function aliasesOf(tx: Tx | typeof db, userId: number): Promise<Alias[]> {
  return tx
    .select({
      name: userAliases.name,
      validFrom: userAliases.validFrom,
      validTo: userAliases.validTo,
    })
    .from(userAliases)
    .where(eq(userAliases.userId, userId));
}

/** 主体側の導出に要る 1 局ぶんの値 */
export interface SubjectInput {
  source: 'manual' | 'swars' | 'video';
  sente: string | null;
  gote: string | null;
  playedAt: Date | null;
  sourceTz: string | null;
  /** 動画解析のときだけ入る（`videoKifuSources`） */
  bottomIsSente: boolean | null;
}

/**
 * 主体側を導出する（**書き込まない純関数**。prd/11 §4.1）。
 *
 * 導出規則は `source` で分かれる:
 * - `video` → `videoKifuSources.bottomIsSente`
 * - それ以外 → 所有者の名前候補と `sente` / `gote` の突き合わせ
 *
 * ⭐ **書き込みと分けてあるのは、dry-run で「これから何になるか」を出せるようにするため。**
 * 現在の保存値を数えるだけでは、導出規則を直したときに**適用後と違う要約**が出る。
 */
export function computeSubjectSide(
  row: SubjectInput,
  aliases: Alias[],
): SubjectSide | null {
  if (row.source === 'video') {
    return row.bottomIsSente === null ? null : subjectSideFromVideo(row.bottomIsSente);
  }
  return subjectSideFromNames(
    row.sente,
    row.gote,
    activeAliases(aliases, row.playedAt, row.sourceTz),
  );
}

/** 導出に要る値を 1 局ぶん読む */
export async function subjectInputOf(
  tx: Tx | typeof db,
  kifuId: number,
): Promise<SubjectInput | null> {
  const [row] = await tx
    .select({
      source: kifus.source,
      sente: kifus.sente,
      gote: kifus.gote,
      playedAt: kifus.playedAt,
      sourceTz: kifus.sourceTz,
      bottomIsSente: videoKifuSources.bottomIsSente,
    })
    .from(kifus)
    .leftJoin(videoKifuSources, eq(videoKifuSources.kifuId, kifus.id))
    .where(eq(kifus.id, kifuId));
  return row ?? null;
}

/**
 * 1 局ぶんの主体側を導出して書き込む（prd/11 §4）。
 *
 * @param aliases 呼び出し側が読んだ名前候補（一括更新で N+1 を避けるため外から渡す）
 */
export async function replaceSubjectSide(
  tx: Tx,
  kifuId: number,
  aliases: Alias[],
): Promise<SubjectSide | null> {
  const row = await subjectInputOf(tx, kifuId);
  if (!row) return null;
  const side = computeSubjectSide(row, aliases);
  await tx.update(kifus).set({ subjectSide: side }).where(eq(kifus.id, kifuId));
  return side;
}

/**
 * 1 局ぶんの主体側を作り直す（**単発用**）。所有者と名前候補を内部で読む。
 *
 * ⚠ 一括更新では使わない——棋譜ごとに名前候補を読み直すことになる。
 * まとめて直すときは [rebuildSubjectSides]。
 */
export async function refreshSubjectSide(
  tx: Tx,
  kifuId: number,
): Promise<SubjectSide | null> {
  const [row] = await tx
    .select({ ownerId: kifus.ownerId })
    .from(kifus)
    .where(eq(kifus.id, kifuId));
  if (!row) return null;
  return replaceSubjectSide(tx, kifuId, await aliasesOf(tx, row.ownerId));
}

/**
 * **その所有者の棋譜だけ**を対象に主体側を作り直す（prd/11 §4.2）。
 *
 * 🔒 **名前候補を変えたら同じトランザクションで呼ぶ。** 手動の再導出に頼ると、
 * 変えた直後に画面の数字が古いまま残り、**間違っていることが画面から分からない**。
 *
 * @returns 更新した棋譜数
 */
export async function rebuildSubjectSides(tx: Tx, userId: number): Promise<number> {
  const aliases = await aliasesOf(tx, userId);
  const rows = await tx
    .select({ id: kifus.id })
    .from(kifus)
    .where(eq(kifus.ownerId, userId));
  for (const { id } of rows) {
    await replaceSubjectSide(tx, id, aliases);
  }
  return rows.length;
}

/**
 * 主体側が未確定の棋譜を数える（画面に「N 件は主体側が決まらないので除外」と出すため）。
 *
 * 🔒 **黙って落とさない**（prd/10 §3.3）。結果が少ない理由が「似た局面が無い」のか
 * 「主体が決まらない棋譜を外した」のか、画面から区別できるようにする。
 */
export async function countUnresolvedSubjects(userId: number): Promise<number> {
  const rows = await db
    .select({ id: kifus.id })
    .from(kifus)
    .where(and(eq(kifus.ownerId, userId), isNull(kifus.subjectSide)));
  return rows.length;
}

/** 名前候補を追加する。⚠ 呼び出し側が主体側の再導出まで同じトランザクションで行う */
export async function addAlias(
  tx: Tx,
  userId: number,
  name: string,
  period: { validFrom?: string | null; validTo?: string | null } = {},
): Promise<void> {
  await tx.insert(userAliases).values({
    userId,
    name,
    validFrom: period.validFrom ?? null,
    validTo: period.validTo ?? null,
  });
}

/** 期間だけを更新する（衝突に気づいたときに調整する。prd/11 §5.2） */
export async function updateAliasPeriod(
  tx: Tx,
  aliasId: number,
  period: { validFrom: string | null; validTo: string | null },
): Promise<void> {
  await tx
    .update(userAliases)
    .set({ validFrom: period.validFrom, validTo: period.validTo })
    .where(eq(userAliases.id, aliasId));
}

/**
 * 名前候補を消す。
 * ⚠ **旧名を消してはいけない**（prd/11 §2.2）——その名前で指した過去の棋譜が
 * 「自分の対局」でなくなり、成績から静かに落ちる。**呼び出し側で警告すること。**
 */
export async function removeAlias(tx: Tx, aliasId: number): Promise<void> {
  await tx.delete(userAliases).where(eq(userAliases.id, aliasId));
}

/** 期間の重なりを持つ別名があるか（同じ名前は UNIQUE で弾かれるので、これは参考情報） */
export function overlaps(a: Alias, b: Alias): boolean {
  const aFrom = a.validFrom ?? '0000-01-01';
  const aTo = a.validTo ?? '9999-12-31';
  const bFrom = b.validFrom ?? '0000-01-01';
  const bTo = b.validTo ?? '9999-12-31';
  return aFrom <= bTo && bFrom <= aTo;
}
