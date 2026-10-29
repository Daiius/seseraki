/**
 * 検討局面の評価（prd/12 §2.1 / §2.2）。
 *
 * **新しいプロセスは立てない。** 棋譜解析と同じエンジンに相乗りし、棋譜解析の
 * **局面境界**（`analyzeKifu` の `onPositionBoundary`）と、棋譜が無いときの poll で処理する。
 * USI は毎回 `position` で局面を明示するので、割り込みによるエンジン状態の汚染はない。
 * 置換表の共有は許容する（検討局面は閲覧中の棋譜の派生局面で、むしろ共有できる側）。
 *
 * **探索時間は棋譜解析と同一**（`ENGINE_MOVETIME` / `ENGINE_DEPTH`）。
 * **MultiPV だけは棋譜解析の `ENGINE_MULTIPV` に乗らず 3 本固定**（API 契約。prd/12 §2.2）。
 *
 * 🔴 **局面評価は MultiPV を自分で設定してから探索する。** `analyzeKifu` は解析の
 * 終わりに MultiPV を 1 へ戻すため、エンジンの設定に乗るだけだと**同じ要求が
 * 「棋譜解析の最中なら 3 本・アイドルなら 1 本」と worker の状態で揺れる**
 * （2026-08-28 に dev で実測。prd/12 §2.2 は 3 本と定めている）。
 * 設定した値は探索後に**元へ戻す**ので、割り込まれた棋譜解析の候補手数は変わらない。
 */
import {
  extractMultiPvResults,
  namedEvaluationOf,
  searchmovesGoCommand,
  sfenPositionCommand,
  withAllLegalMoves,
  withMultiPv,
  type UsiCandidate,
} from "shared";
import type { UsiEngine } from "./usi/engine.js";

/** `evaluateJob` が使うエンジンの範囲（テストからスタブを差し込めるよう最小限に絞る） */
export type EvalEngine = Pick<UsiEngine, "analyze" | "setOption" | "getOption">;

/** 局面評価の既定の候補手数（prd/12 §2.2） */
export const DEFAULT_EVAL_MULTI_PV = 3;

/** server から受け取る評価ジョブ */
export interface PositionEvalJob {
  id: string;
  /** 局面キーと同じ 3 フィールドの SFEN（手数を持たない） */
  sfen: string;
  /** 名指し評価の対象手（USI）。局面評価は null */
  move: string | null;
}

export interface PositionEvalResult {
  candidates: UsiCandidate[];
}

/** 評価ジョブ 1 件の結果。`error` は**そのジョブの失敗**（名指しが効かなかった）で、エンジンは正常 */
export type PositionEvalOutcome = PositionEvalResult | { error: string };

/** server とのやり取り（テストではスタブを渡す） */
export interface PositionJobSource {
  /** 待っているジョブを 1 件取る（無ければ null） */
  claim(): Promise<PositionEvalJob | null>;
  /** 結果 or 失敗を報告する。**失敗も完了**（要求側が取りに来る結果になる） */
  report(
    id: string,
    report: PositionEvalOutcome,
  ): Promise<void>;
}

/**
 * 評価中にエンジンが落ちた・返らなかった。
 *
 * 🔒 呼び出し側は**エンジンを再起動**して次へ進む。棋譜解析の最中に起きた場合でも、
 * 元棋譜の `analysisError` / `analysisRevision` には**触れない**——interactive ジョブに
 * 対応する棋譜も世代も無い（prd/12 §2.5）。棋譜の解析は次の poll で続きから再開する。
 */
export class InteractiveEngineError extends Error {
  constructor(cause: unknown) {
    super(
      `Engine failed during interactive evaluation: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "InteractiveEngineError";
  }
}

/**
 * 1 回の割り込みで処理するジョブ数の上限。
 * 解析中の棋譜が評価要求で止まり続けないように区切る（残りは次の局面境界で処理する）。
 */
const MAX_JOBS_PER_DRAIN = 8;

/** {@link drainEvaluationJobs} の調整つまみ */
export interface DrainOptions {
  /** 1 回で処理するジョブ数の上限（既定 {@link MAX_JOBS_PER_DRAIN}） */
  maxJobs?: number;
}

/**
 * 評価ジョブを 1 件処理する。
 *
 * - 局面評価: `go`（MultiPV を `multiPv` にしてから探索し、終わったら戻す。shared の `withMultiPv`）→ 候補手とスコア
 * - 名指し評価: `go … searchmoves <手>` → **その手の**スコアと読み筋（相手の咎め筋）。
 *   その手 1 本しか返さないので MultiPV は触らない。結果の解釈はブラウザの採点と同じ shared の `namedEvaluationOf`
 *
 * 🔒 名指しした手と違う手が返った（`searchmoves` が効かなかった）ら、**そのジョブの失敗**（`{ error }`）として返す。
 * 数字は作らない。エンジンは正常なので投げない（再起動しない）。次のジョブもまた `searchmoves` で読む
 */
export async function evaluateJob(
  engine: EvalEngine,
  job: PositionEvalJob,
  goCommand: string,
  multiPv: number = DEFAULT_EVAL_MULTI_PV,
): Promise<PositionEvalOutcome> {
  // 局面キー（3 フィールド）なら手数 1 を補う
  const position = sfenPositionCommand(job.sfen);

  if (job.move === null) {
    const result = await withMultiPv(engine, multiPv, () =>
      engine.analyze(position, goCommand),
    );
    // 定跡の列挙が MultiPV を超えて候補を出すので、要求した本数に切り詰める（issue #67）
    return { candidates: extractMultiPvResults(result.infoLines, { multiPv }) };
  }

  // 🔴 名指しの間だけ GenerateAllLegalMoves を有効にする（やねうら王は既定で歩・角・飛の不成を合法手に含めず、
  // `searchmoves` に渡しても通常の探索に落ちる。shared の `withAllLegalMoves`。prd/12 §2.2）。棋譜解析の探索には効かせない
  const move = job.move;
  const result = await withAllLegalMoves(engine, () =>
    engine.analyze(position, searchmovesGoCommand(goCommand, move)),
  );
  const named = namedEvaluationOf(result, move);
  if (named.kind === "mismatch") {
    const returned = named.returned || "none";
    console.warn(`[PositionEval] Named move was not searched (requested ${move}, returned ${returned})`);
    return { error: `Named move was not searched (requested ${move}, returned ${returned})` };
  }
  const { candidate } = named;
  // 評価を出さずにその手を指した（候補なし）。数字を作らず、候補なしとして返す
  if (candidate === null) return { candidates: [] };
  return {
    candidates: [
      {
        rank: 1,
        move,
        score: { type: candidate.scoreType, value: candidate.scoreValue },
        pv: candidate.pv,
        depth: candidate.depth,
      },
    ],
  };
}
/**
 * 待っている評価ジョブを処理しきる（**棋譜解析の局面境界で呼ぶ**）。
 *
 * - claim / report の失敗（インフラ起因）は**握りつぶして戻る**。棋譜解析まで止めない
 *   （取り残したジョブは server 側で期限が来れば `failed` になる。prd/12 §2.4）
 * - エンジンの失敗は当該ジョブを `failed` で完了させたうえで {@link InteractiveEngineError}
 *   を投げる。呼び出し側はエンジンを再起動する
 *
 * ⚠ **候補手数は常に {@link DEFAULT_EVAL_MULTI_PV}（3 本）で、呼び出し側から変えられない。**
 * 棋譜解析の `ENGINE_MULTIPV` は運用で増減してよいつまみだが、局面評価の 3 本は
 * **API の契約**（prd/12 §2.2）で、web / MCP はこれを前提に組む。目的が違うので同じ値に乗せない
 * （`ENGINE_MULTIPV=1` の構成で局面評価まで 1 本になる、という取り違えを型で塞ぐ）。
 */
export async function drainEvaluationJobs(
  engine: EvalEngine,
  source: PositionJobSource,
  goCommand: string,
  options: DrainOptions = {},
): Promise<number> {
  const { maxJobs = MAX_JOBS_PER_DRAIN } = options;
  let processed = 0;
  while (processed < maxJobs) {
    let job: PositionEvalJob | null;
    try {
      job = await source.claim();
    } catch (err) {
      console.warn("[PositionEval] Failed to claim job:", err);
      return processed;
    }
    if (!job) return processed;

    let result: PositionEvalOutcome;
    try {
      result = await evaluateJob(engine, job, goCommand, DEFAULT_EVAL_MULTI_PV);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[PositionEval] Evaluation failed (${job.id}):`, reason);
      // **エラーを報告してから**エンジンの再起動へ回す（結果もエラーも出ないまま宙に浮かせない）
      try {
        await source.report(job.id, { error: reason });
      } catch (reportErr) {
        console.warn("[PositionEval] Failed to report failure:", reportErr);
      }
      throw new InteractiveEngineError(err);
    }

    processed++;
    try {
      await source.report(job.id, result);
    } catch (err) {
      console.warn("[PositionEval] Failed to report result:", err);
      return processed;
    }
  }
  return processed;
}
