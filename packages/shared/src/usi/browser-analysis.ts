/**
 * ブラウザの全局面解析（prd/14 §5.2・§5.8）を、解析のループの上に組む純関数。
 *
 * 開始の口の応答（世代・再開位置・指し手列・設定）とエンジンのセッションを受け取り、解析を回して
 * **報告の本文に入れられる形**のチャンクを渡す。送信・Worker・fetch には触れない（呼び出し側が注入する）。
 */
import {
  BROWSER_ANALYSIS_LIMITS,
  isPvToken,
  type BrowserAnalysisChunk,
} from '../analysis-limits';
import {
  analyzeKifu,
  type KifuAnalysisSummary,
  type UsiAnalysisEngine,
  type UsiCandidate,
  type UsiMoveAnalysis,
} from './kifu-analysis';
import type { UsiLog } from './session';

/** 開始の口が返す解析の設定（server の `BROWSER_ANALYSIS_SETTINGS`。prd/14 §5.8） */
export interface BrowserAnalysisSettings {
  /** 1 局面の思考時間（`go movetime`） */
  movetimeMs: number;
  multiPv: number;
  /** 置換表（`USI_Hash`） */
  hashMb: number;
  /**
   * エンジンのスレッド数の上限（段で共通）。ブラウザはエンジンをこの値で作る（変わったら作り直す）
   */
  maxThreads: number;
  /**
   * この段のスレッド数の上限（prd/14 §5.5。2026-10-29 に足した欄。full は 4）。ブラウザは論理コア数とこれの小さいほうを使い、
   * 段の開始で動いているエンジンのスレッド数を合わせる（作り直さない）。
   * 🔒 **任意**: 足す前の server は返さない。無ければ `maxThreads`（{@link stageMaxThreadsOf}）
   */
  stageMaxThreads?: number;
  /** チャンクを送る間隔の目安 */
  chunkIntervalMs: number;
  /** 1 チャンクの局面数の上限 */
  chunkMaxPositions: number;
  /** 読み筋の長さの上限（これで切ってから送る） */
  pvMaxPlies: number;
}

/**
 * その段で使ってよいスレッド数の上限（prd/14 §5.5）。`stageMaxThreads` が無い・読めない（足す前の server）なら `maxThreads`。
 * `maxThreads` を超えない（エンジンの上限）
 */
export function stageMaxThreadsOf(
  settings: Pick<BrowserAnalysisSettings, 'maxThreads' | 'stageMaxThreads'>,
): number {
  const stage = settings.stageMaxThreads;
  if (typeof stage !== 'number' || !Number.isFinite(stage) || stage < 1) {
    return settings.maxThreads;
  }
  return Math.min(settings.maxThreads, Math.floor(stage));
}

/** 開始の口の「解析する」応答（`status: 'run'` のときの中身） */
export interface BrowserAnalysisRun {
  /** この世代で報告する */
  revision: number;
  /** 再開位置（この局面番号から解析する） */
  startMoveNumber: number;
  usiMoves: string[];
  settings: BrowserAnalysisSettings;
}

/** チャンクの報告の `analyses`（`browserAnalysisChunkSchema` が受ける形） */
export type BrowserReportAnalyses = BrowserAnalysisChunk['analyses'];
type BrowserReportCandidate =
  BrowserReportAnalyses[number]['candidates'][number];

const clampInt = (value: number, min: number, max: number) =>
  Math.min(Math.max(Math.trunc(value), min), max);

/**
 * 候補手 1 本を報告の形にする。**server の検証（`browserCandidateSchema`）を通る形に切りそろえる**
 * ——拒否されると、その棋譜の解析が恒久的に失敗して見える（prd/14 §5.8）。
 *
 * - 読み筋は、受けてもらえる語（USI の指し手・`resign` など）が続く**先頭の部分**だけを、上限の長さで切る
 * - 深さと評価値は上限に収める
 * - 評価値・深さが数として読めなかった候補は送らない（null。数字を作らない）
 */
export function toBrowserReportCandidate(
  candidate: UsiCandidate,
  pvMaxPlies: number = BROWSER_ANALYSIS_LIMITS.pvMaxPlies,
): BrowserReportCandidate | null {
  if (
    !Number.isFinite(candidate.score.value) ||
    !Number.isFinite(candidate.depth)
  ) {
    return null;
  }
  const maxPlies = Math.min(pvMaxPlies, BROWSER_ANALYSIS_LIMITS.pvMaxPlies);
  const pv: string[] = [];
  for (const token of candidate.pv) {
    if (pv.length >= maxPlies || !isPvToken(token)) break;
    pv.push(token);
  }
  return {
    rank: 1,
    // 読み筋が空の局面では空文字になる（手元 worker と同じ）
    move: isPvToken(candidate.move) ? candidate.move : '',
    scoreType: candidate.score.type,
    scoreValue: clampInt(
      candidate.score.value,
      -BROWSER_ANALYSIS_LIMITS.maxScoreAbs,
      BROWSER_ANALYSIS_LIMITS.maxScoreAbs,
    ),
    depth: clampInt(candidate.depth, 0, BROWSER_ANALYSIS_LIMITS.maxDepth),
    pv,
  };
}

/**
 * 解析した局面を報告の形にする。候補手は**最善手（rank 1）だけ**を残す
 * （ブラウザの全局面解析は MultiPV 1。探索の結果が無い局面は候補なしのまま送る）。
 */
export function toBrowserReportAnalyses(
  analyses: readonly UsiMoveAnalysis[],
  pvMaxPlies: number = BROWSER_ANALYSIS_LIMITS.pvMaxPlies,
): BrowserReportAnalyses {
  return analyses.map((analysis) => {
    const best = analysis.candidates.find((c) => c.rank === 1);
    const candidate = best ? toBrowserReportCandidate(best, pvMaxPlies) : null;
    return {
      moveNumber: analysis.moveNumber,
      candidates: candidate ? [candidate] : [],
    };
  });
}

/**
 * 開始の口の応答どおりに 1 局を解析し、報告の形のチャンクを `onChunk` に渡す。
 *
 * - 思考時間・候補手数・再開位置・チャンクの区切り（時間と局面数）は `run` の値をそのまま使う
 * - `onChunk` には**空のチャンクを渡さない**（報告の口は 1 局面以上を求める）。完了は、最後の局面を含む
 *   チャンクを server が受けた時点で確定する
 * - `onChunk` が投げれば解析を中断する（`analyzeKifu` と同じ。再開位置は次の開始の口が返す）
 *
 * ⚠ スレッド数・置換表（`settings.maxThreads` / `hashMb`）は**エンジンのオプション**なので、ここでは触らない。
 * 呼び出し側が `setOption` と `ready()` を済ませたセッションを渡す。
 */
export function analyzeKifuForBrowser(
  engine: UsiAnalysisEngine,
  run: BrowserAnalysisRun,
  options: {
    onChunk: (analyses: BrowserReportAnalyses) => Promise<void>;
    onProgress?: (analyzed: number, total: number) => void;
    /** `true` を返すと、未送信のチャンクを送ってから中断する（タブが解析の権利を手放すときなど） */
    onPositionBoundary?: () => Promise<boolean | void>;
    log?: UsiLog;
  },
): Promise<KifuAnalysisSummary> {
  const { settings } = run;
  return analyzeKifu(engine, run.usiMoves, {
    multiPv: settings.multiPv,
    movetime: settings.movetimeMs,
    startMoveNumber: run.startMoveNumber,
    chunkIntervalMs: settings.chunkIntervalMs,
    chunkMaxPositions: settings.chunkMaxPositions,
    onProgress: options.onProgress,
    onPositionBoundary: options.onPositionBoundary,
    log: options.log,
    onChunk: async (analyses) => {
      if (analyses.length === 0) return;
      await options.onChunk(
        toBrowserReportAnalyses(analyses, settings.pvMaxPlies),
      );
    },
  });
}
