/**
 * 手元 worker の poll 1 回分（prd/05 §1.1）。エンジンと client を注入で受け、失敗の種類ごとの扱いをここに集める。
 *
 * | 失敗 | 扱い |
 * |---|---|
 * | 局面評価でエンジンが落ちた（`InteractiveEngineError`） | 棋譜の失敗にしない。エンジンを作り直し、次の poll で続きから（prd/12 §2.5） |
 * | チャンク送信の一時失敗（`ChunkSubmitError`） | 記録しない。次の poll で続きから（prd/05 §1.1a） |
 * | チャンク送信の拒否（`SubmitRejectedError`・4xx） | 恒久失敗。`analysisError` を記録する。エンジンは正常なので再起動しない |
 * | 探索の失敗（不正な指し手・エンジンの死・時間切れ） | 恒久失敗。`analysisError` を記録し、エンジンを作り直す |
 * | 停止中（SIGTERM・SIGINT）の失敗 | 棋譜の失敗にしない（エンジンが止められて落ちただけ） |
 * | エンジンの作り直しの失敗 | 復旧するまで棋譜を取得しない（死んだエンジンで正常な棋譜まで失敗にする連鎖を防ぐ） |
 *
 * 🔒 局面境界での中断（quick 待ち・停止）は**失敗ではない**。`analysisError` は立てず、エンジンも作り直さない。
 */
import { analyzeKifu, ChunkSubmitError, SubmitRejectedError } from "shared";
import {
  evalProvenance,
  hasQuickProfile,
  profileSettings,
  type Config,
} from "./config.js";
import { configureEngine } from "./configure-engine.js";
import {
  drainEvaluationJobs,
  InteractiveEngineError,
  type PositionJobSource,
} from "./position-eval.js";
import type { WorkerClient } from "./polling/client.js";
import { consoleLog, type UsiEngine } from "./usi/engine.js";

/** poll が使うエンジンの範囲（テストではスタブを渡す） */
export type PollEngine = Pick<
  UsiEngine,
  "analyze" | "setOption" | "getOption" | "getName" | "ready" | "restart"
>;

/** poll が使う client の範囲（テストではスタブを渡す） */
export type PollClient = Pick<
  WorkerClient,
  | "fetchNextKifu"
  | "submitAnalysis"
  | "reportProgress"
  | "reportError"
  | "claimPositionJob"
  | "reportPositionResult"
>;

export interface PollDeps {
  engine: PollEngine;
  client: PollClient;
  config: Config;
  /** 停止が始まっていなければ true（SIGTERM・SIGINT で false になる） */
  isRunning(): boolean;
}

/** poll 1 回の結末（ログとテストのため。呼び出し側は分岐に使わない） */
export type PollOutcome =
  /** エンジンが未復旧で、作り直しにも失敗した（棋譜は掴まない） */
  | "engine-unavailable"
  /** 局面評価でエンジンが落ち、作り直した（この poll では棋譜に進まない） */
  | "interactive-restarted"
  /** 停止が始まっていたので棋譜を掴まなかった */
  | "stopped"
  /** 解析する棋譜が無い */
  | "idle"
  /** 指し手の無い棋譜を飛ばした */
  | "skipped"
  | "completed"
  /** 局面境界で中断した（quick 待ち・停止） */
  | "interrupted"
  /** 停止中に解析が落ちた（棋譜の失敗にしない） */
  | "stopped-by-shutdown"
  /** チャンク送信の一時失敗（次の poll で続きから） */
  | "submit-failed"
  /** チャンク送信を server が拒否した（恒久失敗を記録した） */
  | "rejected"
  /** 探索の失敗（恒久失敗を記録し、エンジンを作り直した） */
  | "failed";

export interface Poller {
  /**
   * poll を 1 回まわす。棋譜の取得の失敗（通信）は投げる——一時失敗で、呼び出し側はログに残して次の poll で再試行する
   */
  runOnce(): Promise<PollOutcome>;
  /** エンジンが使える状態か（作り直しに失敗したら false。次の poll の頭で作り直しを試す） */
  isEngineReady(): boolean;
}

export function createPoller(deps: PollDeps): Poller {
  const { engine, client, config, isRunning } = deps;

  // エンジンが使える状態か。恒久失敗後の再起動が失敗したら false にし、
  // 復旧するまで棋譜を取得しない（dead なエンジンで正常棋譜まで失敗扱いする連鎖を防ぐ）
  let engineReady = true;

  // 「quick 待ちの棋譜がある」印（prd/05 §1.1d）。局面評価ジョブの claim 応答に
  // 相乗りしてくるので、**通信を増やさずに** full の割り込み判断ができる。
  // 局面境界では必ず claim が走るため、この値は境界ごとに更新される
  let quickPending = false;

  /** エンジンを作り直してオプションを入れ直す。失敗したら engineReady=false（次の poll の頭で作り直す） */
  const restartEngine = async () => {
    try {
      console.log("[Worker] Restarting engine...");
      await engine.restart();
      await configureEngine(engine, config);
    } catch (restartErr) {
      console.error("[Worker] Engine restart failed:", restartErr);
      engineReady = false;
    }
  };

  // 検討局面の評価（prd/12 §2）。棋譜解析と**同じエンジン・full の設定**に相乗りする
  // （🔒 quick の設定は使わない。局面評価の品質は ENGINE_MOVETIME が契約。prd/12 §2.1）
  const positionJobs: PositionJobSource = {
    claim: async () => {
      const { job, quickPending: pending } = await client.claimPositionJob();
      quickPending = pending;
      return job;
    },
    report: async (id, report) => {
      await client.reportPositionResult(id, report);
    },
  };
  const evalSearch = {
    depth: config.engineDepth,
    movetime: config.engineMovetime,
  };

  /** 待っている評価ジョブを捌く。エンジンが落ちたら再起動し、捌けなかったことを返す */
  const drainPositionJobs = async (): Promise<boolean> => {
    try {
      // ⚠ MultiPV は `drainEvaluationJobs` が 3 本固定で設定する（`ENGINE_MULTIPV` は渡さない）。
      // 棋譜解析の候補手数は運用で増減できるつまみだが、局面評価の 3 本は
      // **API の契約**（prd/12 §2.2）で、利用側はこれを前提に組む。目的が違うので同じ値に乗せない
      await drainEvaluationJobs(engine, positionJobs, evalSearch);
      return true;
    } catch (err) {
      if (!(err instanceof InteractiveEngineError)) throw err;
      // 🔒 棋譜起因ではないので analysisError は立てない（prd/12 §2.5）
      console.error("[Worker] Interactive evaluation failed:", err.message);
      await restartEngine();
      return false;
    }
  };

  const runOnce = async (): Promise<PollOutcome> => {
    // エンジンが未復旧なら、棋譜を取得する前に復旧を試みる
    if (!engineReady) {
      try {
        console.log("[Worker] Recovering engine...");
        await engine.restart();
        await configureEngine(engine, config);
        engineReady = true;
        console.log("[Worker] Engine recovered");
      } catch (recoverErr) {
        console.error("[Worker] Engine recovery failed, will retry:", recoverErr);
        return "engine-unavailable"; // 次の poll で再試行。棋譜は掴まない
      }
    }

    // 棋譜より先に検討局面の評価を捌く（棋譜が無いときもここが処理の場になる）。
    // エンジンを作り直したときは、この poll では棋譜に進まない
    if (!(await drainPositionJobs())) return "interactive-restarted";
    // 停止が始まったら次の棋譜を掴まない
    if (!isRunning()) return "stopped";

    // fetch 失敗はインフラ起因（一時）。投げて、次の poll で再試行する
    const quickCapable = hasQuickProfile(config);
    const kifu = await client.fetchNextKifu(quickCapable);
    if (!kifu) return "idle";
    if (!kifu.usiMoves) {
      console.warn(`[Worker] Skipping kifu ${kifu.id}: no usiMoves`);
      return "skipped";
    }
    // 実行する段階は server が決める（quick 未完 → full 未完の順。prd/05 §1.1d）
    const profile = kifu.profile;
    const settings = profileSettings(config, profile);
    // 来歴（prd/03 §3）。**探索を支配した値だけ**を残す——movetime 指定時は depth を
    // 見ないので、そのときに目標 depth を書くと読む側を誤らせる
    const provenance = {
      profile,
      engineName: engine.getName() ?? null,
      movetimeMs: settings.movetime ?? null,
      targetDepth: settings.movetime === undefined ? settings.depth : null,
      multiPv: config.engineMultiPv,
      // 評価関数の識別と尺度（設定されているときだけ。prd/14 §5.9）
      ...evalProvenance(config),
    };
    console.log(`[Worker] Analyzing kifu ${kifu.id} (${profile}): ${kifu.title}`);

    let result;
    try {
      result = await analyzeKifu(engine, kifu.usiMoves, {
        // 解析のループは `shared` にあり `console` を持たないので、出力先を渡す
        log: consoleLog,
        // 段階ごとの設定（quick は ENGINE_QUICK_*・full は ENGINE_MOVETIME/DEPTH）。
        // 🔒 MultiPV は両段階で共通（悪手判定と検討盤の再利用が本数に依存する）
        depth: settings.depth,
        multiPv: config.engineMultiPv,
        movetime: settings.movetime,
        // 途中まで入っている棋譜は続きから解析する（prd/05 §1.1c）
        startMoveNumber: kifu.analyzedCount,
        // 進捗報告は待たずに投げっぱなしにし、失敗も握りつぶす。server が落ちている・
        // 遅いときに解析まで止まるのは本末転倒（進捗は表示のためだけの揮発情報）
        onProgress: (analyzed, total) => {
          void client
            .reportProgress(kifu.id, kifu.analysisRevision, profile, analyzed, total)
            .catch((err: unknown) => {
              console.warn("[Worker] Failed to report progress:", err);
            });
        },
        // 1 局面ごとに検討局面の評価を差し込む（prd/12 §2.1）。
        // 最大待ちは「現局面の解析残り時間 + ポーリング間隔」に収まる
        onPositionBoundary: async () => {
          // 停止中（SIGTERM）は局面境界で中断する（未送信のチャンクは送ってから抜ける。中断は失敗ではない）。
          // shutdown はこの poll の終わりを待ってからエンジンを止める
          if (!isRunning()) return true;
          // ⚠ ここでも MultiPV は渡さない（3 本固定・上の drainPositionJobs と同じ理由）
          await drainEvaluationJobs(engine, positionJobs, evalSearch);
          // 🔴 full を解析中に quick 待ちが現れたら、局面境界で中断して quick を先に処理する
          // （未送信チャンクは `analyzeKifu` が送ってから抜ける。prd/05 §1.1d）。
          // 優先順位は **位置評価ジョブ > quick > full** なので、判定はジョブを捌いた後。
          //
          // ⚠ **quick を持たない worker は中断しない。** その構成では quick 未完の棋譜が
          // `full` として渡ってくる（1 段階運用）ので、**いま解析している棋譜自身が
          // 「quick 待ち」に数えられる**。中断すると次の poll で同じ棋譜を掴み直し、
          // 1 局面ごとに中断する堂々巡りになる
          return quickCapable && profile === "full" && quickPending;
        },
        // 解析結果のチャンクは**完了を待って**送る。失敗は握りつぶさず解析を中断する
        // （続行すると moveNumber に穴が空き、再開位置を件数で決められなくなる）
        onChunk: async (analyses) => {
          try {
            await client.submitAnalysis(kifu.id, kifu.analysisRevision, analyses, provenance);
          } catch (err) {
            // 入力の誤りとしての拒否（4xx）はそのまま投げる（恒久失敗。下で analysisError を記録）
            if (err instanceof SubmitRejectedError) throw err;
            throw new ChunkSubmitError(err);
          }
        },
      });
    } catch (err) {
      // 🔒 停止中（SIGTERM・SIGINT）の失敗は棋譜の失敗にしない。エンジンが止められて解析が落ちただけ
      // （Ctrl+C はエンジンにも届く）。記録すると、正常な棋譜が恒久的な失敗として残る
      if (!isRunning()) {
        console.log(`[Worker] Analysis of kifu ${kifu.id} stopped by shutdown`);
        return "stopped-by-shutdown";
      }
      // --- インフラ起因（一時失敗）: submit 失敗は記録せず次の poll で続きから再開 ---
      if (err instanceof ChunkSubmitError) {
        console.error(`[Worker] Submit failed for kifu ${kifu.id}:`, err);
        return "submit-failed";
      }
      // --- server が入力の誤りとして拒否した（4xx）: 送り直しても同じなので恒久失敗。
      // analysisError を記録して poll から外す（記録しないと同じ棋譜の解析と拒否を繰り返し、
      // 後続が進まない）。エンジンは正常なので再起動しない ---
      if (err instanceof SubmitRejectedError) {
        console.error(`[Worker] Submit rejected for kifu ${kifu.id}:`, err.message);
        await reportKifuError(kifu.id, kifu.analysisRevision, err.message);
        return "rejected";
      }
      // --- 検討局面の評価でエンジンが落ちた: 棋譜は無関係なので analysisError は
      // 立てない（prd/12 §2.5）。エンジンを作り直し、次の poll で続きから再開する ---
      if (err instanceof InteractiveEngineError) {
        console.error("[Worker] Interactive evaluation failed:", err.message);
        await restartEngine();
        return "interactive-restarted";
      }
      // --- 棋譜起因（恒久失敗）: illegal move / エンジン死亡 / timeout ---
      // analysisError を記録して poll から除外し、エンジンを再起動して次へ進む
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[Worker] Analysis failed for kifu ${kifu.id}:`, reason);
      await reportKifuError(kifu.id, kifu.analysisRevision, reason);
      // 再起動に失敗したら engineReady=false にして、復旧するまで次の棋譜を取得しない（連鎖失敗を防ぐ）
      await restartEngine();
      return "failed";
    }

    // 🔒 中断は**失敗ではない**。analysisError は立てず、エンジンも再起動せず次の poll へ
    // （quick が先に拾われ、full は行数から続きを再開する。prd/05 §1.1d）
    if (result.interrupted) {
      console.log(
        `[Worker] Paused kifu ${kifu.id} (${profile}) after ${result.analyzed} positions: ${
          isRunning() ? "quick pending" : "shutting down"
        }`,
      );
      return "interrupted";
    }

    // 完了（analysisCompletedAt / analysisProfile）は server が段階ごとの件数で確定する
    // （prd/05 §1.1c・§1.1d）
    console.log(
      `[Worker] Completed kifu ${kifu.id} (${profile}, ${result.totalMoves} moves, ${result.analyzed} positions analyzed${
        result.maxHashfull !== undefined
          ? `, peak hashfull ${result.maxHashfull}‰ / USI_Hash ${config.engineHash}MB`
          : ""
      })`,
    );
    return "completed";
  };

  /** 恒久失敗を記録する（報告の失敗は握りつぶす。次の poll でまた掴めば、また記録を試みる） */
  const reportKifuError = async (kifuId: number, revision: number, reason: string) => {
    try {
      await client.reportError(kifuId, revision, reason);
    } catch (reportErr) {
      console.error("[Worker] Failed to report error:", reportErr);
    }
  };

  return { runOnce, isEngineReady: () => engineReady };
}
