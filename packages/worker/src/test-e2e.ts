/**
 * E2E テスト: サーバーから棋譜取得 → エンジン解析 → 結果送信
 *
 * 前提:
 *   - サーバーが起動済み (pnpm --filter server dev)
 *   - DB にテスト棋譜が登録済み
 *   - Docker イメージ or エンジンバイナリが利用可能
 *
 * 使い方:
 *   SERVER_URL=http://localhost:4000 API_KEY=test-key \
 *     DOCKER_IMAGE=yaneuraou-material pnpm --filter worker test:e2e
 */
import { UsiEngine } from "./usi/engine.js";
import { analyzeKifu } from "./kifu-analysis.js";
import { createClient } from "./polling/client.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4000";
const API_KEY = process.env.API_KEY ?? "test-key";

function createEngine(): UsiEngine {
  const enginePath = process.env.ENGINE_PATH;
  if (enginePath) {
    console.log(`Using local binary: ${enginePath}`);
    return new UsiEngine(enginePath);
  }
  const image = process.env.DOCKER_IMAGE ?? "yaneuraou-material";
  console.log(`Using Docker image: ${image}`);
  return new UsiEngine("docker", ["run", "-i", "--rm", image]);
}

async function main() {
  console.log("=== E2E Analysis Test ===\n");
  console.log(`Server: ${SERVER_URL}`);

  const client = createClient(SERVER_URL, API_KEY);

  // 1. 未解析の棋譜を取得
  console.log("\n--- Step 1: Fetch next unanalyzed kifu ---");
  const kifu = await client.fetchNextKifu();

  if (!kifu) {
    console.log("No kifus to analyze. Register a kifu first.");
    return;
  }
  console.log(`Found kifu #${kifu.id}: "${kifu.title}"`);

  if (!kifu.usiMoves) {
    console.log("Kifu has no usiMoves, skipping.");
    return;
  }

  // 2. エンジン起動
  console.log("\n--- Step 2: Start engine ---");
  const engine = createEngine();
  await engine.start();
  engine.setOption("Threads", "1");
  await engine.ready();

  // 3. 棋譜を解析し、チャンクごとにサーバーへ送信（本番と同じ経路）
  console.log(`\n--- Step 3: Analyze kifu #${kifu.id}: "${kifu.title}" ---`);
  console.log(`Moves: ${kifu.usiMoves.length}`);
  console.log(`Resuming from position ${kifu.analyzedCount}`);

  const usiMoves = kifu.usiMoves;
  const result = await analyzeKifu(engine, usiMoves, {
    depth: 5,
    multiPv: 3,
    startMoveNumber: kifu.analyzedCount,
    // 短時間で終わるサンプルでもチャンクが複数回に分かれるよう短めにする
    chunkIntervalMs: 1000,
    onChunk: async (chunk) => {
      for (const a of chunk.slice(0, 3)) {
        const top = a.candidates[0];
        if (!top) continue;
        const scoreStr =
          top.score.type === "mate"
            ? `mate ${top.score.value}`
            : `${top.score.value}cp`;
        const played = usiMoves[a.moveNumber];
        console.log(
          `  [${a.moveNumber}] played=${played ?? "(end)"} best=${top.move} (${scoreStr})`,
        );
      }
      const submitResult = await client.submitAnalysis(
        kifu.id,
        kifu.analysisRevision,
        chunk,
      );
      console.log(
        `  submitted ${chunk.length} positions ->`,
        submitResult,
      );
    },
  });

  console.log(
    `\nAnalysis complete: ${result.totalMoves} moves (${result.analyzed} positions analyzed)`,
  );

  // 4. エンジン終了
  await engine.quit();

  console.log("\n=== E2E Test Complete ===");
}

main().catch((err) => {
  console.error("E2E TEST FAILED:", err);
  process.exit(1);
});
