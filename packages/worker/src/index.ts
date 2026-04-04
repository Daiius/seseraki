import { loadConfig } from "./config.js";
import { UsiEngine } from "./usi/engine.js";
import { MockTaskSource } from "./polling/mock.js";
import type { TaskSource } from "./polling/types.js";
import { analyzeTask } from "./analysis.js";

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
  await engine.ready();

  // Initialize task source
  const taskSource: TaskSource = config.useMock
    ? new MockTaskSource()
    : (() => {
        throw new Error("Real task source not implemented yet");
      })();

  // Polling loop
  let running = true;
  let analyzing = false;

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
  // Run first poll immediately
  await poll();

  // Graceful shutdown
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

  console.log(
    `[Worker] Polling every ${config.pollIntervalMs}ms. Press Ctrl+C to stop.`,
  );
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
