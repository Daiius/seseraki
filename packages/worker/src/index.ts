import { loadConfig, type Config } from "./config.js";
import { configureEngine } from "./configure-engine.js";
import { UsiEngine } from "./usi/engine.js";
import { MockTaskSource } from "./polling/mock.js";
import type { TaskSource } from "./polling/types.js";
import { analyzeTask } from "./analysis.js";
import { createClient } from "./polling/client.js";
import { createPoller } from "./poll.js";

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
    engineFvScale: config.engineFvScale,
    engineEvalSha256: config.engineEvalSha256,
    pollIntervalMs: config.pollIntervalMs,
    useMock: config.useMock,
  });

  // Initialize engine
  const engine = new UsiEngine(config.enginePath);
  await engine.start();
  await configureEngine(engine, config);

  let running = true;
  let analyzing = false;

  /** poll 1 回分。mock は固定の局面を読むだけ、本番は server から棋譜とジョブを取る（`poll.ts`） */
  const runOnce = config.useMock
    ? createMockRunOnce(engine)
    : createRealRunOnce(engine, config, () => running);

  const poll = async () => {
    if (!running || analyzing) return;
    analyzing = true;
    try {
      await runOnce();
    } catch (err) {
      // 棋譜の取得の失敗など（一時）。次の poll で再試行する
      console.error("[Worker] Error:", err);
    } finally {
      analyzing = false;
    }
  };

  // 実行中の poll（shutdown がその終わりを待つ）
  let inFlight: Promise<void> | null = null;
  const tick = () => {
    // ⚠ 実行中は差し替えない（poll は同期的に analyzing を立てるので、ここで重ならない）
    if (!running || analyzing) return inFlight ?? Promise.resolve();
    inFlight = poll();
    return inFlight;
  };
  const intervalId = setInterval(tick, config.pollIntervalMs);
  const shutdown = async () => {
    if (!running) return;
    console.log("[Worker] Shutting down...");
    running = false;
    clearInterval(intervalId);
    // 🔒 poll の終わりを待ってから quit する。解析中にエンジンを止めると、その失敗が棋譜の失敗として
    // 報告されうる（解析は局面境界で中断する。`poll.ts` の onPositionBoundary）
    await inFlight;
    await engine.quit();
    console.log("[Worker] Shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await tick();
}

/** 本番: server から棋譜と局面評価のジョブを取る */
function createRealRunOnce(
  engine: UsiEngine,
  config: Config,
  isRunning: () => boolean,
): () => Promise<unknown> {
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error("API_KEY is required when USE_MOCK=false");
  const poller = createPoller({
    engine,
    client: createClient(config.serverUrl, apiKey),
    config,
    isRunning,
  });
  console.log("[Worker] Ready, waiting for jobs...");
  return () => poller.runOnce();
}

/** mock（`USE_MOCK=true`）: server に繋がず、固定の局面を読んでログに出すだけ（Docker 外での動作確認用） */
function createMockRunOnce(engine: UsiEngine): () => Promise<unknown> {
  const taskSource: TaskSource = new MockTaskSource();
  return async () => {
    const task = await taskSource.fetchPending();
    if (!task) return;
    console.log(`[Worker] Analyzing task: ${task.id}`);
    const result = await analyzeTask(engine, task);
    await taskSource.submitResult(result);
  };
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
