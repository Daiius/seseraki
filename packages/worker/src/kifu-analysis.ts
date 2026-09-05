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
  /**
   * この実行で観測した `hashfull`（置換表の使用率・パーミル）の最大値。
   * エンジンが報告しなかった場合は `undefined`。
   */
  maxHashfull?: number;
  /**
   * 局面境界で**中断**したか（quick 待ちの棋譜に割り込まれた。prd/05 §1.1d）。
   *
   * 🔒 **中断は失敗ではない。** 呼び出し側は `analysisError` を立てず、エンジンも再起動せず、
   * そのまま次の poll へ進む（quick が先に拾われ、full は後で続きから再開する。
   * 再開位置は server 側の行数で決まるので追加の状態は要らない）。
   * 未送信のチャンクは**中断の前に送る**ので `moveNumber` に穴は空かない。
   */
  interrupted: boolean;
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
 * 失う量がエンジン速度によらずこの値の目安に収まり、開発 MATERIAL でも本番 NNUE depth20 でも
 * 同じ感覚で決められる（固定局面数だと同じ N で失う量が桁違いになる。prd/05 §1.1c）。
 *
 * ⚠ 境界の判定は**1 局面を解析し終えた後**にしか来ないので、失う計算時間の上限は厳密には
 * 「この値 + 実行中だった 1 局面分」になる。1 局面が数分かかる depth では上振れが効いてくる。
 * 局面の途中で打ち切る仕組みは持たない（エンジンの探索を中断して部分結果を採るのは別の話）。
 */
export const CHUNK_INTERVAL_MS = 30_000;

/**
 * `go` コマンドを組み立てる。
 *
 * 時間で区切るときは byoyomi ではなく movetime を使う。byoyomi は対局用の指定で、
 * やねうら王が NetworkDelay2（既定 1120ms）を引くため指定値どおりの思考時間にならない。
 * movetime は「時間固定モード」として扱われ、指定値がそのまま思考時間になる。
 *
 * 🔒 検討局面の評価も**同じパラメータ**を使う（prd/12 §2.1）ので、ここに 1 本化する。
 */
export function buildGoCommand(options: {
  depth?: number;
  movetime?: number;
}): string {
  const { depth = 10, movetime } = options;
  return movetime ? `go movetime ${movetime}` : `go depth ${depth}`;
}

/**
 * 同じ multipv 番号について、後から来た info 行で上書きしてよいかを判定する。
 *
 * 基本は「後の行ほど深い結果」なので上書きしてよい。ただし byoyomi で探索を打ち切ると
 * **最後の行が探索途中の暫定値**になることがあり、そのまま採ると直前に出ていた完全な
 * 読み筋を捨てて pv が 1〜2 手しかない候補手を保存してしまう。
 *
 * - fail low/high の行（lowerbound/upperbound）: score は上限/下限でしかなく、pv も
 *   再探索前の途中経過。確定した行が既にあるならそちらを残す。
 * - pv を持たない行: 読み筋として使えないので確定した行を残す。
 *
 * なお bound が付かないまま pv が途中で切れる経路（打ち切り時に最善手が入れ替わり、
 * 新しい手の pv がまだ埋まっていない）はここでは判別できない。そちらは
 * `ConsiderationMode` で pv を置換表から延長させて対処する（index.ts の configureEngine）。
 */
function shouldReplace(next: UsiInfo, prev: UsiInfo): boolean {
  if (!next.pv?.length) return false;
  if (next.bound && !prev.bound) return false;
  return true;
}

/**
 * MultiPV の info 行群から各 PV の最終結果を抽出する
 * (同じ multipv 番号の最後の info を採用。ただし暫定値への後退は採らない)
 *
 * 検討局面の評価（`position-eval.ts`）も同じ抽出を使う。
 */
export function extractMultiPvResults(infoLines: UsiInfo[]): CandidateMove[] {
  const best = new Map<number, UsiInfo>();

  for (const info of infoLines) {
    const pvNum = info.multipv ?? 1;
    // 同じ PV 番号は後のもので上書き（より深い結果）
    const prev = best.get(pvNum);
    if (prev && !shouldReplace(info, prev)) continue;
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
 * info 行群から `hashfull`（置換表の使用率・パーミル）の最大値を取る
 *
 * 最終行に必ず載るとは限らないので、全 info 行の最大値を採る。
 */
function extractHashfull(infoLines: UsiInfo[]): number | undefined {
  let max: number | undefined;
  for (const info of infoLines) {
    if (info.hashfull === undefined || Number.isNaN(info.hashfull)) continue;
    if (max === undefined || info.hashfull > max) max = info.hashfull;
  }
  return max;
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
 * @param options.movetime - 1 局面あたりの思考時間(ms)。設定時は depth より優先
 * @param options.startMoveNumber - 解析を始める局面番号（既に server に入っている件数。default: 0）
 * @param options.chunkIntervalMs - チャンクを区切る経過時間 (default: {@link CHUNK_INTERVAL_MS})
 * @param options.onProgress - 1 局面解析するたびに呼ばれる (解析済み局面数, 全局面数)
 * @param options.onChunk - チャンクの送信。**完了を待ち**、投げれば解析を中断する
 *   （進捗報告と違い、握りつぶすと `moveNumber` に穴が空いて再開位置が決まらなくなる）
 * @param options.onPositionBoundary - **1 局面を解析する前**に呼ばれる割り込み点
 *   （検討局面の評価を差し込む場所。prd/12 §2.1）。投げれば解析を中断する。
 *   **`true` を返すと、未送信チャンクを送ってから解析を中断する**（quick 待ちの棋譜への
 *   割り込み。prd/05 §1.1d）——例外にしないのは、これが**失敗ではない**からで、
 *   呼び出し側で失敗経路と取り違えようがない形にしておく
 */
export async function analyzeKifu(
  engine: AnalysisEngine,
  usiMoves: string[],
  options: {
    depth?: number;
    multiPv?: number;
    movetime?: number;
    startMoveNumber?: number;
    chunkIntervalMs?: number;
    onProgress?: (analyzed: number, total: number) => void;
    onChunk?: (analyses: MoveAnalysis[]) => Promise<void>;
    onPositionBoundary?: () => Promise<boolean | void>;
  } = {},
): Promise<KifuAnalysisSummary> {
  const {
    depth = 10,
    multiPv = 3,
    movetime,
    startMoveNumber = 0,
    chunkIntervalMs = CHUNK_INTERVAL_MS,
    onProgress,
    onChunk,
    onPositionBoundary,
  } = options;
  const goCommand = buildGoCommand({ depth, movetime });

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
  // 置換表は局面をまたいで残る（usinewgame も Clear Hash も送らない）ため、hashfull は
  // 1 局を通して積み上がる。1 局面ぶんではなく**この実行の最大値**が USI_Hash の判断材料になる
  let maxHashfull: number | undefined;

  // MultiPV 設定
  engine.setOption("MultiPV", String(multiPv));

  // 各局面を解析（初期局面 + 各手の後の局面）
  for (let i = start; i <= usiMoves.length; i++) {
    // 局面の境目が自然な割り込み点。ここで検討局面の評価を先に処理する（prd/12 §2.1）。
    // USI は毎回 `position` で局面を明示するので、割り込んでもエンジンの状態は汚れない
    const interrupt = (await onPositionBoundary?.()) === true;
    if (interrupt) {
      // 🔴 **未送信のチャンクを送ってから抜ける**（prd/05 §1.1d）。捨てると計算が失われるうえ、
      // 送らないまま次の poll で再開すると **moveNumber に穴が空いて再開位置が決まらなくなる**
      if (pending.length > 0) {
        await onChunk?.(pending);
        pending = [];
      }
      // 割り込み先（局面評価）は自分で MultiPV を設定するが、通常終了と同じ後始末をしておく
      engine.setOption("MultiPV", "1");
      console.log(
        `[Analysis] Interrupted at ${i}/${usiMoves.length} (quick pending)`,
      );
      return { totalMoves: usiMoves.length, analyzed, maxHashfull, interrupted: true };
    }

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
    const hashfull = extractHashfull(result.infoLines);
    if (hashfull !== undefined && (maxHashfull === undefined || hashfull > maxHashfull)) {
      maxHashfull = hashfull;
    }

    console.log(
      `[Analysis] ${i}/${usiMoves.length} ${elapsed}ms ${isBook ? "BOOK" : `d${candidates[0]?.depth ?? 0}`} ${candidates.length}candidates${hashfull !== undefined ? ` hashfull ${hashfull}‰` : ""}`,
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
    maxHashfull,
    interrupted: false,
  };
}
