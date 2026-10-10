/**
 * 出題の抽出と保存（prd/13 §4 / §6）。
 *
 * 判定そのものは `shared` の純関数（`computeMoveLosses` / `labelOf` / `classifyMateLine`）が持つ。
 * ここは **解析結果から出題を導き、`drills` を追随させる**責務だけを持つ
 * （`tactics.ts` / `positions.ts` と同じ立場）。
 *
 * ⚠ **ロジックはここに置き、スクリプトは薄い entry point にする。**
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  DEFAULT_THRESHOLDS,
  buildPositions,
  classifyMateLine,
  computeMoveLosses,
  labelOf,
  type Thresholds,
} from 'shared';
import type { Db } from './db/index.js';
import { drills, kifus } from './db/schema';
import { decodeAll } from './kifu-analysis-detail.js';
import { loadAnalysis } from './kifu-analysis-store.js';
import type { Tx } from './tactics';

/**
 * 抽出規則の版。**規則を変えたら上げる**（prd/13 §6.1）。
 * 行に焼き付けるので、一括再生成の対象を「古い版だけ」に絞れる。
 *
 * - `2`（2026-09-16）: 決着閾値を削除し、大差の局面の悪手も拾う（prd/05 §2.3）
 */
export const GENERATOR_REV = '2';

/** 出題に使う閾値（prd/13 §4.1）。既定は `shared` の `DEFAULT_THRESHOLDS` に合わせる */
export interface DrillThresholds {
  /** 悪手とみなす損失（cp）。`labelOf` にそのまま渡す */
  thresholds: Thresholds;
  /** 出題する詰みの上限（engine の plies。⚠ 詰将棋の「N手詰」ではない） */
  mateMaxPlies: number;
}

/**
 * 出題の抽出に使う設定を環境変数から作る。
 *
 * 🔴 **採点の許容差（`DRILL_CORRECT_MARGIN`）とは別のつまみ**（prd/13 §5.1）。
 * こちらは「どの局面を問題にするか」で server が持ち、許容差は「その手を正解と呼ぶか」で
 * 閲覧者の設定（web）が持つ。混ぜると、閾値を動かすたびに出題の在庫が入れ替わる。
 *
 * 既定は `shared` の `DEFAULT_THRESHOLDS`（悪手 600cp）と、
 * 取りこぼしの既定（10 plies。prd/09 §3.1）に合わせる。
 */
export function drillConfigFromEnv(env = process.env): DrillThresholds {
  const blunder = Number(env.DRILL_BLUNDER_CP);
  const mateMax = Number(env.DRILL_MATE_MAX_PLIES);
  return {
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...(Number.isFinite(blunder) && blunder > 0 ? { blunder } : {}),
    },
    mateMaxPlies: Number.isFinite(mateMax) && mateMax > 0 ? mateMax : 10,
  };
}

export interface DrillCandidate {
  rank: number;
  move: string;
  scoreType: string;
  scoreValue: number;
  pv: string[] | null;
}

export interface DrillAnalysis {
  moveNumber: number;
  candidates: DrillCandidate[];
}

export interface ExtractInput {
  usiMoves: string[] | null;
  /** 主体の手番（prd/11 §4）。**null なら 1 問も作らない**——誰の問題か決まらない */
  subjectSide: 'sente' | 'gote' | null;
  /** `profile='full'` の解析だけを渡すこと（prd/13 §2） */
  analyses: DrillAnalysis[];
  config: DrillThresholds;
}

export interface ExtractedDrill {
  moveNumber: number;
  kind: 'mate' | 'best';
  reason: 'missed_mate' | 'own_blunder';
  answerMove: string;
  answerScoreType: string;
  answerScoreValue: number;
  answerPv: string[] | null;
  candidates: { rank: number; move: string; scoreType: string; scoreValue: number }[];
  matePlies: number | null;
  playedMove: string | null;
  playedLossCp: number | null;
}

/** `moveNumber` の局面が主体の手番か。`moveNumber = 0` が初期局面 ＝ 先手番（prd/03 §3） */
function isSubjectTurn(moveNumber: number, subjectSide: 'sente' | 'gote'): boolean {
  return (moveNumber % 2 === 0) === (subjectSide === 'sente');
}

/**
 * 解析結果から出題を抽出する（prd/13 §4.1）。**純関数**——DB も時刻も見ない。
 *
 * 🔴 **1 局面につき 1 問**。詰みは自分の悪手より優先する（問いが「詰ませてください」に
 * 変わるため）。
 */
export function extractDrills(input: ExtractInput): ExtractedDrill[] {
  const { usiMoves, subjectSide, analyses, config } = input;
  if (!usiMoves || usiMoves.length === 0 || !subjectSide) return [];

  const withCandidates = analyses.filter((a) => a.candidates.length > 0);
  const losses = computeMoveLosses(withCandidates, usiMoves);
  // 盤面追跡は詰み筋の分類にだけ要る。局面の配列は 1 度だけ作る
  const states = buildPositions(usiMoves);

  const result: ExtractedDrill[] = [];
  for (const analysis of withCandidates) {
    const { moveNumber } = analysis;
    if (!isSubjectTurn(moveNumber, subjectSide)) continue;

    const best = analysis.candidates.find((c) => c.rank === 1);
    if (!best) continue;

    const loss = losses.get(moveNumber);
    const snapshot = analysis.candidates
      .map((c) => ({
        rank: c.rank,
        move: c.move,
        scoreType: c.scoreType,
        scoreValue: c.scoreValue,
      }))
      .sort((a, b) => a.rank - b.rank);
    const base = {
      moveNumber,
      answerMove: best.move,
      answerScoreType: best.scoreType,
      answerScoreValue: best.scoreValue,
      answerPv: best.pv ?? null,
      candidates: snapshot,
      playedMove: usiMoves[moveNumber] ?? null,
      playedLossCp: loss?.loss ?? null,
    };

    // --- 逃した詰み（prd/13 §4.1） ---
    if (best.scoreType === 'mate' && best.scoreValue > 0) {
      const plies = best.scoreValue;
      // 🔒 **`mate` に当たる局面は `best` として出さない**（prd/13 §4.1）。
      // 条件を満たさなければ **その局面は出題しない**——cp 差の採点が成立しないため
      if (plies < 1 || plies > config.mateMaxPlies) continue;
      // **実際に詰ませていたら出題しない。** `computeMoveLosses` の詰み分類がそのまま
      // 「自分の詰みがあったのに実手が詰みでない」を意味する（prd/09 §3.1 と同じ母集団）
      if (loss?.mate?.kind !== 'missed') continue;
      const state = states[moveNumber];
      if (!state || !best.pv || best.pv.length === 0) continue;
      // 🔴 **詰将棋の形をした mate だけを出す**（prd/13 §4.1）。必至・静かな手を含む筋は
      // 「詰ませてください」の問いに合わない
      if (classifyMateLine(state, best.pv, best.scoreValue).kind !== 'checkmate') continue;
      result.push({ ...base, kind: 'mate', reason: 'missed_mate', matePlies: plies });
      continue;
    }
    // 負の mate（自分が詰まされる局面）も出題しない。指すべき手を cp 差で測れない
    if (best.scoreType === 'mate') continue;

    // --- 自分の悪手（prd/13 §4.1） ---
    // 🔒 判定は `labelOf` に委ねる（閾値の解釈を 2 つ持たない）
    if (loss && labelOf(loss, config.thresholds) === 'blunder') {
      result.push({ ...base, kind: 'best', reason: 'own_blunder', matePlies: null });
      continue;
    }

    // 🔴 **「相手の悪手を咎める」条件は持たない**（決定・2026-09-08）。
    // **咎め損ねれば評価値が落ちるので、上の「自分の悪手」が同じ局面を拾う。**
    // 咎めた場合は出題しても取り返すだけの自明な 1 手にしかならない（dev DB で
    // 13 問中 13 問が「実戦で自分が正解を指した局面」だった。prd/13 §4.2）。
  }
  return result;
}

/**
 * 1 局ぶんの full の解析を読む（先頭 `fullCount` 局面。prd/16 §5）。
 * full は先頭からの連続区間なので、それより後ろの局面は quick（出題には使わない。prd/13 §2）。
 */
export async function loadFullAnalyses(
  tx: Tx | Db,
  kifuId: number,
): Promise<DrillAnalysis[]> {
  const stored = await loadAnalysis(tx, kifuId);
  return decodeAll(stored.detail.slice(0, stored.fullCount), stored.runs).map(
    ({ moveNumber, candidates }) => ({
      moveNumber,
      candidates: candidates.map(({ rank, move, scoreType, scoreValue, pv }) => ({
        rank,
        move,
        scoreType,
        scoreValue,
        pv,
      })),
    }),
  );
}

/**
 * 1 局ぶんの出題を**追随させる**（prd/13 §6.1）。
 *
 * 🔴 **DELETE → INSERT にしない。** `drillAttempts` が CASCADE でぶら下がっているので、
 * 作り直すと**解答履歴が道連れで消える**。同じ `(kifuId, moveNumber, kind)` は upsert で
 * 更新し、条件から外れた行だけを消す。
 *
 * @returns 書き込んだ行数と、条件から外れて消した行数
 */
export async function syncDrills(
  tx: Tx,
  kifuId: number,
  config: DrillThresholds,
): Promise<{ upserted: number; removed: number }> {
  const [kifu] = await tx
    .select({
      usiMoves: kifus.usiMoves,
      subjectSide: kifus.subjectSide,
      analysisRevision: kifus.analysisRevision,
      source: kifus.source,
      ownerId: kifus.ownerId,
    })
    .from(kifus)
    .where(eq(kifus.id, kifuId));
  if (!kifu) return { upserted: 0, removed: 0 };

  // 🔒 **動画由来の棋譜からは出題しない**（自分の対局ではない。prd/10 §2.2 / prd/13 §2）
  const extracted =
    kifu.source === 'video'
      ? []
      : extractDrills({
          usiMoves: kifu.usiMoves,
          subjectSide: kifu.subjectSide,
          analyses: await loadFullAnalyses(tx, kifuId),
          config,
        });

  if (extracted.length > 0) {
    await tx
      .insert(drills)
      .values(
        extracted.map((d) => ({
          kifuId,
          // 棋譜の所有者の写し（prd/14 §4.1）。upsert の衝突時は書き換えない（同じ棋譜なら同じ値）
          ownerId: kifu.ownerId,
          moveNumber: d.moveNumber,
          kind: d.kind,
          reason: d.reason,
          answerMove: d.answerMove,
          answerScoreType: d.answerScoreType,
          answerScoreValue: d.answerScoreValue,
          answerPv: d.answerPv,
          candidates: d.candidates,
          matePlies: d.matePlies,
          playedMove: d.playedMove,
          playedLossCp: d.playedLossCp,
          analysisRevision: kifu.analysisRevision,
          blunderCp: config.thresholds.blunder,
          mateMaxPlies: config.mateMaxPlies,
          generatorRev: GENERATOR_REV,
        })),
      )
      // 一意キー（kifuId, moveNumber, kind）が衝突したら焼き付けた材料を差し替える。
      // ⚠ **ID は変えない**——解答履歴（`drillAttempts`）が ID を指している
      .onConflictDoUpdate({
        target: [drills.kifuId, drills.moveNumber, drills.kind],
        set: {
          reason: excluded(drills.reason),
          answerMove: excluded(drills.answerMove),
          answerScoreType: excluded(drills.answerScoreType),
          answerScoreValue: excluded(drills.answerScoreValue),
          answerPv: excluded(drills.answerPv),
          candidates: excluded(drills.candidates),
          matePlies: excluded(drills.matePlies),
          playedMove: excluded(drills.playedMove),
          playedLossCp: excluded(drills.playedLossCp),
          analysisRevision: excluded(drills.analysisRevision),
          blunderCp: excluded(drills.blunderCp),
          mateMaxPlies: excluded(drills.mateMaxPlies),
          generatorRev: excluded(drills.generatorRev),
        },
      });
  }

  // 条件から外れた行を消す。⚠ **その問題の解答履歴も一緒に消える**が、
  // 出題として成立しなくなった以上、履歴だけ残しても参照先が無い
  const keep = extracted.map((d) => sql`(${d.moveNumber}, ${d.kind})`);
  const removed = await tx
    .delete(drills)
    .where(
      keep.length === 0
        ? eq(drills.kifuId, kifuId)
        : and(
            eq(drills.kifuId, kifuId),
            sql`(${drills.moveNumber}, ${drills.kind}) not in (${sql.join(keep, sql`, `)})`,
          ),
    );

  return { upserted: extracted.length, removed: rowsAffected(removed) };
}

/** drizzle の DELETE 結果（node-postgres の `QueryResult`）から件数を取り出す */
function rowsAffected(result: { rowCount: number | null }): number {
  return result.rowCount ?? 0;
}

/**
 * upsert で「挿入しようとした値」を指す（Postgres の `excluded.<列>`）。
 * 列名はスキーマから取る（手書きの文字列にすると列名を変えたときに黙って壊れる）
 */
function excluded(column: AnyPgColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
