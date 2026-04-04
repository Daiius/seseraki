/**
 * 棋譜解析テスト
 *
 * サンプル KIF を解析して結果を表示する
 *
 * 使い方:
 *   DOCKER_IMAGE=yaneuraou-material pnpm --filter worker test:analysis
 *   # または
 *   ENGINE_PATH=../../engines/out/yaneuraou pnpm --filter worker test:analysis
 */
import { UsiEngine } from "./usi/engine.js";
import { analyzeKifu, type MoveAnalysis } from "./kifu-analysis.js";

// サンプル棋譜（相掛かり序盤）
const SAMPLE_KIF = `
手合割：平手
先手：先手
後手：後手
手数----指手---------消費時間--
   1 ７六歩(77)   ( 0:00/00:00:00)
   2 ３四歩(33)   ( 0:00/00:00:00)
   3 ２六歩(27)   ( 0:00/00:00:00)
   4 ８四歩(83)   ( 0:00/00:00:00)
   5 ２五歩(26)   ( 0:00/00:00:00)
   6 ８五歩(84)   ( 0:00/00:00:00)
   7 ７八金(69)   ( 0:00/00:00:00)
   8 ３二金(41)   ( 0:00/00:00:00)
   9 ２四歩(25)   ( 0:00/00:00:00)
  10 同　歩(23)   ( 0:00/00:00:00)
  11 同　飛(28)   ( 0:00/00:00:00)
  12 ２三歩打     ( 0:00/00:00:00)
  13 ２六飛(24)   ( 0:00/00:00:00)
`;

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

function formatAnalysis(a: MoveAnalysis): string {
  const lines: string[] = [];
  const header = a.movePlayed
    ? `[${a.moveNumber}] 指し手: ${a.movePlayed}`
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
  const result = await analyzeKifu(engine, SAMPLE_KIF, {
    depth: 5,
    multiPv: 3,
  });

  console.log("\n=== Analysis Results ===\n");
  console.log(`Total moves: ${result.totalMoves}`);
  console.log(`Parse errors: ${result.parseErrors.length}\n`);

  for (const a of result.analyses) {
    console.log(formatAnalysis(a));
    console.log();
  }

  await engine.quit();
  console.log("=== Done ===");
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
