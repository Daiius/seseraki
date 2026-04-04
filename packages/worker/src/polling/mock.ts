import type { AnalysisResult, AnalysisTask, TaskSource } from "./types.js";

const MOCK_TASKS: AnalysisTask[] = [
  {
    id: "mock-1",
    position: "startpos",
    depth: 5,
  },
  {
    id: "mock-2",
    // A common opening position after 7六歩 3四歩
    position: "startpos moves 7g7f 3c3d",
    depth: 8,
  },
  {
    id: "mock-3",
    // Mid-game position in SFEN
    position:
      "sfen lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 3",
    depth: 10,
  },
];

export class MockTaskSource implements TaskSource {
  private queue: AnalysisTask[];

  constructor() {
    this.queue = [...MOCK_TASKS];
  }

  async fetchPending(): Promise<AnalysisTask | null> {
    const task = this.queue.shift() ?? null;
    if (task) {
      console.log(`[Mock] Fetched task: ${task.id} (${task.position})`);
    } else {
      console.log("[Mock] No pending tasks");
    }
    return task;
  }

  async submitResult(result: AnalysisResult): Promise<void> {
    console.log("[Mock] Analysis result:", {
      taskId: result.taskId,
      bestmove: result.bestmove,
      score: result.score,
      pv: result.pv.join(" "),
      depth: result.depth,
    });
  }
}
