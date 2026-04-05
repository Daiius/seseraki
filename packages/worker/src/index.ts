import { loadConfig } from "./config.js";
import { UsiEngine } from "./usi/engine.js";
import { MockTaskSource } from "./polling/mock.js";
import type { TaskSource } from "./polling/types.js";
import { analyzeTask } from "./analysis.js";
import { createClient } from "./polling/client.js";
import { analyzeKifu } from "./kifu-analysis.js";

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

  engine.setOption("Threads", String(config.engineThreads));
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

    const poll = async () => {
      if (!running || analyzing) return;
      try {
        analyzing = true;
        const kifus = await client.fetchUnanalyzedKifus();
        if (kifus.length === 0) {
          console.log("[Worker] No unanalyzed kifus");
          return;
        }
        for (const kifu of kifus) {
          if (!running) break;
          console.log(
            `[Worker] Analyzing kifu ${kifu.id}: ${kifu.title}`,
          );
          const result = await analyzeKifu(engine, kifu.kifText, {
            depth: config.engineDepth,
            multiPv: config.engineMultiPv,
          });
          await client.submitAnalysis(kifu.id, result);
          console.log(
            `[Worker] Completed kifu ${kifu.id} (${result.totalMoves} moves)`,
          );
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
  }

  console.log(
    `[Worker] Polling every ${config.pollIntervalMs}ms. Press Ctrl+C to stop.`,
  );
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
