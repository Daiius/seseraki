/**
 * 棋譜解析オーケストレーション
 *
 * USI 指し手列を受け取り、一手ごとに MultiPV で解析して
 * 各局面の候補手・評価値・読み筋を記録する
 */
import type { UsiEngine } from "./usi/engine.js";
import type { UsiInfo, UsiScore } from "./usi/types.js";

/** `analyzeKifu` が使うエンジンの範囲（テストからスタブを差し込めるよう最小限に絞る） */
export type AnalysisEngine = Pick<UsiEngine, "setOption" | "analyze">;

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
  /** エンジンの候補手リスト (MultiPV) */
  candidates: CandidateMove[];
}

/** 棋譜 1 局の解析を終えたときのサマリ（局面ごとの結果はチャンクとして `onChunk` に渡す） */
export interface KifuAnalysisSummary {
  /** 棋譜の指し手数 */
  totalMoves: number;
  /** この実行で解析した局面数（再開時は残りの分だけ） */
  analyzed: number;
}

/**
 * チャンク submit の失敗（インフラ起因の一時失敗）。
 * `onChunk` がこれを投げると解析は中断され、次の poll で続きから再開する（prd/05 §1.1a）。
 */
export class ChunkSubmitError extends Error {
  constructor(cause: unknown) {
    super(
      `Failed to submit analysis chunk: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "ChunkSubmitError";
  }
}

/**
 * チャンクを区切る経過時間（前回 submit からの ms）。
 *
 * **局面数ではなく時間で切る**: 抑えたいのは「失敗時に失われる計算時間」なので、時間で切れば
 * 失う上限がここに固定され、開発 MATERIAL でも本番 NNUE depth20 でも同じ保証になる
 * （固定局面数だと同じ N で失う量が桁違いになる。prd/05 §1.1c）。
 */
export const CHUNK_INTERVAL_MS = 30_000;

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
 * 棋譜を一手ずつ解析し、結果を**チャンクに分けて `onChunk` へ渡す**
 *
 * 全局面を貯めて最後に 1 回送ると、そこで落ちたときに数十分の計算が丸ごと消える。
 * 経過時間で区切って送り、途中まで入った棋譜は `startMoveNumber` から再開する（prd/05 §1.1c）。
 *
 * @param engine - 起動済みの USI エンジン
 * @param usiMoves - USI 形式の指し手列
 * @param options.depth - 解析深さ (default: 10)
 * @param options.multiPv - 候補手数 (default: 3)
 * @param options.byoyomi - 秒読み(ms)。設定時は depth より優先
 * @param options.startMoveNumber - 解析を始める局面番号（既に server に入っている件数。default: 0）
 * @param options.chunkIntervalMs - チャンクを区切る経過時間 (default: {@link CHUNK_INTERVAL_MS})
 * @param options.onProgress - 1 局面解析するたびに呼ばれる (解析済み局面数, 全局面数)
 * @param options.onChunk - チャンクの送信。**完了を待ち**、投げれば解析を中断する
 *   （進捗報告と違い、握りつぶすと `moveNumber` に穴が空いて再開位置が決まらなくなる）
 */
export async function analyzeKifu(
  engine: AnalysisEngine,
  usiMoves: string[],
  options: {
    depth?: number;
    multiPv?: number;
    byoyomi?: number;
    startMoveNumber?: number;
    chunkIntervalMs?: number;
    onProgress?: (analyzed: number, total: number) => void;
    onChunk?: (analyses: MoveAnalysis[]) => Promise<void>;
  } = {},
): Promise<KifuAnalysisSummary> {
  const {
    depth = 10,
    multiPv = 3,
    byoyomi,
    startMoveNumber = 0,
    chunkIntervalMs = CHUNK_INTERVAL_MS,
    onProgress,
    onChunk,
  } = options;
  const goCommand = byoyomi
    ? `go btime 0 wtime 0 byoyomi ${byoyomi}`
    : `go depth ${depth}`;

  const total = usiMoves.length + 1;
  // 既に入っている局面は飛ばす（チャンク submit 中断からの再開）。範囲外の値でも走り抜けないよう挟む
  const start = Math.min(Math.max(startMoveNumber, 0), total);
  if (start > 0) {
    console.log(`[Analysis] Resuming from ${start}/${usiMoves.length}`);
  }

  // 未送信のチャンク
  let pending: MoveAnalysis[] = [];
  let lastChunkAt = Date.now();
  let analyzed = 0;

  // MultiPV 設定
  engine.setOption("MultiPV", String(multiPv));

  // 各局面を解析（初期局面 + 各手の後の局面）
  for (let i = start; i <= usiMoves.length; i++) {
    const movesPlayed = usiMoves.slice(0, i);
    const position =
      movesPlayed.length === 0
        ? "position startpos"
        : `position startpos moves ${movesPlayed.join(" ")}`;

    const t0 = Date.now();
    let result;
    try {
      result = await engine.analyze(position, goCommand);
    } catch (err) {
      console.error(
        `[Analysis] ${i}/${usiMoves.length} Engine error at position: ${position}`,
      );
      throw err;
    }
    const elapsed = Date.now() - t0;
    const candidates = extractMultiPvResults(result.infoLines);
    const isBook = candidates.length > 0 && candidates[0].depth === 0;

    console.log(
      `[Analysis] ${i}/${usiMoves.length} ${elapsed}ms ${isBook ? "BOOK" : `d${candidates[0]?.depth ?? 0}`} ${candidates.length}candidates`,
    );

    pending.push({
      moveNumber: i,
      candidates,
    });
    analyzed++;

    // 進捗は**毎局面**報告する。N 局面ごとにすると N の適正値が 1 局面あたりの所要時間
    // （MATERIAL/NNUE・depth/byoyomi で桁が変わる）に依存し、固定値の根拠が置けない
    onProgress?.(i + 1, total);

    if (Date.now() - lastChunkAt >= chunkIntervalMs) {
      await onChunk?.(pending);
      pending = [];
      lastChunkAt = Date.now();
    }
  }

  // MultiPV を 1 に戻す
  engine.setOption("MultiPV", "1");

  // 最終チャンクは**空でも送る**。完了は server が件数で判定するため、送らないと
  // 「全局面が揃っているのに未完了」の棋譜が残り、次の poll で拾い直し続ける
  // （再開位置が既に全局面に達しているケース）
  await onChunk?.(pending);

  return {
    totalMoves: usiMoves.length,
    analyzed,
  };
}
