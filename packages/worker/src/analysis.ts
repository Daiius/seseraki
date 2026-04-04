import type { UsiEngine } from "./usi/engine.js";
import type { AnalysisResult, AnalysisTask } from "./polling/types.js";

export async function analyzeTask(
  engine: UsiEngine,
  task: AnalysisTask,
): Promise<AnalysisResult> {
  const position =
    task.position.startsWith("sfen") || task.position === "startpos"
      ? `position ${task.position}`
      : `position ${task.position}`;

  const result = await engine.analyze(position, `go depth ${task.depth}`);

  return {
    taskId: task.id,
    bestmove: result.bestmove.move,
    score: result.lastInfo.score ?? { type: "cp", value: 0 },
    pv: result.lastInfo.pv ?? [],
    depth: result.lastInfo.depth ?? task.depth,
  };
}
