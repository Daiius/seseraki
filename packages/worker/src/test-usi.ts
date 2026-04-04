/**
 * USI プロトコル通信テスト
 *
 * 使い方:
 *   # A) バイナリ直接実行
 *   docker build --build-arg TARGET_CPU=OTHER --output type=local,dest=./engines/out ./engines
 *   ENGINE_PATH=../../engines/out/yaneuraou pnpm --filter worker test:usi
 *
 *   # B) Docker 経由（旧方式、DOCKER_IMAGE が必要）
 *   DOCKER_IMAGE=yaneuraou-material pnpm --filter worker test:usi
 */
import { UsiEngine } from "./usi/engine.js";

function createEngine(): UsiEngine {
  const enginePath = process.env.ENGINE_PATH;
  if (enginePath) {
    console.log(`Using local binary: ${enginePath}\n`);
    return new UsiEngine(enginePath);
  }

  const image = process.env.DOCKER_IMAGE ?? "yaneuraou-material";
  console.log(`Using Docker image: ${image}\n`);
  return new UsiEngine("docker", ["run", "-i", "--rm", image]);
}

async function main() {
  console.log("=== USI Protocol Communication Test ===\n");

  const engine = createEngine();

  // 1. USI ハンドシェイク
  console.log("--- Step 1: USI handshake ---");
  await engine.start();
  console.log("OK: usiok received\n");

  // 2. エンジン準備
  console.log("--- Step 2: isready/readyok ---");
  engine.setOption("Threads", "1");
  await engine.ready();
  console.log("OK: readyok received\n");

  // 3. 初期局面の解析
  console.log("--- Step 3: Analyze startpos (depth 5) ---");
  const result1 = await engine.analyze(
    "position startpos",
    "go depth 5",
  );
  console.log("bestmove:", result1.bestmove.move);
  console.log("score:", result1.lastInfo.score);
  console.log("PV:", result1.lastInfo.pv?.join(" "));
  console.log();

  // 4. 指し手付き局面の解析
  console.log("--- Step 4: Analyze after 7六歩 3四歩 (depth 8) ---");
  const result2 = await engine.analyze(
    "position startpos moves 7g7f 3c3d",
    "go depth 8",
  );
  console.log("bestmove:", result2.bestmove.move);
  console.log("score:", result2.lastInfo.score);
  console.log("PV:", result2.lastInfo.pv?.join(" "));
  console.log();

  // 5. SFEN 局面の解析
  console.log("--- Step 5: Analyze SFEN position (depth 5) ---");
  const result3 = await engine.analyze(
    "position sfen lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 3",
    "go depth 5",
  );
  console.log("bestmove:", result3.bestmove.move);
  console.log("score:", result3.lastInfo.score);
  console.log("PV:", result3.lastInfo.pv?.join(" "));
  console.log();

  // 6. 終了
  console.log("--- Step 6: Quit ---");
  await engine.quit();
  console.log("OK: Engine exited cleanly");

  console.log("\n=== All tests passed ===");
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
