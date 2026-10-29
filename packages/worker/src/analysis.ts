import type { UsiEngine } from "./usi/engine.js";
import type { AnalysisResult, AnalysisTask } from "./polling/types.js";

export async function analyzeTask(
  engine: UsiEngine,
  task: AnalysisTask,
): Promise<AnalysisResult> {
  // `task.position` は `startpos …` / `sfen …`（USI の position の引数）
  const result = await engine.analyze(`position ${task.position}`, `go depth ${task.depth}`);

  return {
    taskId: task.id,
    bestmove: result.bestmove.move,
    score: result.lastInfo.score ?? { type: "cp", value: 0 },
    pv: result.lastInfo.pv ?? [],
    depth: result.lastInfo.depth ?? task.depth,
  };
}
