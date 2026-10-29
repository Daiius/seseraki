/**
 * 棋譜解析オーケストレーション
 *
 * USI 指し手列を受け取り、一手ごとに MultiPV で解析して
 * 各局面の候補手・評価値・読み筋を記録する
 */
import { BROWSER_ANALYSIS_LIMITS } from "../analysis-limits";
import type { UsiLog } from "./session";
import type { UsiAnalyzeOptions, UsiInfo, UsiScore, UsiSearchResult } from "./types";

/**
 * `analyzeKifu` が使うエンジンの範囲（テストからスタブを差し込めるよう最小限に絞る）。
 * `createUsiSession` の返すセッションも、worker の `UsiEngine` もこの形を満たす。
 */
export interface UsiAnalysisEngine {
  setOption(name: string, value: string): void;
  /** `options`（打ち切り）を使うのはブラウザの名指し評価だけ。手元 worker の実装は受けなくてよい */
  analyze(position: string, goCommand: string, options?: UsiAnalyzeOptions): Promise<UsiSearchResult>;
}

/**
 * 一局面での候補手（エンジンの出力そのままの形）。
 * ⚠ server の `CandidateMove`（保存・応答の形）とは別物なので、名前を分けている。
 */
export interface UsiCandidate {
  rank: number;
  move: string;
  score: UsiScore;
  pv: string[];
  depth: number;
}

/** 一手分の解析結果 */
export interface UsiMoveAnalysis {
  /** 手数 (1 = 初手の前の局面を解析) */
  moveNumber: number;
  /** エンジンの候補手リスト (MultiPV) */
  candidates: UsiCandidate[];
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
 * チャンク submit を server が**入力の誤りとして拒否した**（4xx。prd/05 §1.1a・prd/16 §4.1）。
 *
 * 🔴 **恒久失敗として扱う。** 同じ棋譜を解析し直しても同じ結果を送るので、一時失敗（{@link ChunkSubmitError}）
 * と同じく次の poll へ回すと、**同じ棋譜を解析しては拒否される堂々巡り**になり後続が進まない。
 * 呼び出し側は `analysisError` を記録して poll から外す。
 */
export class SubmitRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Analysis chunk rejected by server: ${status}`);
    this.name = "SubmitRejectedError";
  }
}

/**
 * submit の HTTP ステータスが**恒久失敗**（入力の誤り）か。
 *
 * - 4xx は恒久（範囲外・連続でない・rank の欠番など。送り直しても変わらない）
 * - ⚠ ただし **401 / 403（API_KEY の誤り）・408 / 429（混雑）は除く**——棋譜ではなく構成や
 *   一時的な状況の問題で、恒久扱いにすると**全棋譜が失敗として記録される**
 * - 5xx・通信エラーは一時失敗（今どおり次の poll で続きから再開）
 * - 世代の不一致は 201（`applied: false`）で返るので、ここには来ない
 */
export function isPermanentSubmitStatus(status: number): boolean {
  if (status < 400 || status >= 500) return false;
  return ![401, 403, 408, 429].includes(status);
}

/**
 * 候補手を **rank 1 からの連続した先頭部分**だけに絞る（rank 順に並べ直す）。
 *
 * server は各局面の rank が 1..n の連番でなければ 400 を返す（保存形が rank を配列の位置から戻すため。
 * prd/16 §4.1）。エンジンの info 行は MultiPV の番号が欠けることがありうるので（例: 1 と 3 だけ
 * 最終深さに届いた）、**欠番以降は捨てて送る**。正常系では何も変わらない。
 */
export function leadingContiguousCandidates(candidates: UsiCandidate[]): UsiCandidate[] {
  const sorted = [...candidates].sort((a, b) => a.rank - b.rank);
  const result: UsiCandidate[] = [];
  for (const c of sorted) {
    if (c.rank !== result.length + 1) break;
    result.push(c);
  }
  return result;
}

/** 報告に載せる評価値の絶対値の上限（cp も mate の手数も）。ブラウザ解析の上限と同じ値 */
const REPORT_SCORE_ABS_MAX = BROWSER_ANALYSIS_LIMITS.maxScoreAbs;

/**
 * 手元 worker が送る前に候補手を検査する（ブラウザの経路の `toBrowserReportCandidate` 相当）。
 *
 * - 評価値・深さが数として読めない（NaN・Infinity）候補は**捨てる**（数字を作らない）。
 *   そのまま送ると JSON で `null` になって server に 400 で拒否され、棋譜が恒久的な失敗として記録される
 * - 評価値は整数に丸めて ±{@link REPORT_SCORE_ABS_MAX} に、深さは 0 以上の整数に収める
 * - 捨てた結果 rank に欠番ができたら、欠番より後も捨てる（{@link leadingContiguousCandidates}）
 */
export function toReportCandidates(candidates: UsiCandidate[]): UsiCandidate[] {
  const finite = candidates
    .filter((c) => Number.isFinite(c.score.value) && Number.isFinite(c.depth))
    .map((c) => ({
      ...c,
      score: {
        ...c.score,
        value: Math.min(Math.max(Math.trunc(c.score.value), -REPORT_SCORE_ABS_MAX), REPORT_SCORE_ABS_MAX),
      },
      depth: Math.max(Math.trunc(c.depth), 0),
    }));
  return leadingContiguousCandidates(finite);
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
 * `ConsiderationMode` で pv を置換表から延長させて対処する（worker の configureEngine）。
 */
function shouldReplace(next: UsiInfo, prev: UsiInfo): boolean {
  if (!next.pv?.length) return false;
  if (next.bound && !prev.bound) return false;
  // 定跡の確定行（depth 0・pv は指し手＋ponder の 2 手固定）は、列挙側の行（読み筋が長い）を上書きしない。
  // 採ると rank 1 の読み筋が 2 手になり、確定行の手が別の rank と重複する（issue #67）
  if (next.depth === 0 && prev.depth !== 0) return false;
  return true;
}

/**
 * MultiPV の info 行群から各 PV の最終結果を抽出する
 * (同じ multipv 番号の最後の info を採用。ただし暫定値・定跡の確定行への後退は採らない)
 *
 * 検討局面の評価（worker の `position-eval.ts`）も同じ抽出を使う。
 *
 * @param options.multiPv - 指定すると rank がこの値以下の候補だけを返す。やねうら王は定跡にヒットすると
 *   **MultiPV の設定によらず**定跡の候補を `multipv 1..N` で列挙し、定跡を採用しなかった局面でも
 *   列挙の残骸（depth 0・pv 1 手）が rank 4 以降に残る（issue #67）。名指し評価（`searchmoves`）は
 *   手で探すので切り詰めない
 */
export function extractMultiPvResults(
  infoLines: UsiInfo[],
  options: { multiPv?: number } = {},
): UsiCandidate[] {
  const { multiPv } = options;
  const best = new Map<number, UsiInfo>();

  for (const info of infoLines) {
    const pvNum = info.multipv ?? 1;
    if (multiPv !== undefined && pvNum > multiPv) continue;
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

const RESIGN = "resign";

/**
 * 定跡にヒットしたか（ログ用）。やねうら王は定跡を採用すると、最後に採用手の確定行
 * （`depth 0`・pv は指し手＋ponder）を出して `bestmove` を返す。
 *
 * 候補手の rank 1 は列挙側の行が残る（確定行で上書きしない）ので、候補手の depth では判定できない。
 * **生の出力の最後の（depth を持つ）info 行が depth 0 で、その手が bestmove か**で見る。
 * 投了（`pv resign`）は depth 0 でも定跡ではない。
 */
function isBookHit(result: UsiSearchResult): boolean {
  const last = result.infoLines.findLast((info) => info.depth !== undefined);
  if (!last || last.depth !== 0) return false;
  const move = last.pv?.[0];
  return move !== undefined && move !== RESIGN && move === result.bestmove.move;
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
 * @param options.chunkMaxPositions - チャンクを区切る局面数。**時間の区切りに加えて**、未送信がこの数に
 *   達したら送る（受け側に 1 チャンクの局面数の上限があるとき用。prd/14 §5.8）。省略時は局面数では切らない
 * @param options.log - ログの出力先（`shared` は出力の手段を持たないので注入する。省略時は出さない）
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
  engine: UsiAnalysisEngine,
  usiMoves: string[],
  options: {
    depth?: number;
    multiPv?: number;
    movetime?: number;
    startMoveNumber?: number;
    chunkIntervalMs?: number;
    chunkMaxPositions?: number;
    log?: UsiLog;
    onProgress?: (analyzed: number, total: number) => void;
    onChunk?: (analyses: UsiMoveAnalysis[]) => Promise<void>;
    onPositionBoundary?: () => Promise<boolean | void>;
  } = {},
): Promise<KifuAnalysisSummary> {
  const {
    depth = 10,
    multiPv = 3,
    movetime,
    startMoveNumber = 0,
    chunkIntervalMs = CHUNK_INTERVAL_MS,
    chunkMaxPositions,
    log,
    onProgress,
    onChunk,
    onPositionBoundary,
  } = options;
  const goCommand = buildGoCommand({ depth, movetime });

  const total = usiMoves.length + 1;
  // 既に入っている局面は飛ばす（チャンク submit 中断からの再開）。範囲外の値でも走り抜けないよう挟む
  const start = Math.min(Math.max(startMoveNumber, 0), total);
  if (start > 0) {
    log?.info(`[Analysis] Resuming from ${start}/${usiMoves.length}`);
  }

  // 未送信のチャンク
  let pending: UsiMoveAnalysis[] = [];
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
      log?.info(
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
      log?.error(
        `[Analysis] ${i}/${usiMoves.length} Engine error at position: ${position}`,
      );
      throw err;
    }
    const elapsed = Date.now() - t0;
    // server の受理条件（rank が 1..n の連番。prd/16 §4.1）に合わせ、欠番以降は捨てる。
    // 🔒 終局局面の投了（`info depth 0 score mate -1 pv resign`）は残す——詰み筋の分類（`gameover`）が読む
    const candidates = leadingContiguousCandidates(
      extractMultiPvResults(result.infoLines, { multiPv }),
    );
    const isBook = isBookHit(result);
    const hashfull = extractHashfull(result.infoLines);
    if (hashfull !== undefined && (maxHashfull === undefined || hashfull > maxHashfull)) {
      maxHashfull = hashfull;
    }

    log?.info(
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

    // 時間でも局面数でも切る（局面数は受け側の上限に合わせるためで、指定が無ければ時間だけ）
    const chunkFull =
      chunkMaxPositions !== undefined && pending.length >= chunkMaxPositions;
    if (chunkFull || Date.now() - lastChunkAt >= chunkIntervalMs) {
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
