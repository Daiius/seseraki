/**
 * 検討局面の評価キュー兼キャッシュ（prd/12 §2.4）。
 *
 * **DB テーブルは足さない。** server プロセスのメモリに置き、再起動で消えることを許容する
 * （web が再要求すれば済む。エンジン構成を変えたときに古い評価が残らない利点もあり、
 * 「解析来歴は持たない」方針とも整合する）。単一プロセス前提でモジュールスコープに状態を
 * 持つ流儀は `analysis-progress.ts` / `swars/job-store.ts` と同じ（prd/02 §1 / prd/07）。
 *
 * 流れ（**非同期。決定 2026-08-29 で long-poll をやめた**。prd/12 §2.4）:
 * 1. web / LLM が評価を要求する → キャッシュにあれば即答、無ければジョブを作って
 *    **その場で jobId を返す**（HTTP は数十 ms で終わる）
 * 2. worker が棋譜解析の局面境界で claim する（prd/12 §2.1）
 * 3. worker が結果 or 失敗を報告する → 結果は `results` に置かれ、成功は `cache` にも載る
 * 4. 要求側は jobId で**取りに来る**（{@link getEvaluationResult}）
 *
 * 🔴 **long-poll をやめた理由**: 本番は server の前段にタイムアウトを持つ層があり、
 * その期限は server の期限よりずっと短い。**エンジン評価が終わる前に前段が切って
 * しまい、成功しているのに画面はエラーになった**。前段の設定値は server 側から
 * 確かめられず将来も変わりうるので、**そこに依存しない形にした**。
 *
 * 🔒 **待たせ続けない。** worker が取りに来ない・報告しないまま期限が来たジョブは
 * `failed` として完了させる（prd/12 §2.4）。失敗はキャッシュに載せない（次の要求で再試行できる）。
 *
 * 🔒 **棋譜の解析状態（`analysisError` / `analysisRevision`）には一切触れない。**
 * interactive なジョブには対応する棋譜も世代も無い（prd/12 §2.5）。
 */

/** 候補手 1 本。列名は `candidateMoves` に合わせるが、**DB には保存しない** */
export interface EvalCandidate {
  rank: number;
  move: string;
  scoreType: 'cp' | 'mate';
  scoreValue: number;
  pv: string[];
  depth: number;
}

export type EvalOutcome =
  | {
      status: 'done';
      /**
       * 手番側（= 検討モードでは自分。prd/12 §2.3）から見た候補手。
       * 名指し評価では**その手 1 本**（`pv` の先頭が名指しした手）。
       */
      candidates: EvalCandidate[];
      /**
       * 名指し評価を `go searchmoves` ではなく
       * 「手を適用した局面を評価して符号反転」で求めたか（prd/12 §2.2 のフォールバック）。
       * 局面評価では常に false。
       */
      fallback: boolean;
      /** 評価が確定した時刻（ISO）。キャッシュの古さを見るのに使う */
      evaluatedAt: string;
    }
  | { status: 'failed'; error: string };

export interface EvalRequest {
  /** 正規化済みの局面キー（`positionSfen`。route 側で SFEN を読み直して正規化する） */
  sfen: string;
  /** 名指し評価の対象手（USI）。局面評価は null */
  move: string | null;
}

/** worker に渡すジョブ */
export interface ClaimedEvalJob extends EvalRequest {
  id: string;
}

/** worker からの結果報告 */
export type EvalReport =
  | { candidates: EvalCandidate[]; fallback: boolean }
  | { error: string };

/** キャッシュに載せる件数の上限。超えたら**古い順に捨てる**（Map は挿入順を保つ） */
const CACHE_LIMIT = 200;

/**
 * 同時に抱えるジョブ数の上限。worker が止まっているときに要求だけが積み上がるのを防ぐ。
 * 個人用途の同時要求はほぼ 1 件（prd/12 §2.1）なので、これに当たるのは異常時だけ。
 */
const MAX_JOBS = 32;

/** worker が取りに来るまでの猶予。ポーリング間隔 + 解析中の 1 局面ぶんを見込む */
const DEFAULT_QUEUE_TIMEOUT_MS = 120_000;
/** claim してから結果が返るまでの猶予。エンジンの思考時間 + 余裕 */
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** キューが一杯（worker が止まっている疑い）。route は 503 で返す */
export class EvaluationQueueFullError extends Error {
  constructor() {
    super('position evaluation queue is full');
    this.name = 'EvaluationQueueFullError';
  }
}

/**
 * 完了した結果を jobId で取りに来られる期間（ミリ秒）。
 *
 * 🔴 **「結果を取りに行く前に消える」と、永久に取れない要求が生まれる。** 非同期化で
 * 待っている HTTP 要求が無くなったぶん、**完了とポーリングの間に隙間ができる**ので、
 * 完了後もしばらく jobId で引けるようにする。クライアントのポーリング間隔（1 秒前後）と、
 * タブが背面に回って間隔が絞られる場合を見込んで 5 分。
 *
 * ⚠ 成功した結果はキー側の `cache` にも載るので、TTL が切れても**同じ body を投げ直せば
 * 即答が返る**（失われるのは失敗の理由だけ）。
 */
const RESULT_TTL_MS = 300_000;

/** 保持する完了結果の件数の上限。超えたら古い順に捨てる（Map は挿入順を保つ） */
const RESULT_LIMIT = 200;

interface Job extends EvalRequest {
  id: string;
  key: string;
  status: 'queued' | 'running';
  timer: ReturnType<typeof setTimeout> | null;
}

/** id → ジョブ。**挿入順 = 古い順**なので claim は先頭から取る */
const jobs = new Map<string, Job>();
/** キー → ジョブ。同一局面の同時要求を 1 本にまとめる */
const byKey = new Map<string, Job>();
/** キー → 成功した評価。失敗は載せない（次の要求で再試行できるように） */
const cache = new Map<string, Extract<EvalOutcome, { status: 'done' }>>();
/** jobId → 完了した結果（失敗も含む）。{@link RESULT_TTL_MS} で消える */
const results = new Map<string, { outcome: EvalOutcome; expiresAt: number }>();

let sequence = 0;

/**
 * キャッシュとジョブのキー（prd/12 §2.4）。
 * **正規化 SFEN + 評価種別 + 名指し手**。局面評価と名指し評価は別物なので混ざらないようにする。
 */
export function evaluationKey({ sfen, move }: EvalRequest): string {
  return move === null ? `position ${sfen}` : `move ${sfen} ${move}`;
}

function settleJob(job: Job, outcome: EvalOutcome): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = null;
  jobs.delete(job.id);
  // 同じキーで作り直された別のジョブを消さない
  if (byKey.get(job.key) === job) byKey.delete(job.key);
  if (outcome.status === 'done') {
    cache.set(job.key, outcome);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  retainResult(job.id, outcome);
}

/** 完了した結果を jobId で引けるように置く（TTL と件数で掃除する） */
function retainResult(id: string, outcome: EvalOutcome): void {
  const now = Date.now();
  for (const [key, entry] of results) {
    if (entry.expiresAt > now) break; // 挿入順 = 期限順（TTL は一定）
    results.delete(key);
  }
  results.set(id, { outcome, expiresAt: now + RESULT_TTL_MS });
  while (results.size > RESULT_LIMIT) {
    const oldest = results.keys().next();
    if (oldest.done) break;
    results.delete(oldest.value);
  }
}

function armTimer(job: Job, ms: number, error: string): void {
  if (job.timer) clearTimeout(job.timer);
  const timer = setTimeout(() => {
    settleJob(job, { status: 'failed', error });
  }, ms);
  // 評価待ちのタイマーがプロセスを生かし続けないようにする
  timer.unref?.();
  job.timer = timer;
}

/** {@link startEvaluation} の返り */
export type EvalStart =
  /** その場で結果が出た（キャッシュ命中）。**1 往復で終わる** */
  | { state: 'settled'; outcome: EvalOutcome }
  /** 受け付けた。`jobId` で取りに来る */
  | { state: 'pending'; jobId: string };

/** {@link getEvaluationResult} の返り */
export type EvalPoll =
  | { state: 'pending' }
  | { state: 'settled'; outcome: EvalOutcome }
  /**
   * その jobId を知らない。**まだ出ていない**のではなく**もう取れない**
   * （TTL 切れ / server 再起動でメモリごと消えた）。
   * 要求側は**同じ body を投げ直す**（キャッシュにあれば即答、無ければ改めてジョブになる）。
   */
  | { state: 'unknown' };

/**
 * 評価を要求する。**待たない**（決定 2026-08-29。prd/12 §2.4）。
 *
 * - キャッシュにあれば即座に結果を返す（**棋譜をなぞっている間は 1 往復のまま**）
 * - 同じキーのジョブが既にあれば**相乗りする**（同じ局面を二重にエンジンへ流さない）。
 *   このとき返るのは**既存ジョブの id** なので、要求を投げ直しても仕事は増えない
 */
export function startEvaluation(request: EvalRequest): EvalStart {
  const key = evaluationKey(request);

  const cached = cache.get(key);
  if (cached) return { state: 'settled', outcome: cached };

  const existing = byKey.get(key);
  if (existing) return { state: 'pending', jobId: existing.id };

  if (jobs.size >= MAX_JOBS) throw new EvaluationQueueFullError();

  const job: Job = {
    id: `eval-${++sequence}`,
    key,
    sfen: request.sfen,
    move: request.move,
    status: 'queued',
    // 期限は armTimer で入れる（queued と running で長さが違う）
    timer: null,
  };
  jobs.set(job.id, job);
  byKey.set(key, job);
  armTimer(
    job,
    envMs('POSITION_EVAL_QUEUE_TIMEOUT_MS', DEFAULT_QUEUE_TIMEOUT_MS),
    'worker が評価を取りに来ませんでした',
  );
  return { state: 'pending', jobId: job.id };
}

/**
 * jobId で結果を取りに来る。
 *
 * 🔒 **`unknown` と `pending` を混ぜない。** 取り違えると、クライアントは永久に
 * 出ない結果を待ち続ける（または、出ている結果を捨てて最初からやり直す）。
 */
export function getEvaluationResult(id: string): EvalPoll {
  const done = results.get(id);
  if (done) {
    if (done.expiresAt > Date.now()) return { state: 'settled', outcome: done.outcome };
    results.delete(id);
    return { state: 'unknown' };
  }
  return jobs.has(id) ? { state: 'pending' } : { state: 'unknown' };
}

/**
 * worker が次のジョブを取る（**待っている中で最も古い 1 件**）。
 * 取った時点で期限を「エンジンの思考時間ぶん」に張り直す。
 */
export function claimEvaluationJob(): ClaimedEvalJob | null {
  for (const job of jobs.values()) {
    if (job.status !== 'queued') continue;
    job.status = 'running';
    armTimer(
      job,
      envMs('POSITION_EVAL_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS),
      'worker から評価結果が返りませんでした',
    );
    return { id: job.id, sfen: job.sfen, move: job.move };
  }
  return null;
}

/**
 * worker からの報告でジョブを完了させる（**失敗も完了**。prd/12 §2.4）。
 *
 * ⚠ 完了しても待っている HTTP 要求はいない。結果は `results` に置かれ、
 * 要求側が jobId で取りに来る（{@link getEvaluationResult}）。
 *
 * @returns 反映したか（期限切れで既に落ちたジョブなら false）
 */
export function completeEvaluationJob(id: string, report: EvalReport): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  settleJob(
    job,
    'error' in report
      ? { status: 'failed', error: report.error }
      : {
          status: 'done',
          candidates: report.candidates,
          fallback: report.fallback,
          evaluatedAt: new Date().toISOString(),
        },
  );
  return true;
}

/** 監視・テスト用の内訳 */
export function evaluationStats(): {
  queued: number;
  running: number;
  cached: number;
} {
  let queued = 0;
  let running = 0;
  for (const job of jobs.values()) {
    if (job.status === 'queued') queued++;
    else running++;
  }
  return { queued, running, cached: cache.size };
}

/** テスト用。プロセス状態をリセットする（走っているジョブのタイマーも落とす） */
export function resetEvaluations(): void {
  for (const job of [...jobs.values()]) {
    settleJob(job, { status: 'failed', error: 'reset' });
  }
  jobs.clear();
  byKey.clear();
  cache.clear();
  results.clear();
  sequence = 0;
}
