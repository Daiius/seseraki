/**
 * 棋譜解析テスト
 *
 * サンプル USI 指し手列を解析して結果を表示する
 *
 * 使い方:
 *   DOCKER_IMAGE=yaneuraou-material pnpm --filter worker test:analysis
 *   # または
 *   ENGINE_PATH=../../engines/out/yaneuraou pnpm --filter worker test:analysis
 */
import { UsiEngine } from "./usi/engine.js";
import { analyzeKifu, type MoveAnalysis } from "./kifu-analysis.js";

// サンプル指し手列（相掛かり序盤）
const SAMPLE_USI_MOVES = [
  "7g7f", "3c3d", "2g2f", "8c8d", "2f2e", "8d8e",
  "6i7h", "4a3b", "2e2d", "2c2d", "2h2d", "P*2c", "2d2f",
];

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

function formatAnalysis(a: MoveAnalysis, usiMoves: string[]): string {
  const lines: string[] = [];
  const played = usiMoves[a.moveNumber];
  const header = played
    ? `[${a.moveNumber}] 指し手: ${played}`
    : `[${a.moveNumber}] (最終局面)`;
  lines.push(header);

  for (const c of a.candidates) {
    const scoreStr =
      c.score.type === "mate"
        ? `mate ${c.score.value}`
        : `${c.score.value}cp`;
    lines.push(
      `  ${c.rank}位: ${c.move} (${scoreStr}, depth ${c.depth}) PV: ${c.pv.join(" ")}`,
    );
  }

  return lines.join("\n");
}

async function main() {
  console.log("=== Kifu Analysis Test ===\n");

  const engine = createEngine();
  await engine.start();
  engine.setOption("Threads", "1");
  await engine.ready();

  // depth 5, MultiPV 3 で解析（MATERIAL版なのでスコアは簡易的）
  const result = await analyzeKifu(engine, SAMPLE_USI_MOVES, {
    depth: 5,
    multiPv: 3,
  });

  console.log("\n=== Analysis Results ===\n");
  console.log(`Total moves: ${result.totalMoves}\n`);

  for (const a of result.analyses) {
    console.log(formatAnalysis(a, SAMPLE_USI_MOVES));
    console.log();
  }

  await engine.quit();
  console.log("=== Done ===");
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
