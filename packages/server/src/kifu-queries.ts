/**
 * 棋譜の読み書き（web 向け・ログインの経路。prd/14 §4 所有者スコープ）。
 *
 * 🔒 **各関数は tx（ユーザーとして開いたトランザクション。`user-tx.ts`）と所有者を引数に取り、
 * `owner_id = 所有者` を条件に入れる。** 他人の棋譜は「無い」（null / false → 呼び出し側で 404）。
 * 存在を明かさないため、「他人のもの」と「無い」を区別しない。
 * ⚠ グローバルの `db` を import しない（`db-import-boundary.test.ts` が検査する）。
 *
 * worker・動画解析の取り込み（API_KEY の経路）は全員ぶんを扱うので、ここではなく `worker-routes.ts`。
 */
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { attributionOf, type TacticLabel } from 'shared';
import type { Tx } from './db/index.js';
import { kifuAnalyses, kifus, kifuTactics, videoKifuSources } from './db/schema.js';
import { ANALYSIS_STATE_RESET } from './analysis-submit.js';
import { drillConfigFromEnv, syncDrills } from './drills.js';
import { decodeAll } from './kifu-analysis-detail.js';
import { loadAnalysis } from './kifu-analysis-store.js';
import {
  kifuListOrderBy,
  kifuListWhere,
  type KifuListQuery,
} from './kifu-list-query.js';
import { replacePositions } from './positions.js';
import {
  statsTacticsJoinOn,
  statsTacticsOrderBy,
  statsTacticsPeriodWhere,
  statsTacticsRowsSelect,
  statsTacticsSummarySelect,
  statsTacticsWhere,
  type StatsTacticsQuery,
} from './stats-tactics-query.js';
import { replaceTactics } from './tactics.js';
import { refreshSubjectSide } from './users.js';
import {
  detectLegacyUtcTimezone,
  parseKif,
  type KifTimezone,
} from './kif/parser.js';

/** 投入時の TZ 指定。'auto' は自動判定＝現状 JST 固定（[parseKif]） */
export type SourceTzChoice = 'auto' | KifTimezone;

/** 一覧の 1 ページの件数 */
export const KIFU_PAGE_SIZE = 50;

export interface KifIngestion {
  /** パースエラー・非平手・空のときは null（壊れた部分列を worker に渡さない） */
  usiMoves: string[] | null;
  meta: {
    sente: string | null;
    gote: string | null;
    senteDan: number | null;
    goteDan: number | null;
    result: string | null;
    playedAt: Date | null;
    sourceTz: string;
  };
}

/**
 * KIF テキストを USI 指し手列 + 対局メタへ変換する（投入・再解析で共用）。
 * @param tz 開始日時の解釈 TZ。'auto'（既定）は JST。
 *   投入時にユーザーが選んだ値、再解析では保存済み sourceTz を渡す。
 */
export function convertKif(kifText: string, tz: SourceTzChoice = 'auto'): KifIngestion {
  const parsed = parseKif(kifText, tz === 'auto' ? undefined : tz);
  const isHeihei = !parsed.header.handicap || parsed.header.handicap === '平手';
  const usiMoves =
    parsed.errors.length === 0 && isHeihei && parsed.moves.length > 0
      ? parsed.moves.map((m) => m.usi)
      : null;
  return {
    usiMoves,
    meta: {
      sente: parsed.header.sente,
      gote: parsed.header.gote,
      senteDan: parsed.header.senteDan,
      goteDan: parsed.header.goteDan,
      result: parsed.header.result,
      playedAt: parsed.header.playedAt,
      sourceTz: parsed.header.sourceTz,
    },
  };
}

/** タイトル未指定時に対局メタから自動生成する */
export function autoTitle(meta: KifIngestion['meta']): string {
  if (meta.sente || meta.gote) {
    return `${meta.sente ?? '?'} vs ${meta.gote ?? '?'}`;
  }
  if (meta.playedAt) {
    return meta.playedAt.toISOString().slice(0, 10);
  }
  return '無題';
}

/**
 * 棋譜ごとの戦型ラベル（ページ内の棋譜ぶんをまとめて引く。N+1 を避ける）。
 * **保存値をそのまま返す**（経由形も含む）。表示の抑制と関係ラベルの導出は
 * shared の純関数で web 側が行う（prd/03 §2.1.2）
 */
async function tacticsByKifu(
  tx: Tx,
  ownerId: string,
  ids: number[],
): Promise<Map<number, TacticLabel[]>> {
  const byKifu = new Map<number, TacticLabel[]>();
  if (ids.length === 0) return byKifu;
  const rows = await tx
    .select({
      kifuId: kifuTactics.kifuId,
      side: kifuTactics.side,
      label: kifuTactics.label,
      turn: kifuTactics.turn,
    })
    .from(kifuTactics)
    .where(and(eq(kifuTactics.ownerId, ownerId), inArray(kifuTactics.kifuId, ids)));
  for (const { kifuId, ...t } of rows) {
    const list = byKifu.get(kifuId);
    if (list) list.push(t);
    else byKifu.set(kifuId, [t]);
  }
  return byKifu;
}

/** 棋譜一覧（prd/04 §6.1）。所有者の棋譜だけ */
export async function listKifus(tx: Tx, ownerId: string, query: KifuListQuery) {
  const { page } = query;
  const limit = KIFU_PAGE_SIZE;
  const offset = (page - 1) * limit;

  const where = and(eq(kifus.ownerId, ownerId), kifuListWhere(query));

  const [totals] = await tx.select({ total: count() }).from(kifus).where(where);
  const total = totals?.total ?? 0;

  const rows = await tx
    .select({
      id: kifus.id,
      title: kifus.title,
      sente: kifus.sente,
      gote: kifus.gote,
      senteDan: kifus.senteDan,
      goteDan: kifus.goteDan,
      result: kifus.result,
      playedAt: kifus.playedAt,
      createdAt: kifus.createdAt,
      analyzedAt: kifus.analysisCompletedAt,
      // 完了した段階のうち最も高いもの（prd/05 §1.1d）。一覧は「解析済み」に quick を
      // 含めたうえで、簡易のみの棋譜に「簡易」の印を添えるためにこれを見る
      analysisProfile: kifus.analysisProfile,
      analysisError: kifus.analysisError,
      hasMemo: sql<boolean>`${kifus.memo} IS NOT NULL`,
      // 主体の手番（prd/11 §4）。web はこれで自分/相手を出せる——
      // 名前候補から毎回判定しなくてよくなる（移行は prd/11 §6 の段階 B）
      subjectSide: kifus.subjectSide,
    })
    .from(kifus)
    .where(where)
    .orderBy(...kifuListOrderBy(query))
    .limit(limit)
    .offset(offset);

  const tactics = await tacticsByKifu(
    tx,
    ownerId,
    rows.map((r) => r.id),
  );

  return {
    kifus: rows.map(({ analyzedAt, analysisError, hasMemo, ...r }) => ({
      ...r,
      analyzed: analyzedAt !== null,
      failed: analysisError !== null,
      hasMemo: Boolean(hasMemo),
      tactics: tactics.get(r.id) ?? [],
    })),
    pagination: {
      page,
      totalPages: Math.ceil(total / limit),
      total,
    },
  };
}

/** 棋譜の詳細（解析・戦型つき）。他人の棋譜・無い棋譜は null */
export async function getKifuDetail(tx: Tx, ownerId: string, id: number) {
  const [kifu] = await tx
    .select()
    .from(kifus)
    .where(and(eq(kifus.id, id), eq(kifus.ownerId, ownerId)));
  if (!kifu) return null;

  // 解析は 1 行を展開して、局面ごとの形で返す（prd/16 §5。web が読む形は局面と候補手の並び）。
  // 局面ごとの段階・来歴・時刻はその局面を書いた submit（run）の値。
  // ⚠ 上で所有者を確かめた棋譜の ID でだけ引く（`loadAnalysis` は worker の経路と共用で所有者を取らない）
  const stored = await loadAnalysis(tx, id);
  const analyses = decodeAll(stored.detail, stored.runs).map(
    ({ moveNumber, run, candidates }) => ({
      moveNumber,
      profile: run.profile,
      engineName: run.engineName,
      movetimeMs: run.movetimeMs,
      targetDepth: run.targetDepth,
      multiPv: run.multiPv,
      // 以前の局面ごとの `createdAt` と同じ意味（その局面を書いた submit の時刻）
      createdAt: run.at,
      candidates,
    }),
  );

  // 戦型ラベルは**保存値をそのまま返す**（経由形も含む）。表示の抑制と関係ラベルの導出は
  // shared の純関数で web 側が行う（prd/03 §2.1.2）
  const tactics = await tx
    .select({
      side: kifuTactics.side,
      label: kifuTactics.label,
      turn: kifuTactics.turn,
    })
    .from(kifuTactics)
    .where(and(eq(kifuTactics.kifuId, id), eq(kifuTactics.ownerId, ownerId)));

  return { ...kifu, analyses, tactics };
}

/**
 * 戦型別成績（prd/09）。**生ラベルで数える平坦な行**を返し、階層（`IMPLIES`）は web で組む。
 * 局数の合計は総局数を超える（各行は独立した問いへの答えで分割ではない。prd/09 §2.1）
 */
export async function statsTactics(tx: Tx, ownerId: string, query: StatsTacticsQuery) {
  const own = eq(kifus.ownerId, ownerId);
  // 総局数と除外の内訳は期間内の全局が母集団（ラベルとは無関係）。
  // 集計対象が空でも 1 行返る
  const [summary] = await tx
    .select(statsTacticsSummarySelect(query))
    .from(kifus)
    .where(and(own, statsTacticsPeriodWhere(query)));

  const rows = await tx
    .select(statsTacticsRowsSelect(query))
    .from(kifus)
    .innerJoin(kifuTactics, statsTacticsJoinOn(query))
    .where(and(own, statsTacticsWhere(query)))
    .groupBy(kifuTactics.label)
    .orderBy(...statsTacticsOrderBy());

  const { totalGames, ...excluded } = summary ?? {
    totalGames: 0,
    ambiguousSelf: 0,
    draw: 0,
    unknownResult: 0,
  };
  return {
    totalGames,
    excluded,
    // 帰属は判定側（shared）が単一の出所。web が帰属バッジ・分母の説明に使う（prd/09 §2.2）
    rows: rows.map((r) => ({ ...r, attribution: attributionOf(r.label) })),
  };
}

/**
 * 棋譜を取り込む。所有者は**セッションのユーザー**（呼び出し側が渡す）。
 * **usiMoves の書き込みと戦型の判定は同一トランザクション**（prd/01 §6.4）。
 * 別にすると、戦型判定で落ちたときに「指し手はあるがラベルが無い」棋譜が残り、
 * 一覧の絞り込みから黙って外れる（リクエストの tx が 1 つなので、それで揃う）
 */
export async function createKifu(
  tx: Tx,
  ownerId: string,
  input: { title?: string; kifText: string; sourceTz?: SourceTzChoice },
): Promise<number> {
  const { usiMoves, meta } = convertKif(input.kifText, input.sourceTz ?? 'auto');
  const [result] = await tx
    .insert(kifus)
    .values({
      title: input.title?.trim() || autoTitle(meta),
      kifText: input.kifText,
      usiMoves,
      sente: meta.sente,
      gote: meta.gote,
      senteDan: meta.senteDan,
      goteDan: meta.goteDan,
      result: meta.result,
      playedAt: meta.playedAt,
      sourceTz: meta.sourceTz,
      ownerId,
    })
    .returning({ id: kifus.id });
  const kifu = { id: result.id, ownerId };
  await replaceTactics(tx, kifu, usiMoves);
  await replacePositions(tx, kifu, usiMoves);
  // 主体側も同じトランザクションで（対局者名から導出する。prd/11 §4）
  await refreshSubjectSide(tx, result.id);
  return result.id;
}

/**
 * 再解析（kifText を再変換して解析状態を戻す）。他人の棋譜・無い棋譜は false。
 *
 * kifText を再変換（パーサ修正・メタ抽出を既存棋譜へ反映）し、
 * 解析状態をリセットして worker に拾い直させる。title/memo は温存。
 * TZ は投入時のユーザー選択（保存済み sourceTz）を維持する。未設定（旧データ＝TZ を
 * 記録し始める前の投入分）は、当時 UTC で書き出していたアプリの棋譜がありうるので
 * 旧署名で補う（新規取り込みは JST 固定。[detectLegacyUtcTimezone]）。
 */
export async function reanalyzeKifu(tx: Tx, ownerId: string, id: number): Promise<boolean> {
  const [kifu] = await tx
    .select({ kifText: kifus.kifText, sourceTz: kifus.sourceTz })
    .from(kifus)
    .where(and(eq(kifus.id, id), eq(kifus.ownerId, ownerId)));
  if (!kifu) return false;

  const tz =
    (kifu.sourceTz as KifTimezone | null) ?? detectLegacyUtcTimezone(kifu.kifText);
  const { usiMoves, meta } = convertKif(kifu.kifText, tz);
  // 先に kifus を UPDATE して行ロックを取り、analysisRevision を +1（実行中の旧解析の
  // submit/error 報告は世代不一致で弾かれる）。/worker/analyses も kifus を先ロックするため
  // kifuAnalyses との取得順が揃いデッドロックしない。
  await tx
    .update(kifus)
    .set({
      usiMoves,
      sente: meta.sente,
      gote: meta.gote,
      senteDan: meta.senteDan,
      goteDan: meta.goteDan,
      result: meta.result,
      playedAt: meta.playedAt,
      sourceTz: meta.sourceTz,
      // 解析状態は 3 列まとめて戻す（両段階を最初から。prd/05 §1.1d）。
      // 動画棋譜の上書き（`video-analysis.ts`）と同じ定数を使い、
      // **リセットの取りこぼしが片方だけ起きない**ようにする
      ...ANALYSIS_STATE_RESET,
      analysisRevision: sql`${kifus.analysisRevision} + 1`,
    })
    .where(and(eq(kifus.id, id), eq(kifus.ownerId, ownerId)));
  // 旧解析結果を削除（未解析状態で旧結果が残らないように。prd/16 §4.3）
  await tx
    .delete(kifuAnalyses)
    .where(and(eq(kifuAnalyses.kifuId, id), eq(kifuAnalyses.ownerId, ownerId)));
  const ref = { id, ownerId };
  // 指し手列を作り直したので戦型も置き換える（prd/01 §6.4）。
  // 再変換に失敗して usiMoves が null になった場合はラベルを空にする
  await replaceTactics(tx, ref, usiMoves);
  // 局面索引も同じトランザクションで作り直す（派生値なので usiMoves に追随する。prd/10 §3.2）
  await replacePositions(tx, ref, usiMoves);
  // 再変換で対局者名が変わりうるので、主体側も引き直す（prd/11 §4.2）
  await refreshSubjectSide(tx, id);
  // 出題は解析結果からの派生値（prd/13 §6.1）。解析を消した以上ここも空になる
  // ——古い指し手列で作った問題を残すと、盤面と答えが噛み合わない
  await syncDrills(tx, id, drillConfigFromEnv());
  return true;
}

/** 棋譜を消す（子の表は CASCADE）。他人の棋譜・無い棋譜は false */
export async function deleteKifu(tx: Tx, ownerId: string, id: number): Promise<boolean> {
  const deleted = await tx
    .delete(kifus)
    .where(and(eq(kifus.id, id), eq(kifus.ownerId, ownerId)))
    .returning({ id: kifus.id });
  return deleted.length > 0;
}

/** メモを書き換える（空文字は null）。他人の棋譜・無い棋譜は false */
export async function updateKifuMemo(
  tx: Tx,
  ownerId: string,
  id: number,
  memo: string | null,
): Promise<boolean> {
  const normalized = memo && memo.length > 0 ? memo : null;
  const updated = await tx
    .update(kifus)
    .set({ memo: normalized })
    .where(and(eq(kifus.id, id), eq(kifus.ownerId, ownerId)))
    .returning({ id: kifus.id });
  return updated.length > 0;
}

/**
 * 動画解析の棋譜の一覧（prd/10）。動画ごと → 局ごと。件数が少ない（1 動画 2〜3 局）ため
 * ページングは持たない。所有者の棋譜だけ
 */
export async function listVideoKifus(tx: Tx, ownerId: string) {
  const rows = await tx
    .select({
      kifuId: kifus.id,
      title: kifus.title,
      videoId: videoKifuSources.videoId,
      gameIndex: videoKifuSources.gameIndex,
      startedAtSec: videoKifuSources.startedAtSec,
      endedAtSec: videoKifuSources.endedAtSec,
      bottomIsSente: videoKifuSources.bottomIsSente,
      extractorRev: videoKifuSources.extractorRev,
      updatedAt: videoKifuSources.updatedAt,
      // 一覧に要るのは手数だけ。指し手列そのものを載せると 1 局 100 手ぶんが無駄に流れる
      moveCount: sql<number>`jsonb_array_length(${kifus.usiMoves})`,
      analyzedAt: kifus.analysisCompletedAt,
      analysisError: kifus.analysisError,
    })
    .from(videoKifuSources)
    .innerJoin(kifus, eq(kifus.id, videoKifuSources.kifuId))
    .where(and(eq(videoKifuSources.ownerId, ownerId), eq(kifus.ownerId, ownerId)))
    .orderBy(asc(videoKifuSources.videoId), asc(videoKifuSources.gameIndex));

  const tactics = await tacticsByKifu(
    tx,
    ownerId,
    rows.map((r) => r.kifuId),
  );

  return {
    games: rows.map(({ analyzedAt, analysisError, ...r }) => ({
      ...r,
      moveCount: Number(r.moveCount ?? 0),
      analyzed: analyzedAt !== null,
      failed: analysisError !== null,
      analysisError,
      tactics: tactics.get(r.kifuId) ?? [],
    })),
  };
}
