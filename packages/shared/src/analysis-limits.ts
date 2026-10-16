// ブラウザ解析の報告（チャンク・失敗）の検証と上限。prd/14-multi-user.md §5.8・§6.2。
//
// ブラウザから届く解析結果は**信用できない入力**なので、server が zod で落とす。
// 定数と zod をここ（shared）に置くのは、**web が同じ値で送る前に切りそろえる**ため——
// 長すぎる読み筋を server に拒否させると、その棋譜の解析が恒久的に失敗して見える。
// 手元 worker の報告（API_KEY の内部経路）にはこの上限を掛けない（MultiPV 3・検証は server 側の別の zod）。
import { z } from 'zod';

/** ブラウザ解析の報告の上限 */
export const BROWSER_ANALYSIS_LIMITS = {
  /** 1 局面の候補手の本数（ブラウザの全局面解析は MultiPV 1。prd/14 §5.2） */
  maxCandidates: 1,
  /** 探索深さ（USI の `depth`）の上限 */
  maxDepth: 255,
  /** 評価値の絶対値の上限（cp も mate の手数も整数。エンジンの出す値はこれよりずっと小さい） */
  maxScoreAbs: 1_000_000,
  /** 読み筋の長さ（語数）。**web はこの長さで切ってから送る** */
  pvMaxPlies: 128,
  /** 1 チャンクの局面数 */
  chunkMaxPositions: 32,
  /** リクエスト本文の大きさ（バイト）。上の上限いっぱいのチャンク（≒ 30KB）が収まる値 */
  bodyMaxBytes: 64 * 1024,
  /** 失敗の報告の文の長さ */
  errorMaxLength: 500,
  /** 局面の番号（`moveNumber`）の上限。棋譜の手数との照合は server が棋譜を読んでから行う */
  maxMoveNumber: 10_000,
} as const;

/** USI の指し手（移動 `7g7f` / 成り `7g7f+` / 打ち `P*5e`） */
const USI_MOVE = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;

/**
 * 読み筋に現れる、指し手ではない語。
 * - `resign`: 詰まされた側の最善手。**詰みの分類が `pv[0] === 'resign'` を読む**（`mate-line.ts`）ので落とせない
 * - `win`: 入玉宣言勝ち
 * - `rep_*`: 千日手などで読み筋が打ち切られた印（やねうら王）
 */
const PV_SPECIAL = /^(?:resign|win|rep_(?:draw|win|lose|sup|inf))$/;

/** 読み筋の 1 語として受けてよいか（USI の指し手か、上の特別な語） */
export function isPvToken(token: string): boolean {
  return USI_MOVE.test(token) || PV_SPECIAL.test(token);
}

const pvToken = z.string().refine(isPvToken, '読み筋に使えない語');

const scoreValue = z
  .number()
  .int()
  .min(-BROWSER_ANALYSIS_LIMITS.maxScoreAbs)
  .max(BROWSER_ANALYSIS_LIMITS.maxScoreAbs);

/** 候補手 1 本。⚠ `move` は空文字も受ける（読み筋が空の局面で worker と同じく空になる） */
export const browserCandidateSchema = z.object({
  // MultiPV 1 なので rank は 1 だけ（保存形は rank を配列の位置から戻す。prd/16 §4.1）
  rank: z.literal(1),
  move: z.string().refine((m) => m === '' || isPvToken(m), '指し手の形が違う'),
  scoreType: z.enum(['cp', 'mate']),
  scoreValue,
  depth: z.number().int().min(0).max(BROWSER_ANALYSIS_LIMITS.maxDepth),
  pv: z.array(pvToken).max(BROWSER_ANALYSIS_LIMITS.pvMaxPlies).optional(),
});

/** 世代（`kifus.analysisRevision`。integer の列に収まる値） */
const revision = z.number().int().min(0).max(2_147_483_647);

/** エンジンのビルド識別（manifest のエントリの `engine.buildId`。`engine-manifest.ts`） */
const engineBuild = z.string().regex(/^[0-9a-f]+-[0-9a-f]+$/).max(128);
/** 評価関数のハッシュ（manifest のエントリの `nn.sha256`） */
const evalHash = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * 開始の口の本文（prd/14 §5.8・§5.9）。途中の解析をやり直すかは、この 2 つが来歴と同じかで決まる
 */
export const browserAnalysisStartSchema = z.object({ engineBuild, evalHash });
export type BrowserAnalysisStart = z.infer<typeof browserAnalysisStartSchema>;

/**
 * チャンクの報告の本文（prd/14 §5.8）。
 * 実行環境（`wasm`）・MultiPV（1）・定跡（なし）は **server が固定する**ので送らない。
 * 🔒 **段（quick / full）は server が棋譜の状態から決める。** `profile` は任意の申告で、載っていて
 * 状態と合わなければ破棄される（201 `applied: false`）。載っていなければ状態の段で受ける
 */
export const browserAnalysisChunkSchema = z.object({
  /** 開始の口が返した世代。違えば破棄される（201 `applied: false`） */
  revision,
  /** 開始の口が返した段（任意。状態と照合するだけで、段を決めるのは server） */
  profile: z.enum(['quick', 'full']).optional(),
  // --- 来歴（prd/14 §5.9）---
  engineBuild,
  evalHash,
  /** エンジンの名乗り（USI の `id name`） */
  engineName: z.string().max(255).nullish(),
  fvScale: z.number().int().min(1).max(1024),
  threads: z.number().int().min(1).max(64),
  hashMb: z.number().int().min(1).max(65_536),
  movetimeMs: z.number().int().min(1).max(60_000),
  // --- 解析した局面（先頭から連続した昇順）---
  analyses: z
    .array(
      z.object({
        moveNumber: z.number().int().min(0).max(BROWSER_ANALYSIS_LIMITS.maxMoveNumber),
        candidates: z.array(browserCandidateSchema).max(BROWSER_ANALYSIS_LIMITS.maxCandidates),
      }),
    )
    .min(1)
    .max(BROWSER_ANALYSIS_LIMITS.chunkMaxPositions),
});
export type BrowserAnalysisChunk = z.infer<typeof browserAnalysisChunkSchema>;

/** 失敗の報告の本文（prd/14 §5.8） */
export const browserAnalysisErrorSchema = z.object({
  revision,
  error: z.string().trim().min(1).max(BROWSER_ANALYSIS_LIMITS.errorMaxLength),
});
export type BrowserAnalysisError = z.infer<typeof browserAnalysisErrorSchema>;

// --- 出題の採点の名指し評価（prd/13 §5.3・prd/14 §5.8）---

/**
 * 出題の解答に付けて送り直す、ブラウザの名指し評価（`go … searchmoves <手>`）の結果。
 *
 * ブラウザから届く値は**信用できない入力**（影響は本人の成績に閉じる。prd/14 §5.1）。全局面解析の報告と同じ考え方で
 * 形と上限を検証する。🔒 **判定は server が行う**（正解 / 惜しい / 不正解・別解・詰み上がり。prd/13 §5.3）——ここは値の形だけ。
 *
 * - `move`: 名指しした手（USI の指し手。server は解答の最後の手と一致するかも確かめる——別の手の評価で採点させない）
 * - `candidate`: その手の評価（手番側から見た値・読み筋の先頭はその手）。**`null` は「候補なし」**
 *   （エンジンが評価を出さなかった。server は手元 worker のフォールバックの「候補なし」と同じ扱いで、
 *   その手で詰み上がったかを盤面から見る。prd/13 §5.2）
 * - 来歴（ビルド識別・評価関数・`FV_SCALE`・スレッド・置換表・思考時間）: 全局面解析のチャンクと同じ形。
 *   解答の記録には残さない（受けて形を確かめるだけ。実装時に決定）
 */
export const drillNamedEvaluationSchema = z
  .object({
    move: z.string().regex(USI_MOVE, '指し手の形が違う'),
    candidate: z
      .object({
        scoreType: z.enum(['cp', 'mate']),
        scoreValue,
        depth: z.number().int().min(0).max(BROWSER_ANALYSIS_LIMITS.maxDepth),
        pv: z.array(pvToken).min(1).max(BROWSER_ANALYSIS_LIMITS.pvMaxPlies),
      })
      .nullable(),
    engineBuild,
    evalHash,
    engineName: z.string().max(255).nullish(),
    fvScale: z.number().int().min(1).max(1024),
    threads: z.number().int().min(1).max(64),
    hashMb: z.number().int().min(1).max(65_536),
    movetimeMs: z.number().int().min(1).max(60_000),
  })
  // 読み筋の先頭は名指しした手（`searchmoves` の結果の形）。違えば別の手の評価
  .refine((v) => v.candidate === null || v.candidate.pv[0] === v.move, {
    message: '読み筋の先頭が名指しした手と違う',
    path: ['candidate', 'pv'],
  });
export type DrillNamedEvaluation = z.infer<typeof drillNamedEvaluationSchema>;

/** 読み筋を上限の長さに切る（web が送る前に通す。拒否を恒久失敗にしないため） */
export function clampPv(pv: readonly string[]): string[] {
  return pv.slice(0, BROWSER_ANALYSIS_LIMITS.pvMaxPlies);
}
