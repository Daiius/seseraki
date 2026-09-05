import {
  hasQuickProfile,
  loadConfig,
  profileSettings,
  type Config,
} from "./config.js";
import { UsiEngine } from "./usi/engine.js";
import { MockTaskSource } from "./polling/mock.js";
import type { TaskSource } from "./polling/types.js";
import { analyzeTask } from "./analysis.js";
import { createClient } from "./polling/client.js";
import {
  analyzeKifu,
  buildGoCommand,
  ChunkSubmitError,
} from "./kifu-analysis.js";
import {
  drainEvaluationJobs,
  InteractiveEngineError,
  type PositionJobSource,
} from "./position-eval.js";

/** エンジンのオプションを適用し readyok まで待つ（起動時・再起動時で共用） */
async function configureEngine(engine: UsiEngine, config: Config): Promise<void> {
  engine.setOption("Threads", String(config.engineThreads));
  engine.setOption("USI_Hash", String(config.engineHash));
  // 読み筋(PV)を置換表から延長して出力させる。byoyomi で探索を打ち切ると、最後に出る
  // info 行が探索途中の暫定値になり、pv が 1〜2 手しか埋まっていないことがある
  // （新しい最善手が見つかった直後に時間切れになるケース）。そのままだと候補手一覧の
  // 読み筋が「2 手だけ」で表示され、先の展開が分からない。
  // 検討モードにすると、やねうら王が pv を置換表から辿って補完するので、打ち切られた
  // 局面でも読める長さの読み筋が出る（実測: 2 手 → 20 手超）。
  // 探索アルゴリズムには影響しない（pv を出力する瞬間に置換表を辿るだけ）。
  engine.setOption("ConsiderationMode", "true");
  if (config.engineEvalDir) {
    engine.setOption("EvalDir", config.engineEvalDir);
  }
  if (config.engineBookDir) {
    engine.setOption("BookDir", config.engineBookDir);
    engine.setOption("BookFile", "user_book1.db");
    engine.setOption("IgnoreBookPly", "true");
    engine.setOption("FlippedBook", "true");
    engine.setOption("BookOnTheFly", "true");
    engine.setOption("BookMoves", "999");
    engine.setOption("BookEvalDiff", "0");
    engine.setOption("BookDepthLimit", "0");
  }
  await engine.ready();
}

async function main() {
  const config = loadConfig();
  console.log("[Worker] Starting with config:", {
    enginePath: config.enginePath,
    engineDepth: config.engineDepth,
    engineMovetime: config.engineMovetime,
    // quick 段階（prd/05 §1.1d）。両方 undefined なら quick は無効で 1 段階運用のまま
    engineQuickMovetime: config.engineQuickMovetime,
    engineQuickDepth: config.engineQuickDepth,
    engineThreads: config.engineThreads,
    // hashfull のログ（1 局ごとに出る peak）と突き合わせられるよう、設定値も残す
    engineHash: config.engineHash,
    pollIntervalMs: config.pollIntervalMs,
    useMock: config.useMock,
  });

  // Initialize engine
  const engine = new UsiEngine(config.enginePath);
  await engine.start();
  await configureEngine(engine, config);

  let running = true;
  let analyzing = false;

  if (config.useMock) {
    // Mock mode: use TaskSource interface for simple position analysis
    const taskSource: TaskSource = new MockTaskSource();

    const poll = async () => {
      if (!running || analyzing) return;
      try {
        analyzing = true;
        const task = await taskSource.fetchPending();
        if (task) {
          console.log(`[Worker] Analyzing task: ${task.id}`);
          const result = await analyzeTask(engine, task);
          await taskSource.submitResult(result);
        }
      } catch (err) {
        console.error("[Worker] Error during analysis:", err);
      } finally {
        analyzing = false;
      }
    };

    const intervalId = setInterval(poll, config.pollIntervalMs);
    await poll();

    const shutdown = async () => {
      console.log("\n[Worker] Shutting down...");
      running = false;
      clearInterval(intervalId);
      await engine.quit();
      console.log("[Worker] Shutdown complete");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    // Real mode: fetch unanalyzed kifus from server, analyze full kifu
    const apiKey = process.env.API_KEY;
    if (!apiKey) throw new Error("API_KEY is required when USE_MOCK=false");

    const client = createClient(config.serverUrl, apiKey);

    console.log("[Worker] Ready, waiting for jobs...");

    // エンジンが使える状態か。恒久失敗後の再起動が失敗したら false にし、
    // 復旧するまで棋譜を取得しない（dead なエンジンで正常棋譜まで失敗扱いする連鎖を防ぐ）
    let engineReady = true;

    // エンジンを作り直してオプションを入れ直す。失敗したら engineReady=false にして
    // 復旧するまで次の棋譜を取得しない（連鎖失敗を防ぐ）
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

    // 「quick 待ちの棋譜がある」印（prd/05 §1.1d）。局面評価ジョブの claim 応答に
    // 相乗りしてくるので、**通信を増やさずに** full の割り込み判断ができる。
    // 局面境界では必ず claim が走るため、この値は境界ごとに更新される
    let quickPending = false;

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
    const goCommand = buildGoCommand({
      depth: config.engineDepth,
      movetime: config.engineMovetime,
    });
    /** 待っている評価ジョブを捌く。エンジンが落ちたら再起動し、捌けなかったことを返す */
    const drainPositionJobs = async (): Promise<boolean> => {
      try {
        // ⚠ MultiPV は `drainEvaluationJobs` が 3 本固定で設定する（`ENGINE_MULTIPV` は渡さない）。
        // 棋譜解析の候補手数は運用で増減できるつまみだが、局面評価の 3 本は
        // **API の契約**（prd/12 §2.2）で、利用側はこれを前提に組む。目的が違うので同じ値に乗せない
        await drainEvaluationJobs(engine, positionJobs, goCommand);
        return true;
      } catch (err) {
        if (!(err instanceof InteractiveEngineError)) throw err;
        // 🔒 棋譜起因ではないので analysisError は立てない（prd/12 §2.5）
        console.error("[Worker] Interactive evaluation failed:", err.message);
        await restartEngine();
        return false;
      }
    };

    const poll = async () => {
      if (!running || analyzing) return;
      analyzing = true;
      try {
        // エンジンが未復旧なら、棋譜を取得する前に復旧を試みる
        if (!engineReady) {
          try {
            console.log("[Worker] Recovering engine...");
            await engine.restart();
            await configureEngine(engine, config);
            engineReady = true;
            console.log("[Worker] Engine recovered");
          } catch (recoverErr) {
            console.error(
              "[Worker] Engine recovery failed, will retry:",
              recoverErr,
            );
            return; // 次の poll で再試行。棋譜は掴まない
          }
        }

        // 棋譜より先に検討局面の評価を捌く（棋譜が無いときもここが処理の場になる）。
        // エンジンを作り直したときは、この poll では棋譜に進まない
        if (!(await drainPositionJobs())) return;

        // fetch 失敗はインフラ起因（一時）。次の poll で再試行する
        const kifu = await client.fetchNextKifu(hasQuickProfile(config));
        if (!kifu) return;
        if (!kifu.usiMoves) {
          console.warn(`[Worker] Skipping kifu ${kifu.id}: no usiMoves`);
          return;
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
        };
        console.log(
          `[Worker] Analyzing kifu ${kifu.id} (${profile}): ${kifu.title}`,
        );

        // --- 棋譜起因（恒久失敗）: illegal move / エンジン死亡 / timeout ---
        // analysisError を記録して poll から除外し、エンジンを再起動して次へ進む
        let result;
        try {
          result = await analyzeKifu(engine, kifu.usiMoves, {
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
                .reportProgress(
                  kifu.id,
                  kifu.analysisRevision,
                  profile,
                  analyzed,
                  total,
                )
                .catch((err: unknown) => {
                  console.warn("[Worker] Failed to report progress:", err);
                });
            },
            // 1 局面ごとに検討局面の評価を差し込む（prd/12 §2.1）。
            // 最大待ちは「現局面の解析残り時間 + ポーリング間隔」に収まる
            onPositionBoundary: async () => {
              // ⚠ ここでも MultiPV は渡さない（3 本固定・上の drainPositionJobs と同じ理由）
              await drainEvaluationJobs(engine, positionJobs, goCommand);
              // 🔴 full を解析中に quick 待ちが現れたら、局面境界で中断して quick を先に処理する
              // （未送信チャンクは `analyzeKifu` が送ってから抜ける。prd/05 §1.1d）。
              // 優先順位は **位置評価ジョブ > quick > full** なので、判定はジョブを捌いた後
              return profile === "full" && quickPending;
            },
            // 解析結果のチャンクは**完了を待って**送る。失敗は握りつぶさず解析を中断する
            // （続行すると moveNumber に穴が空き、再開位置を件数で決められなくなる）
            onChunk: async (analyses) => {
              try {
                await client.submitAnalysis(
                  kifu.id,
                  kifu.analysisRevision,
                  analyses,
                  provenance,
                );
              } catch (err) {
                throw new ChunkSubmitError(err);
              }
            },
          });
        } catch (err) {
          // --- インフラ起因（一時失敗）: submit 失敗は記録せず次の poll で続きから再開 ---
          if (err instanceof ChunkSubmitError) {
            console.error(`[Worker] Submit failed for kifu ${kifu.id}:`, err);
            return;
          }
          // --- 検討局面の評価でエンジンが落ちた: 棋譜は無関係なので analysisError は
          // 立てない（prd/12 §2.5）。エンジンを作り直し、次の poll で続きから再開する ---
          if (err instanceof InteractiveEngineError) {
            console.error("[Worker] Interactive evaluation failed:", err.message);
            await restartEngine();
            return;
          }
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`[Worker] Analysis failed for kifu ${kifu.id}:`, reason);
          try {
            await client.reportError(kifu.id, kifu.analysisRevision, reason);
          } catch (reportErr) {
            console.error("[Worker] Failed to report error:", reportErr);
          }
          // エンジン再起動。失敗したら engineReady=false にして、
          // 復旧するまで次の棋譜を取得しない（連鎖失敗を防ぐ）
          await restartEngine();
          return;
        }

        // 🔒 中断は**失敗ではない**。analysisError は立てず、エンジンも再起動せず次の poll へ
        // （quick が先に拾われ、full は行数から続きを再開する。prd/05 §1.1d）
        if (result.interrupted) {
          console.log(
            `[Worker] Paused kifu ${kifu.id} (${profile}) after ${result.analyzed} positions: quick pending`,
          );
          return;
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
      } catch (err) {
        console.error("[Worker] Error:", err);
      } finally {
        analyzing = false;
      }
    };

    const intervalId = setInterval(poll, config.pollIntervalMs);
    await poll();

    const shutdown = async () => {
      console.log("[Worker] Shutting down...");
      running = false;
      clearInterval(intervalId);
      await engine.quit();
      console.log("[Worker] Shutdown complete");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
