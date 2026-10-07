// 解析結果を 1 棋譜 1 行に詰めた形（`kifuAnalyses.detail` / `runs`。prd/16 §3）の読み書き。
// DB 接続を持たない純粋な関数だけを置き、route.ts・drills.ts・局面の再利用から使う。
//
// 🔒 **形を知っているのはこのファイルだけにする。** 呼び出し側は `decodePosition` /
// `mergeChunk` を通し、`detail` の配列の位置（`[run, 候補手]`・`[move, scoreType, …]`）を直接読まない。

/** 候補手 1 本の保存形。位置が意味を持つ（prd/16 §3.1）。rank は候補手配列の位置 + 1 */
export type StoredCandidate = [
  move: string,
  scoreType: 'cp' | 'mate',
  scoreValue: number,
  depth: number,
  pv: string[] | null,
];

/** 1 局面の保存形。`run` は `runs` の添字（その局面を書いた submit） */
export type StoredPosition = [run: number, candidates: StoredCandidate[]];

/** 添字が `moveNumber` */
export type AnalysisDetail = StoredPosition[];

/** submit 1 回ぶんの来歴と時刻（prd/16 §3.1） */
export interface AnalysisRun {
  // ⚠ **リテラル union をそのまま書く**（`AnalysisProfile` の別名を使うと、詳細 GET の
  // Hono RPC の応答型が web から名前で参照できず TS2742 になる）
  profile: 'quick' | 'full';
  engineName: string | null;
  movetimeMs: number | null;
  targetDepth: number | null;
  multiPv: number | null;
  /** submit のトランザクションの時刻（ISO 8601） */
  at: string;
}

/** API・呼び出し側が扱う候補手（旧 `candidateMoves` の行と同じ項目） */
export interface CandidateMove {
  rank: number;
  move: string;
  scoreType: 'cp' | 'mate';
  scoreValue: number;
  pv: string[] | null;
  depth: number;
}

/** submit で届く候補手（`pv` は省略されうる） */
export type CandidateInput = Omit<CandidateMove, 'pv'> & { pv?: string[] | null };

/** 展開した 1 局面 */
export interface DecodedPosition {
  moveNumber: number;
  run: AnalysisRun;
  candidates: CandidateMove[];
}

/**
 * 1 局面の候補手の rank が **1..n の連番**（重複・欠番なし。順不同）か（prd/16 §4.1）。
 *
 * 🔴 保存形は rank を持たず**配列の位置から戻す**ので、連番でない rank を受けると黙って
 * 書き換わる（rank 2 だけ届くと rank 1 として保存される）。submit はこれを満たさなければ 400。
 * worker は MultiPV の結果を 1 から並べるので、正常系では起きない。候補手 0 本は通す。
 */
export function hasContiguousRanks(candidates: { rank: number }[]): boolean {
  const ranks = candidates.map((c) => c.rank).sort((a, b) => a - b);
  return ranks.every((rank, i) => rank === i + 1);
}

/** 候補手（rank 順に並んだもの）を保存形へ */
export function encodeCandidates(candidates: CandidateInput[]): StoredCandidate[] {
  return [...candidates]
    .sort((a, b) => a.rank - b.rank)
    .map((c) => [c.move, c.scoreType, c.scoreValue, c.depth, c.pv ?? null]);
}

export function decodeCandidates(stored: StoredCandidate[]): CandidateMove[] {
  return stored.map(([move, scoreType, scoreValue, depth, pv], i) => ({
    rank: i + 1,
    move,
    scoreType,
    scoreValue,
    pv,
    depth,
  }));
}

/**
 * 1 局面を展開する。`runs` に指す先が無ければ例外（行が壊れている。黙って補わない）。
 */
export function decodePosition(
  detail: AnalysisDetail,
  runs: AnalysisRun[],
  moveNumber: number,
): DecodedPosition | null {
  const entry = detail[moveNumber];
  if (entry === undefined) return null;
  const [runIndex, candidates] = entry;
  const run = runs[runIndex];
  if (run === undefined) {
    throw new Error(`kifu_analyses: run ${runIndex} が無い局面 ${moveNumber}`);
  }
  return { moveNumber, run, candidates: decodeCandidates(candidates) };
}

/** 全局面を展開する（`moveNumber` 昇順） */
export function decodeAll(detail: AnalysisDetail, runs: AnalysisRun[]): DecodedPosition[] {
  return detail.map((_, moveNumber) => decodePosition(detail, runs, moveNumber)!);
}

/** 1 行ぶんの状態（まだ行が無ければ空） */
export interface StoredAnalysis {
  detail: AnalysisDetail;
  runs: AnalysisRun[];
  fullCount: number;
}

export const EMPTY_ANALYSIS: StoredAnalysis = { detail: [], runs: [], fullCount: 0 };

export type MergeResult =
  | { ok: true; next: StoredAnalysis; wrote: boolean }
  /** 局面が連続していない・受理条件の先頭を越えた（prd/16 §4.2）→ 400 */
  | { ok: false };

/**
 * チャンクを今の状態に重ねる（prd/16 §4）。
 *
 * - チャンクの `moveNumber` は**連続した昇順**であること（worker は先頭から順に送る）
 * - **full**: 先頭が `fullCount` 以下（重なりは再送として上書き）。受理後
 *   `fullCount = max(fullCount, 末尾 + 1)`。🔴 越えた先頭を受けると、飛ばした局面が
 *   full として数えられ、先頭からの連続区間という前提が崩れる
 * - **quick**: 先頭が `detail.length` 以下。`moveNumber < fullCount` の局面は捨てる
 *   （段階の後退防止）。`fullCount` は変えない
 * - 書いた局面は今回の run を指す。どこからも指されなくなった run は詰める
 *
 * `0 <= moveNumber <= usiMoves.length` の検証は呼び出し側（`isChunkInRange`）が先に行う。
 */
export function mergeChunk(
  current: StoredAnalysis,
  chunk: { moveNumber: number; candidates: CandidateInput[] }[],
  run: AnalysisRun,
): MergeResult {
  if (chunk.length === 0) return { ok: true, next: current, wrote: false };
  const first = chunk[0].moveNumber;
  for (let i = 1; i < chunk.length; i++) {
    if (chunk[i].moveNumber !== first + i) return { ok: false };
  }
  const last = first + chunk.length - 1;

  if (run.profile === 'full') {
    if (first > current.fullCount) return { ok: false };
  } else if (first > current.detail.length) {
    return { ok: false };
  }

  const writes =
    run.profile === 'full'
      ? chunk
      : chunk.filter((a) => a.moveNumber >= current.fullCount);
  if (writes.length === 0) return { ok: true, next: current, wrote: false };

  const runIndex = current.runs.length;
  const detail: AnalysisDetail = [...current.detail];
  for (const a of writes) {
    detail[a.moveNumber] = [runIndex, encodeCandidates(a.candidates)];
  }
  const fullCount =
    run.profile === 'full' ? Math.max(current.fullCount, last + 1) : current.fullCount;

  return {
    ok: true,
    wrote: true,
    next: compactRuns({ detail, runs: [...current.runs, run], fullCount }),
  };
}

/** どの局面からも指されない run を落とし、添字を振り直す（順序は保つ） */
export function compactRuns(analysis: StoredAnalysis): StoredAnalysis {
  const used = new Set(analysis.detail.map(([run]) => run));
  if (used.size === analysis.runs.length) return analysis;
  const remap = new Map<number, number>();
  const runs: AnalysisRun[] = [];
  analysis.runs.forEach((r, i) => {
    if (!used.has(i)) return;
    remap.set(i, runs.length);
    runs.push(r);
  });
  return {
    ...analysis,
    runs,
    detail: analysis.detail.map(([run, c]) => [remap.get(run)!, c]),
  };
}

/**
 * 手番ごとに「最善が自分の N 手詰め（N ≥ 1）」だった局面の最小の N（prd/16 §3.2）。
 *
 * `moveNumber` が偶数なら先手番・奇数なら後手番（prd/03 §3）。スコアは手番視点なので、
 * rank 1 の正の `mate` が「手番側が詰ませる」を意味する。
 * 一覧・分析の述語 `minMate{Sente,Gote} <= limit` は、以前の
 * 「rank 1・mate・1 <= value <= limit の局面が存在する」と同値になる。
 *
 * ⚠ 移行の SQL（drizzle/ の kifu_analyses のマイグレーション）にも同じ計算がある。
 * 変えるなら両方を変え、`test:db` の突き合わせで揃っていることを確かめる。
 */
export function minMateBySide(detail: AnalysisDetail): {
  sente: number | null;
  gote: number | null;
} {
  let sente: number | null = null;
  let gote: number | null = null;
  detail.forEach(([, candidates], moveNumber) => {
    const best = candidates[0];
    if (!best || best[1] !== 'mate' || best[2] < 1) return;
    if (moveNumber % 2 === 0) {
      sente = sente === null ? best[2] : Math.min(sente, best[2]);
    } else {
      gote = gote === null ? best[2] : Math.min(gote, best[2]);
    }
  });
  return { sente, gote };
}
