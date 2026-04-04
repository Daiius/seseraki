/**
 * 棋譜解析オーケストレーション
 *
 * KIF テキストをパースし、一手ごとに MultiPV で解析して
 * 各局面の候補手・評価値・読み筋を記録する
 */
import type { UsiEngine } from "./usi/engine.js";
import type { UsiInfo, UsiScore } from "./usi/types.js";
import { parseKif } from "./kif/parser.js";

/** 一局面での候補手 */
export interface CandidateMove {
  rank: number;
  move: string;
  score: UsiScore;
  pv: string[];
  depth: number;
}

/** 一手分の解析結果 */
export interface MoveAnalysis {
  /** 手数 (1 = 初手の前の局面を解析) */
  moveNumber: number;
  /** 実際に指された手 (USI) — 最終局面では undefined */
  movePlayed?: string;
  /** エンジンの候補手リスト (MultiPV) */
  candidates: CandidateMove[];
}

/** 棋譜全体の解析結果 */
export interface KifuAnalysisResult {
  totalMoves: number;
  analyses: MoveAnalysis[];
  parseErrors: { line: number; text: string; reason: string }[];
}

/**
 * MultiPV の info 行群から各 PV の最終結果を抽出する
 * (同じ multipv 番号の最後の info を採用)
 */
function extractMultiPvResults(infoLines: UsiInfo[]): CandidateMove[] {
  const best = new Map<number, UsiInfo>();

  for (const info of infoLines) {
    const pvNum = info.multipv ?? 1;
    // 同じ PV 番号は後のもので上書き（より深い結果）
    best.set(pvNum, info);
  }

  return Array.from(best.entries())
    .sort(([a], [b]) => a - b)
    .map(([rank, info]) => ({
      rank,
      move: info.pv?.[0] ?? "",
      score: info.score ?? { type: "cp" as const, value: 0 },
      pv: info.pv ?? [],
      depth: info.depth ?? 0,
    }));
}

/**
 * 棋譜を一手ずつ解析する
 *
 * @param engine - 起動済みの USI エンジン
 * @param kifText - KIF 形式の棋譜テキスト
 * @param options.depth - 解析深さ (default: 10)
 * @param options.multiPv - 候補手数 (default: 3)
 */
export async function analyzeKifu(
  engine: UsiEngine,
  kifText: string,
  options: { depth?: number; multiPv?: number } = {},
): Promise<KifuAnalysisResult> {
  const { depth = 10, multiPv = 3 } = options;

  const parsed = parseKif(kifText);
  if (parsed.errors.length > 0) {
    console.warn("[Analysis] KIF parse errors:", parsed.errors);
  }

  const usiMoves = parsed.moves.map((m) => m.usi);
  const analyses: MoveAnalysis[] = [];

  // MultiPV 設定
  engine.setOption("MultiPV", String(multiPv));

  // 各局面を解析（初期局面 + 各手の後の局面）
  for (let i = 0; i <= usiMoves.length; i++) {
    const movesPlayed = usiMoves.slice(0, i);
    const position =
      movesPlayed.length === 0
        ? "position startpos"
        : `position startpos moves ${movesPlayed.join(" ")}`;

    console.log(
      `[Analysis] Analyzing position ${i}/${usiMoves.length}...`,
    );

    const result = await engine.analyze(position, `go depth ${depth}`);
    const candidates = extractMultiPvResults(result.infoLines);

    analyses.push({
      moveNumber: i,
      movePlayed: usiMoves[i], // undefined for last position
      candidates,
    });
  }

  // MultiPV を 1 に戻す
  engine.setOption("MultiPV", "1");

  return {
    totalMoves: usiMoves.length,
    analyses,
    parseErrors: parsed.errors,
  };
}
