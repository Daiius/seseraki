/**
 * 検討盤の局面評価（prd/12 §2.2・§2.4）を、ブラウザのエンジンで読むための純関数。
 *
 * 担当 `browser` の利用者の検討盤は、server の評価の口（手元 worker にジョブを積む）を使わず、このブラウザの
 * エンジンで `position sfen …` → `go movetime <ms>` を **MultiPV 3** で読む。結果は画面に出すだけで、server には送らない。
 * 送り先が無いので、ここは USI の出力から候補手を取り出して画面の形にそろえるだけ。
 */
import { toBrowserReportCandidate } from './browser-analysis';
import { extractMultiPvResults } from './kifu-analysis';
import type { UsiSearchResult } from './types';

/** USI の MultiPV の既定値。`setoption` を送っていないエンジンはこの値で動いている */
const USI_DEFAULT_MULTI_PV = '1';

/**
 * MultiPV を一時的に `multiPv` にして `run` を実行し、**終わったら元の値へ戻す**（投げても戻す）。
 *
 * 🔴 **局面評価は MultiPV を自分で設定してから探索する**（prd/12 §2.2）。全局面解析は MultiPV 1 で回るので、
 * エンジンの設定に乗るだけでは候補手が 1 本になる。戻すので、割り込まれた全局面解析の候補手数は変わらない
 * 手元 worker の局面評価（`position-eval.ts`）とブラウザで共用。
 * 元の値はエンジンが覚えている値（`getOption` が無い・覚えていなければ USI の既定の 1）。同じ値なら `setoption` を送らない。
 */
export async function withMultiPv<T>(
  engine: { setOption(name: string, value: string): void; getOption?(name: string): string | undefined },
  multiPv: number,
  run: () => Promise<T>,
): Promise<T> {
  const desired = String(multiPv);
  const previous = engine.getOption?.('MultiPV') ?? USI_DEFAULT_MULTI_PV;
  if (previous === desired) return run();
  engine.setOption('MultiPV', desired);
  try {
    return await run();
  } finally {
    try {
      engine.setOption('MultiPV', previous);
    } catch {
      // エンジンが死んでいる（送信が投げる）。読みの失敗のほうを伝える——死んだエンジンは呼び出し側が作り直す
    }
  }
}

/** 局面評価の `go`（思考時間で止める） */
export function positionGoCommand(movetimeMs: number): string {
  return `go movetime ${movetimeMs}`;
}

/** 局面評価の候補手 1 本（画面の形。server の局面評価の応答の `candidates` と同じ並び）。評価値は手番側から見た値 */
export interface PositionCandidate {
  rank: number;
  move: string;
  scoreType: 'cp' | 'mate';
  scoreValue: number;
  depth: number;
  pv: string[];
}

/**
 * 探索の結果から、候補手を rank 順に取り出す。
 *
 * - 🔒 **`multiPv` を超える rank は捨てる**（定跡の列挙の残骸。issue #67。手元 worker と同じ `extractMultiPvResults`）
 * - 読み筋は受けられる語が続く先頭だけを `pvMaxPlies` で切り、評価値と深さは上限に収める（全局面解析の報告と同じ
 *   `toBrowserReportCandidate`）。評価値・深さが数として読めない候補は出さない（数字を作らない）
 * - 読み筋が空（詰まされている局面など）の候補も出す（手は空文字。手元 worker と同じ）
 */
export function positionCandidatesOf(
  result: UsiSearchResult,
  multiPv: number,
  pvMaxPlies?: number,
): PositionCandidate[] {
  const candidates: PositionCandidate[] = [];
  for (const candidate of extractMultiPvResults(result.infoLines, { multiPv })) {
    const report = toBrowserReportCandidate(candidate, pvMaxPlies);
    if (!report) continue;
    candidates.push({
      rank: candidate.rank,
      move: report.move,
      scoreType: report.scoreType,
      scoreValue: report.scoreValue,
      depth: report.depth,
      pv: report.pv ?? [],
    });
  }
  return candidates;
}
