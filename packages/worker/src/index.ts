import { loadConfig, type Config } from "./config.js";
import { UsiEngine } from "./usi/engine.js";
import { MockTaskSource } from "./polling/mock.js";
import type { TaskSource } from "./polling/types.js";
import { analyzeTask } from "./analysis.js";
import { createClient } from "./polling/client.js";
import { analyzeKifu, ChunkSubmitError } from "./kifu-analysis.js";

/** エンジンのオプションを適用し readyok まで待つ（起動時・再起動時で共用） */
async function configureEngine(engine: UsiEngine, config: Config): Promise<void> {
  engine.setOption("Threads", String(config.engineThreads));
  engine.setOption("USI_Hash", String(config.engineHash));
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

        // fetch 失敗はインフラ起因（一時）。次の poll で再試行する
        const kifu = await client.fetchNextKifu();
        if (!kifu) return;
        if (!kifu.usiMoves) {
          console.warn(`[Worker] Skipping kifu ${kifu.id}: no usiMoves`);
          return;
        }
        console.log(`[Worker] Analyzing kifu ${kifu.id}: ${kifu.title}`);

        // --- 棋譜起因（恒久失敗）: illegal move / エンジン死亡 / timeout ---
        // analysisError を記録して poll から除外し、エンジンを再起動して次へ進む
        let result;
        try {
          result = await analyzeKifu(engine, kifu.usiMoves, {
            depth: config.engineDepth,
            multiPv: config.engineMultiPv,
            byoyomi: config.engineByoyomi,
            // 途中まで入っている棋譜は続きから解析する（prd/05 §1.1c）
            startMoveNumber: kifu.analyzedCount,
            // 進捗報告は待たずに投げっぱなしにし、失敗も握りつぶす。server が落ちている・
            // 遅いときに解析まで止まるのは本末転倒（進捗は表示のためだけの揮発情報）
            onProgress: (analyzed, total) => {
              void client
                .reportProgress(kifu.id, kifu.analysisRevision, analyzed, total)
                .catch((err: unknown) => {
                  console.warn("[Worker] Failed to report progress:", err);
                });
            },
            // 解析結果のチャンクは**完了を待って**送る。失敗は握りつぶさず解析を中断する
            // （続行すると moveNumber に穴が空き、再開位置を件数で決められなくなる）
            onChunk: async (analyses) => {
              try {
                await client.submitAnalysis(
                  kifu.id,
                  kifu.analysisRevision,
                  analyses,
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
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`[Worker] Analysis failed for kifu ${kifu.id}:`, reason);
          try {
            await client.reportError(kifu.id, kifu.analysisRevision, reason);
          } catch (reportErr) {
            console.error("[Worker] Failed to report error:", reportErr);
          }
          // エンジン再起動。失敗したら engineReady=false にして、
          // 復旧するまで次の棋譜を取得しない（連鎖失敗を防ぐ）
          try {
            console.log("[Worker] Restarting engine...");
            await engine.restart();
            await configureEngine(engine, config);
          } catch (restartErr) {
            console.error("[Worker] Engine restart failed:", restartErr);
            engineReady = false;
          }
          return;
        }

        // 完了（analysisCompletedAt）は server が件数で確定する（prd/05 §1.1c）
        console.log(
          `[Worker] Completed kifu ${kifu.id} (${result.totalMoves} moves, ${result.analyzed} positions analyzed)`,
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
