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
import { extractMultiPvResults, type CandidateMove } from "./kifu-analysis.js";
import type { UsiEngine } from "./usi/engine.js";
import type { UsiScore } from "./usi/types.js";

/** `evaluateJob` が使うエンジンの範囲（テストからスタブを差し込めるよう最小限に絞る） */
export type EvalEngine = Pick<UsiEngine, "analyze" | "setOption" | "getOption">;

/** USI の MultiPV 既定値。`setOption` を送っていないエンジンはこの値で動いている */
const USI_DEFAULT_MULTI_PV = "1";

/** 局面評価の既定の候補手数（prd/12 §2.2） */
export const DEFAULT_EVAL_MULTI_PV = 3;

/**
 * 詰めろ probe の候補手数。**1 で固定**（設計 §0.4）。
 *
 * 🔴 やねうら王の「詰みを読み切ったら反復深化を打ち切る」早期終了は
 * **MultiPV 1 のときだけ効く**（本番実測: 9 手詰 + `movetime 2000` で MultiPV 1 は 66ms、
 * MultiPV 3 は 2000ms 使い切り）。3 本にすると詰めろがある局面でも毎回予算を使い切るので、
 * probe を局面評価（3 本固定）に相乗りさせられない。
 */
export const PROBE_MULTI_PV = 1;

/** server から受け取る評価ジョブ */
export interface PositionEvalJob {
  id: string;
  /**
   * 評価の種別（設計 §2.4）。`probe` は**手番を反転した局面 P′** の詰めろ探索で、
   * MultiPV も予算も局面評価とは別（{@link PROBE_MULTI_PV}）
   */
  kind: "eval" | "probe";
  /** 局面キーと同じ 3 フィールドの SFEN（手数を持たない。probe は 4 フィールドで来る） */
  sfen: string;
  /** 名指し評価の対象手（USI）。局面評価と probe は null */
  move: string | null;
}

export interface PositionEvalResult {
  candidates: CandidateMove[];
  /** `searchmoves` ではなく符号反転のフォールバックで求めたか（prd/12 §2.2） */
  fallback: boolean;
  /**
   * 実際に送った `go` の予算。probe の「検出なし」が**「詰めろではない」ではなく
   * 「この予算では見つからなかった」**でしかないことを表示側で扱えるようにする（設計 §2.7）
   */
  budget?: { movetime?: number; depth?: number };
}

/**
 * 送った `go` コマンドから予算を読み取る。
 *
 * 🔒 **組み立てた文字列そのものから取る**（別に受け取った設定値ではなく）。
 * 「エンジンに何を渡したか」と結果に添える値が構造的にずれない。
 */
export function budgetOfGoCommand(go: string): {
  movetime?: number;
  depth?: number;
} {
  const movetime = /\bmovetime\s+(\d+)/.exec(go);
  if (movetime) return { movetime: Number(movetime[1]) };
  const depth = /\bdepth\s+(\d+)/.exec(go);
  if (depth) return { depth: Number(depth[1]) };
  return {};
}

/** server とのやり取り（テストではスタブを渡す） */
export interface PositionJobSource {
  /** 待っているジョブを 1 件取る（無ければ null） */
  claim(): Promise<PositionEvalJob | null>;
  /** 結果 or 失敗を報告する。**失敗も完了**（要求側が取りに来る結果になる） */
  report(
    id: string,
    report: PositionEvalResult | { error: string },
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
  /**
   * 詰めろ probe に使う `go`（既定は棋譜解析と同じ `goCommand`）。
   * `ENGINE_PROBE_MOVETIME` を設定したときだけ別の値になる（prd/12 §2.2）
   */
  probeGoCommand?: string;
}

/**
 * MultiPV を一時的に `multiPv` にして `run` を実行し、**終わったら元の値へ戻す**。
 * 元の値はエンジンが覚えている（`setOption` を送っていなければ USI 既定の 1）。
 * 既に同じ値なら `setoption` を 1 度も送らない——棋譜解析の割り込み（既に 3）で
 * 余計なコマンドを挟まないため。
 */
async function withMultiPv<T>(
  engine: EvalEngine,
  multiPv: number,
  run: () => Promise<T>,
): Promise<T> {
  const desired = String(multiPv);
  const previous = engine.getOption("MultiPV") ?? USI_DEFAULT_MULTI_PV;
  if (previous === desired) return run();

  engine.setOption("MultiPV", desired);
  try {
    return await run();
  } finally {
    engine.setOption("MultiPV", previous);
  }
}

/**
 * やねうら王が `go searchmoves` を解釈したか。
 *
 * ⚠ **実機で確かめるまで分からない**ので、まず送ってみて**指した手が名指しした手か**で判定する
 * （無視するエンジンは自分の最善手を返す）。一度「非対応」と分かったら以降は
 * フォールバックへ直行する（毎回 1 回ぶん無駄に探索しない）。
 * プロセスの生存期間だけ覚える揮発的な判定で、再起動すればまた試す。
 */
let searchmovesSupported: boolean | null = null;

/** テスト用。`searchmoves` 対応の判定を忘れる */
export function resetSearchmovesSupport(): void {
  searchmovesSupported = null;
}

/** 手番から見た評価値の符号を反転する（相手番の局面の値を自分の値に読み替える） */
function negate(score: UsiScore): UsiScore {
  return { type: score.type, value: -score.value };
}

/**
 * 局面キー（3 フィールド）を USI の `position` コマンドにする。
 * USI は手数を含む 4 フィールドを要求するので、無ければ 1 を補う
 * （検討局面は棋譜から切り離された「その形」でしかなく、探索は手数に依存しない）。
 */
function positionCommand(sfen: string, moves: string[] = []): string {
  const fields = sfen.trim().split(/\s+/);
  const withPly = fields.length >= 4 ? sfen.trim() : `${sfen.trim()} 1`;
  const suffix = moves.length > 0 ? ` moves ${moves.join(" ")}` : "";
  return `position sfen ${withPly}${suffix}`;
}

/**
 * 評価ジョブを 1 件処理する。
 *
 * - 詰めろ probe: **MultiPV 1** で `go`（`searchmoves` は使わない）→ 候補手 1 本 + 予算。
 *   rank 1 が `mate +N` なら詰めろ（受方がパスしたら N 手で詰む）
 * - 局面評価: `go`（MultiPV を `multiPv` にしてから探索し、終わったら戻す）→ 候補手とスコア
 * - 名指し評価: `go searchmoves <手>` → **その手の**スコアと読み筋（相手の咎め筋）
 *   非対応なら「手を適用した局面を評価して符号反転」のフォールバックで**同じ契約**を守る。
 *   どちらも**その手 1 本**しか返さないので MultiPV は触らない
 */
export async function evaluateJob(
  engine: EvalEngine,
  job: PositionEvalJob,
  goCommand: string,
  multiPv: number = DEFAULT_EVAL_MULTI_PV,
): Promise<PositionEvalResult> {
  const position = positionCommand(job.sfen);

  if (job.kind === "probe") {
    // 🔒 `goCommand` は `buildGoCommand` が組み立てたもの（`go movetime` / `go depth`）。
    //    **`go mate` を組み立てる経路は作らない**——やねうら王の通常エンジンは
    //    `go mate <ms>` の時間引数を停止条件として読まず、`bestmove` が返らない（設計 §0.2）
    const result = await withMultiPv(engine, PROBE_MULTI_PV, () =>
      engine.analyze(position, goCommand),
    );
    return {
      candidates: extractMultiPvResults(result.infoLines).slice(0, 1),
      fallback: false,
      budget: budgetOfGoCommand(goCommand),
    };
  }

  if (job.move === null) {
    const result = await withMultiPv(engine, multiPv, () =>
      engine.analyze(position, goCommand),
    );
    return { candidates: extractMultiPvResults(result.infoLines), fallback: false };
  }

  if (searchmovesSupported !== false) {
    const result = await engine.analyze(
      position,
      `${goCommand} searchmoves ${job.move}`,
    );
    const candidates = extractMultiPvResults(result.infoLines);
    const named = candidates.find((c) => c.move === job.move);
    if (named) {
      searchmovesSupported = true;
      return { candidates: [{ ...named, rank: 1 }], fallback: false };
    }
    // 名指ししていない手が返った = searchmoves が無視された
    console.warn(
      `[PositionEval] searchmoves が効いていないためフォールバックします（要求 ${job.move} / 応答 ${candidates[0]?.move ?? "なし"}）`,
    );
    searchmovesSupported = false;
  }

  // フォールバック: 手を適用した局面（＝相手番）を評価し、符号を反転して自分視点に戻す。
  // 読み筋の先頭に名指しした手を足すと、`searchmoves` と同じ形（自分の手 → 咎め筋）になる
  const result = await engine.analyze(
    positionCommand(job.sfen, [job.move]),
    goCommand,
  );
  const [best] = extractMultiPvResults(result.infoLines);
  if (!best) {
    // 相手に指す手が無い（詰み/入玉図など）ときは候補が空になる。
    // 数字を捏造せず、候補なしとして返す（server はそのまま結果として保持する）
    return { candidates: [], fallback: true };
  }
  return {
    candidates: [
      {
        rank: 1,
        move: job.move,
        score: negate(best.score),
        pv: [job.move, ...best.pv],
        depth: best.depth,
      },
    ],
    fallback: true,
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
  const { maxJobs = MAX_JOBS_PER_DRAIN, probeGoCommand = goCommand } = options;
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

    let result: PositionEvalResult;
    try {
      result = await evaluateJob(
        engine,
        job,
        job.kind === "probe" ? probeGoCommand : goCommand,
        DEFAULT_EVAL_MULTI_PV,
      );
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
