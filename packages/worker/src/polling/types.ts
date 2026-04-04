export interface AnalysisTask {
  id: string;
  /** USI position string, e.g. "startpos" or "sfen ..." */
  position: string;
  depth: number;
}

export interface AnalysisResult {
  taskId: string;
  bestmove: string;
  score: { type: "cp" | "mate"; value: number };
  pv: string[];
  depth: number;
}

export interface TaskSource {
  fetchPending(): Promise<AnalysisTask | null>;
  submitResult(result: AnalysisResult): Promise<void>;
}
