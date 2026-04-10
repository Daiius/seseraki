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

  // 3. 棋譜を解析
  console.log(`\n--- Step 3: Analyze kifu #${kifu.id}: "${kifu.title}" ---`);
  console.log(`Moves: ${kifu.usiMoves.length}`);

  const result = await analyzeKifu(engine, kifu.usiMoves, {
    depth: 5,
    multiPv: 3,
  });

  console.log(`\nAnalysis complete: ${result.totalMoves} moves`);

  // 結果サマリー
  for (const a of result.analyses.slice(0, 3)) {
    const top = a.candidates[0];
    if (top) {
      const scoreStr =
        top.score.type === "mate"
          ? `mate ${top.score.value}`
          : `${top.score.value}cp`;
      const played = kifu.usiMoves[a.moveNumber];
      console.log(
        `  [${a.moveNumber}] played=${played ?? "(end)"} best=${top.move} (${scoreStr})`,
      );
    }
  }
  if (result.analyses.length > 3) {
    console.log(`  ... (${result.analyses.length - 3} more)`);
  }

  // 4. 結果をサーバーに送信
  console.log("\n--- Step 4: Submit analysis to server ---");
  const submitResult = await client.submitAnalysis(kifu.id, result);
  console.log("Server response:", submitResult);

  // 5. エンジン終了
  await engine.quit();

  console.log("\n=== E2E Test Complete ===");
}

main().catch((err) => {
  console.error("E2E TEST FAILED:", err);
  process.exit(1);
});
