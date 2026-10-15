/**
 * 1 つの棋譜をブラウザで解析する（prd/14 §5.2・§5.8）。
 * 開始の口 → 解析のループ（shared の `analyzeKifuForBrowser`）→ チャンクの報告 → 完了。
 *
 * **2 段**（prd/14 §5.2・§5.8）: 開始の口が段（`profile`。quick / full）と、その段の再開位置・思考時間を返す。
 * 🔒 **段はブラウザが決めない**——返った段と思考時間で回し、チャンクの本文にその段を載せる（server が照合する）。
 * quick が揃った（`stageCompleted`）ら、同じ棋譜を続けて full へ（開始の口を叩き直して full を受け取る）。
 * 棋譜の完了は `completed`（full まで揃った）。
 * full を回している間は、呼び出し側が「ほかの棋譜に譲るか」（{@link AnalyzeHooks.shouldYield}）を
 * 局面の境目で聞く（quick 待ちの棋譜を先にするため。prd/14 §5.10）。
 *
 * 🔒 **依存はすべて注入する**（API・エンジン・時計・待ち・画面の可視）。DOM にも fetch にも触れないので、
 * 偽のエンジンと偽の API で unit テストできる。
 *
 * 失敗の扱い（prd/14 §5.7・§5.8）:
 * - **報告が破棄された**（`applied: false`。古い世代・別のエンジン・担当違い）→ 中断して開始からやり直す
 * - **5xx・通信の失敗** → 後退して再試行する。続けて失敗したら、この棋譜を後回しにする（失敗とは記録しない）
 * - **開始が 409**（担当がブラウザでない）→ 止める。呼び出し側が `GET /api/me` を取り直す
 * - **エンジンの失敗** → エンジンを作り直す。🔒 **作り直した後に同じ局面でもう一度失敗したときだけ**、
 *   棋譜の失敗として報告する（端末の不調——メモリ不足・凍結——で棋譜を失敗にしない）
 * - **ページが隠れている間の失敗**（スマホの凍結で応答が時間切れになる）→ 数えない。見えるまで待ってやり直す
 */
import {
  analyzeKifuForBrowser,
  BROWSER_ANALYSIS_LIMITS,
  isPermanentSubmitStatus,
  namedEvaluationOf,
  namedGoCommand,
  sfenPositionCommand,
  withAllLegalMoves,
  type BrowserAnalysisChunk,
  type DrillNamedEvaluation,
  type BrowserAnalysisRun,
  type BrowserAnalysisSettings as ServerAnalysisSettings,
  type UsiAnalysisEngine,
} from 'shared';
import type { AnalysisLoad } from './settings';

/** 開始の口の応答を、次にすることで分けたもの */
/** 解析の段（prd/14 §5.7。server が決める） */
export type AnalysisStage = 'quick' | 'full';

export type StartResult =
  | { kind: 'run'; run: BrowserAnalysisRun; profile: AnalysisStage }
  /** 解析しない（解析済み・失敗の記録あり・指し手列が無い・棋譜が無い） */
  | { kind: 'skip'; reason: SkipReason }
  /** 担当がブラウザでない（409） */
  | { kind: 'wrong-assignee' }
  /** セッションが切れた（401） */
  | { kind: 'unauthorized' }
  /** 続けても直らない拒否（403 = Origin の検査など） */
  | { kind: 'fatal'; detail: string }
  /** 5xx・通信の失敗・混雑。後退して再試行する */
  | { kind: 'retry'; detail: string };

export type SkipReason = 'complete' | 'failed' | 'unanalyzable' | 'not-found';

export type ChunkResult =
  | {
      kind: 'ok';
      applied: boolean;
      /** full まで揃った（解析全体の完了） */
      completed: boolean;
      /** 届いたチャンクの段が揃った */
      stageCompleted: boolean;
    }
  /** 入力の誤りとして拒否された（4xx）。送り直しても変わらない */
  | { kind: 'rejected'; status: number }
  | { kind: 'unauthorized' }
  | { kind: 'fatal'; detail: string }
  | { kind: 'retry'; detail: string };

/**
 * HTTP ステータスを結果の種類にする（開始・チャンクの報告で共通の部分）。
 * 2xx と、口ごとに意味の違うステータス（開始の 404 / 409）は呼び出し側が先に見る。
 */
export function classifyFailureStatus(
  status: number,
): 'unauthorized' | 'fatal' | 'rejected' | 'retry' {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'fatal';
  return isPermanentSubmitStatus(status) ? 'rejected' : 'retry';
}

export type ErrorReportResult = 'recorded' | 'discarded' | 'unsent';

/** 失敗の報告の応答（201 の本文）を結果にする。`applied` が true のときだけ記録済み */
export function errorReportResultOf(body: unknown): ErrorReportResult {
  return typeof body === 'object' &&
    body !== null &&
    'applied' in body &&
    body.applied === true
    ? 'recorded'
    : 'discarded';
}

export interface RunnerApi {
  start(
    kifuNo: number,
    engine: { engineBuild: string; evalHash: string },
  ): Promise<StartResult>;
  submitChunk(kifuNo: number, chunk: BrowserAnalysisChunk): Promise<ChunkResult>;
  /**
   * 失敗を記録する。
   * - `recorded`: 記録された
   * - `discarded`: 破棄された（201 `applied: false`。世代が進んだ・別のタブが完了させた・担当が変わった）。
   *   🔒 **記録済みとして扱わない**——server に失敗は残っていないので、開始の口で今の状態を聞き直す
   * - `unsent`: 送れなかった（通信の失敗・4xx / 5xx）
   */
  reportError(
    kifuNo: number,
    body: { revision: number; error: string },
  ): Promise<ErrorReportResult>;
}

/** 起動済み（`readyok` まで済んだ）のエンジン */
export interface AnalysisEngine {
  session: UsiAnalysisEngine;
  /** エンジンの名乗り（USI の `id name`） */
  name: string | null;
  threads: number;
  hashMb: number;
  dispose(): void;
}

export interface RunnerLog {
  info(message: string): void;
  warn(message: string): void;
}

/** 解析中の棋譜の進捗（画面の表示用。server には送らない） */
export interface LocalProgress {
  kifuNo: number;
  revision: number;
  /** いま回している段（円環の濃さに使う。quick は薄く出す——手元 worker の進捗と同じ見え方） */
  profile: AnalysisStage;
  /** 解析済みの局面数 */
  analyzed: number;
  /** 全局面数（指し手数 + 1） */
  total: number;
}

export interface RunnerDeps {
  api: RunnerApi;
  /** 来歴に記録する値（manifest から。prd/14 §5.9） */
  engineInfo: { engineBuild: string; evalHash: string; fvScale: number };
  /**
   * エンジンを読み込んで起動する。評価関数のダウンロードもここ（投げたら読み込みの失敗）。
   * ⚠ 棋譜の中断では止めない（詳細ページを離れただけで、数十 MB のダウンロードを捨てない）。
   * 止めるのは常駐そのものを止めるときで、それは呼び出し側（`createEngine` の実装）が受け持つ
   */
  createEngine(
    settings: ServerAnalysisSettings,
    load: AnalysisLoad,
  ): Promise<AnalysisEngine>;
  /**
   * 今の負荷の設定（端末の設定。prd/14 §5.10）。開始の口を叩くたびに読み、前と違えばエンジンを作り直す
   * ——スレッド数の変更は、次の解析（次の段・次の棋譜）の開始から効く
   */
  currentLoad(): AnalysisLoad;
  /** `ms` 待つ。中断されたら待たずに解決する */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  visibility: {
    isHidden(): boolean;
    /** 最後にページの可視が切り替わった時刻（隠れた・見えた のどちらも）。まだ無ければ null */
    lastChangedAt(): number | null;
    /** ページが見えるまで待つ。中断されたら待たずに解決する */
    waitVisible(signal: AbortSignal): Promise<void>;
  };
  onProgress(progress: LocalProgress | null): void;
  /**
   * 棋譜の段が 1 つ揃った（quick の完了。full の完了は解析の結果 `complete` で返る）。
   * 画面のデータを取り直す合図——quick の結果を、full の完了を待たずに画面に出す
   */
  onStageCompleted(kifuNo: number, profile: AnalysisStage): void;
  log: RunnerLog;
}

/** 1 回の解析ごとに呼び出し側が渡すもの */
export interface AnalyzeHooks {
  /**
   * full を回している間、ほかの棋譜に譲るか（true なら局面の境目で未送信のチャンクを送って止め、`yielded` を返す）。
   * full の開始の前と、full の途中の局面の境目で（{@link YIELD_CHECK_INTERVAL_MS} ごとに）呼ぶ。
   * quick の間は呼ばない（quick 同士は譲らない）
   */
  shouldYield?(): Promise<boolean>;
  /**
   * 採点の読み（出題の名指し評価。prd/14 §5.10）がほかのタブで待っているか。**局面の境目ごと**に聞き、true なら
   * 未送信のチャンクを送って止め、`paused` を返す（採点の読みは全局面解析より優先。同じタブの採点は呼び出し側が中断で止める）。
   * quick / full のどちらでも聞く
   */
  shouldPause?(): Promise<boolean>;
}

/** 採点の読み（出題の名指し評価。prd/13 §5.3）で頼まれること。server の応答（`status: 'evaluate'`）の中身 */
export interface NamedEvalRequest {
  /** 読む局面（利用者がいま見ている局面） */
  sfen: string;
  /** 名指しする手（利用者の手） */
  move: string;
  /** 読む設定（全局面解析の深い段と同じ。思考時間・置換表・スレッドの上限・読み筋の長さ） */
  settings: ServerAnalysisSettings;
}

export type NamedEvalOutcome =
  /** 解答に付けて送り直す評価（server の `drillNamedEvaluationSchema` を通る形） */
  | { kind: 'ok'; evaluation: DrillNamedEvaluation }
  /** エンジンが名指しした手を読まなかった（その局面で指せない手など）。🔒 数字を作らず、採点を頼まない */
  | { kind: 'mismatch'; returned: string }
  /** エンジンを読み込めない・読みが失敗した（作り直して 1 度やり直した後） */
  | { kind: 'failed'; detail: string };

export type KifuOutcome =
  | { kind: 'complete' }
  | { kind: 'skipped'; reason: SkipReason }
  /** 失敗として server に記録した */
  | { kind: 'failed'; error: string }
  /** 中断された（未送信のチャンクは送ってある） */
  | { kind: 'aborted' }
  /** ほかのタブの採点の読みに譲った（未送信のチャンクは送ってある。{@link AnalyzeHooks.shouldPause}） */
  | { kind: 'paused' }
  /** full の途中で、ほかの棋譜に譲った（未送信のチャンクは送ってある。{@link AnalyzeHooks.shouldYield}） */
  | { kind: 'yielded' }
  /** 今は進められない（通信の失敗が続いた・世代が進み続けた）。失敗とは記録していない。後で試す */
  | { kind: 'deferred'; detail: string }
  /** これ以上どの棋譜も解析しない */
  | {
      kind: 'halt';
      reason: 'wrong-assignee' | 'unauthorized' | 'fatal' | 'engine-load';
      detail: string;
    };

/** 通信の失敗の後に待つ時間（この回数だけ再試行し、尽きたら後回しにする） */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
/** 報告が破棄されて開始からやり直す回数の上限（別の端末と世代を取り合い続けない） */
export const MAX_STALE_RESTARTS = 3;
/** エンジンの読み込みをやり直す回数の上限 */
export const MAX_ENGINE_LOAD_ATTEMPTS = 2;
/** 1 つの棋譜で開始の口を呼ぶ回数の上限（どの経路でも回り続けないための歯止め） */
export const MAX_ROUNDS = 12;
/** full の途中で「ほかの棋譜に譲るか」を聞く間隔（局面の境目ごとに叩くと、未解析の一覧を叩きすぎる） */
export const YIELD_CHECK_INTERVAL_MS = 15_000;
/**
 * ページが見えるのを待つ間に「採点の読みが待っているか」を聞く間隔。
 * 🔒 見えるのを待つ間もロックを持っているので、聞かないとほかのタブの採点の読みがそのタブを表示するまで待たされる（レビュー OCL-62435AC8）
 */
export const PAUSE_CHECK_WHILE_HIDDEN_MS = 1_000;

class StaleReportError extends Error {}
class DeferError extends Error {}
class RejectedReportError extends Error {
  constructor(readonly status: number) {
    super(`解析結果を保存できませんでした (${status})`);
  }
}
class HaltError extends Error {
  constructor(
    readonly reason: 'unauthorized' | 'fatal',
    detail: string,
  ) {
    super(detail);
  }
}
class AbortedError extends Error {}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export interface KifuRunner {
  /**
   * 1 つの棋譜を解析する（quick → full を続けて）。`signal` で中断すると、局面の境目で未送信のチャンクを送ってから戻る
   */
  analyze(
    kifuNo: number,
    signal: AbortSignal,
    hooks?: AnalyzeHooks,
  ): Promise<KifuOutcome>;
  /**
   * 採点の読み（出題の名指し評価）を 1 つ読む（prd/13 §5.3）。`position sfen …` → `go movetime <ms> searchmoves <手>`。
   * エンジンは全局面解析と共用する（棋譜をまたいで使い回すものと同じ。負荷の設定も同じく効く）。
   * ⚠ 全局面解析と同時に呼ばない（呼び出し側が全局面解析を止めてから呼ぶ。エンジンは 1 本）
   */
  evaluateNamed(request: NamedEvalRequest): Promise<NamedEvalOutcome>;
  /** エンジンを止める */
  dispose(): void;
}

export function createKifuRunner(deps: RunnerDeps): KifuRunner {
  const { api, engineInfo, log } = deps;
  /** 棋譜をまたいで使い回すエンジン。失敗したら捨てて作り直す */
  let engine: AnalysisEngine | null = null;
  let engineSettingsKey = '';
  let disposed = false;

  const disposeEngine = () => {
    engine?.dispose();
    engine = null;
  };

  const ensureEngine = async (
    settings: ServerAnalysisSettings,
  ): Promise<AnalysisEngine> => {
    // スレッド数・置換表の指定（server の定数）か、負荷の設定（端末の設定）が変わったら作り直す。
    // ⚠ スレッド数は動いているエンジンに setoption で変えず、作り直す（WASM のスレッドの確保を実機で確かめていないため）
    const load = deps.currentLoad();
    const key = `${settings.maxThreads}:${settings.hashMb}:${load}`;
    if (engine && engineSettingsKey === key) return engine;
    if (engine) log.info(`recreating the engine (${engineSettingsKey} -> ${key})`);
    disposeEngine();
    const created = await deps.createEngine(settings, load);
    if (disposed) {
      // 読み込んでいる間に止められた。使わずに捨てる
      created.dispose();
      throw new Error('解析は停止済みです');
    }
    engine = created;
    engineSettingsKey = key;
    return created;
  };

  /** 通信の失敗を後退しながら再試行する。尽きたら DeferError */
  const withRetry = async <T extends { kind: string }>(
    what: string,
    signal: AbortSignal,
    call: () => Promise<T>,
  ): Promise<Exclude<T, { kind: 'retry' }>> => {
    for (let attempt = 0; ; attempt++) {
      let result: T | { kind: 'retry'; detail: string };
      try {
        result = await call();
      } catch (error) {
        result = { kind: 'retry', detail: messageOf(error) };
      }
      if (result.kind !== 'retry') {
        return result as Exclude<T, { kind: 'retry' }>;
      }
      const detail = (result as { detail: string }).detail;
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw new DeferError(`${what}: ${detail}`);
      }
      log.warn(`${what} failed (${detail}). retry in ${RETRY_DELAYS_MS[attempt]}ms`);
      await deps.sleep(RETRY_DELAYS_MS[attempt], signal);
      if (signal.aborted) throw new AbortedError();
    }
  };

  const analyze = async (
    kifuNo: number,
    signal: AbortSignal,
    hooks: AnalyzeHooks = {},
  ): Promise<KifuOutcome> => {
    /** ほかのタブの採点の読みに譲るかを聞く（聞けなければ譲らない） */
    const askPause = async (): Promise<boolean> => {
      if (!hooks.shouldPause) return false;
      try {
        return await hooks.shouldPause();
      } catch {
        return false;
      }
    };
    let paused = false;
    /**
     * ページが見えるまで待つ。待つ間もロックを持っているので、ほかのタブの採点の読みが待っていたら待つのをやめる
     * （true を返す。呼び出し側は `paused` で止めてロックを手放す。レビュー OCL-62435AC8）
     */
    const waitVisibleOrPause = async (): Promise<boolean> => {
      if (!hooks.shouldPause) {
        await deps.visibility.waitVisible(signal);
        return false;
      }
      while (!signal.aborted && deps.visibility.isHidden()) {
        if (await askPause()) return true;
        const round = new AbortController();
        const onAbort = () => round.abort();
        signal.addEventListener('abort', onAbort);
        try {
          await Promise.race([
            deps.visibility.waitVisible(round.signal),
            deps.sleep(PAUSE_CHECK_WHILE_HIDDEN_MS, round.signal),
          ]);
        } finally {
          // 負けた側の待ちを片付ける（聞き手を溜めない）
          round.abort();
          signal.removeEventListener('abort', onAbort);
        }
      }
      return false;
    };
    /** 譲るかを聞く（聞けなければ譲らない） */
    const askYield = async (): Promise<boolean> => {
      if (!hooks.shouldYield) return false;
      try {
        return await hooks.shouldYield();
      } catch {
        return false;
      }
    };
    let staleRestarts = 0;
    let engineLoadFailures = 0;
    /** 直前にエンジンが失敗した局面（世代と局面番号）。作り直した後に同じ所で失敗したら報告する */
    let failedAt: { revision: number; position: number } | null = null;

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (signal.aborted) return { kind: 'aborted' };

        const started = await withRetry('start', signal, () =>
          api.start(kifuNo, engineInfo),
        );
        switch (started.kind) {
          case 'skip':
            log.info(`kifu #${kifuNo}: nothing to do (${started.reason})`);
            return started.reason === 'complete'
              ? { kind: 'complete' }
              : { kind: 'skipped', reason: started.reason };
          case 'wrong-assignee':
            return {
              kind: 'halt',
              reason: 'wrong-assignee',
              detail: '解析の設定が変わりました',
            };
          case 'unauthorized':
            return { kind: 'halt', reason: 'unauthorized', detail: 'ログインが切れました' };
          case 'fatal':
            return { kind: 'halt', reason: 'fatal', detail: started.detail };
        }
        const { run, profile } = started;
        const total = run.usiMoves.length + 1;
        log.info(
          `kifu #${kifuNo}: start ${profile} revision=${run.revision} from=${run.startMoveNumber}/${total} movetime=${run.settings.movetimeMs}ms`,
        );
        // full を始める前に、先にすべき棋譜（quick 待ち）が無いか聞く。エンジンを読み込む前に聞いて、無駄に読み込まない
        if (profile === 'full' && (await askYield())) {
          log.info(`kifu #${kifuNo}: yielding before full`);
          return { kind: 'yielded' };
        }
        if (signal.aborted) return { kind: 'aborted' };

        let current: AnalysisEngine;
        try {
          current = await ensureEngine(run.settings);
        } catch (error) {
          disposeEngine();
          if (signal.aborted) return { kind: 'aborted' };
          if (deps.visibility.isHidden()) {
            // 隠れている間の読み込みの失敗（凍結・通信の切断）は数えない
            log.warn(`engine load failed while hidden: ${messageOf(error)}`);
            if (await waitVisibleOrPause()) {
              log.info(`kifu #${kifuNo}: pausing while hidden for a drill answer`);
              return { kind: 'paused' };
            }
            continue;
          }
          engineLoadFailures++;
          log.warn(`engine load failed (${engineLoadFailures}): ${messageOf(error)}`);
          if (engineLoadFailures >= MAX_ENGINE_LOAD_ATTEMPTS) {
            return { kind: 'halt', reason: 'engine-load', detail: messageOf(error) };
          }
          await deps.sleep(RETRY_DELAYS_MS[0], signal);
          continue;
        }
        if (signal.aborted) return { kind: 'aborted' };

        /** 解析済みの局面数（= いま解析している局面の番号） */
        let cursor = run.startMoveNumber;
        let positionStartedAt = deps.now();
        let completed = false;
        let stageCompleted = false;
        let yielded = false;
        let lastYieldCheck = deps.now();
        deps.onProgress({ kifuNo, revision: run.revision, profile, analyzed: cursor, total });

        try {
          const summary = await analyzeKifuForBrowser(current.session, run, {
            onPositionBoundary: async () => {
              // 中断は局面の境目で受ける（未送信のチャンクは解析のループが送ってから戻る）
              if (signal.aborted) return true;
              // 採点の読みが待っていれば、局面の境目で先に譲る（prd/14 §5.10）
              if (await askPause()) {
                paused = true;
                return true;
              }
              // full の途中: しばらくごとに、ほかの棋譜（quick 待ち）に譲るかを聞く
              if (
                profile === 'full' &&
                hooks.shouldYield &&
                deps.now() - lastYieldCheck >= YIELD_CHECK_INTERVAL_MS
              ) {
                lastYieldCheck = deps.now();
                if (await askYield()) {
                  yielded = true;
                  return true;
                }
              }
              // 聞いている間の時間は、局面の解析の時間に数えない（隠れていた間の失敗の判定に使う）
              positionStartedAt = deps.now();
              return signal.aborted;
            },
            onProgress: (analyzed) => {
              cursor = analyzed;
              deps.onProgress({ kifuNo, revision: run.revision, profile, analyzed, total });
            },
            onChunk: async (analyses) => {
              const first = analyses[0].moveNumber;
              const last = analyses[analyses.length - 1].moveNumber;
              const result = await withRetry('chunk', signal, () =>
                api.submitChunk(kifuNo, {
                  revision: run.revision,
                  engineBuild: engineInfo.engineBuild,
                  evalHash: engineInfo.evalHash,
                  engineName: current.name,
                  fvScale: engineInfo.fvScale,
                  threads: current.threads,
                  hashMb: current.hashMb,
                  movetimeMs: run.settings.movetimeMs,
                  // 開始の口が返した段をそのまま申告する（server が棋譜の状態と照合する）
                  profile,
                  analyses,
                }),
              );
              switch (result.kind) {
                case 'unauthorized':
                  throw new HaltError('unauthorized', 'ログインが切れました');
                case 'fatal':
                  throw new HaltError('fatal', result.detail);
                case 'rejected':
                  throw new RejectedReportError(result.status);
                case 'ok':
                  log.info(
                    `kifu #${kifuNo}: ${profile} chunk ${first}..${last} applied=${result.applied} stageCompleted=${result.stageCompleted} completed=${result.completed}`,
                  );
                  if (!result.applied) throw new StaleReportError();
                  if (result.stageCompleted) stageCompleted = true;
                  if (result.completed) completed = true;
              }
            },
          });
          if (completed) return { kind: 'complete' };
          if (summary.interrupted) {
            if (paused && !signal.aborted) {
              log.info(`kifu #${kifuNo}: pausing at position ${cursor} for a drill answer`);
              return { kind: 'paused' };
            }
            if (yielded && !signal.aborted) {
              log.info(`kifu #${kifuNo}: yielding at position ${cursor} of full`);
              return { kind: 'yielded' };
            }
            return { kind: 'aborted' };
          }
          // 完了のログは呼び出し側（一区切りの通知）が出す。ここでも出すと 2 行になる
          if (stageCompleted && profile === 'quick') {
            // quick が揃った。画面に quick の結果を出させ、開始の口を叩き直して full を受け取る
            log.info(`kifu #${kifuNo}: quick complete. continuing to full`);
            deps.onStageCompleted(kifuNo, profile);
            continue;
          }
          // 最後まで送ったのに完了の応答が無い。開始からやり直して server に状態を聞く
          continue;
        } catch (error) {
          if (error instanceof AbortedError) return { kind: 'aborted' };
          if (error instanceof DeferError) throw error;
          if (error instanceof HaltError) {
            return { kind: 'halt', reason: error.reason, detail: error.message };
          }
          if (error instanceof StaleReportError) {
            // 世代が進んだ・別のエンジンの解析が入っている・担当が変わった。開始の口が次を決める
            staleRestarts++;
            if (staleRestarts > MAX_STALE_RESTARTS) {
              return { kind: 'deferred', detail: '報告が受け付けられない状態が続いています' };
            }
            log.info(`kifu #${kifuNo}: report discarded. restarting`);
            continue;
          }
          if (error instanceof RejectedReportError) {
            // 送り直しても同じ結果を送るので、失敗として記録して止める（堂々巡りにしない）
            const outcome = await fail(kifuNo, run.revision, error.message);
            if (outcome !== 'restart') return outcome;
            if (++staleRestarts > MAX_STALE_RESTARTS) {
              return { kind: 'deferred', detail: '報告が受け付けられない状態が続いています' };
            }
            continue;
          }

          // ここから先はエンジンの失敗（死・時間切れ・`info string Error!`）。エンジンは必ず作り直す
          disposeEngine();
          const detail = messageOf(error);
          if (signal.aborted) return { kind: 'aborted' };
          const changedAt = deps.visibility.lastChangedAt();
          const hiddenDuring =
            deps.visibility.isHidden() ||
            (changedAt !== null && changedAt >= positionStartedAt);
          if (hiddenDuring) {
            log.warn(`engine failed while the page was hidden (not counted): ${detail}`);
            if (await waitVisibleOrPause()) {
              log.info(`kifu #${kifuNo}: pausing while hidden for a drill answer`);
              return { kind: 'paused' };
            }
            continue;
          }
          if (
            failedAt !== null &&
            failedAt.revision === run.revision &&
            failedAt.position === cursor
          ) {
            const outcome = await fail(
              kifuNo,
              run.revision,
              `${cursor} 手目の局面を解析できませんでした: ${detail}`,
            );
            if (outcome !== 'restart') return outcome;
            // 失敗の報告が破棄された。数え直して、開始の口に今の状態を聞く
            failedAt = null;
            if (++staleRestarts > MAX_STALE_RESTARTS) {
              return { kind: 'deferred', detail: '報告が受け付けられない状態が続いています' };
            }
            continue;
          }
          failedAt = { revision: run.revision, position: cursor };
          log.warn(
            `engine failed at position ${cursor} of kifu #${kifuNo}: ${detail}. recreating the engine`,
          );
        }
      }
      return { kind: 'deferred', detail: '解析を進められませんでした' };
    } catch (error) {
      if (error instanceof AbortedError) return { kind: 'aborted' };
      if (error instanceof DeferError) {
        log.warn(`kifu #${kifuNo}: deferred (${error.message})`);
        return { kind: 'deferred', detail: error.message };
      }
      throw error;
    } finally {
      deps.onProgress(null);
    }
  };

  /**
   * 棋譜の失敗として記録する。送れなければ後回し（次に同じ失敗をしたときに記録される）。
   * 🔒 **破棄された（`applied: false`）ら `restart`**——失敗は server に残っていない。記録済みとして扱うと、
   * 未完了の棋譜を「失敗済み」として長く選ばなくなる。開始の口が今の状態（完了・新しい世代）を返す
   */
  const fail = async (
    kifuNo: number,
    revision: number,
    message: string,
  ): Promise<KifuOutcome | 'restart'> => {
    const error = message.slice(0, BROWSER_ANALYSIS_LIMITS.errorMaxLength);
    log.warn(`kifu #${kifuNo}: reporting failure: ${error}`);
    let result: ErrorReportResult;
    try {
      result = await api.reportError(kifuNo, { revision, error });
    } catch {
      result = 'unsent';
    }
    if (result === 'recorded') return { kind: 'failed', error };
    if (result === 'discarded') {
      log.info(`kifu #${kifuNo}: failure report discarded. restarting`);
      return 'restart';
    }
    return { kind: 'deferred', detail: '失敗を記録できませんでした' };
  };

  const evaluateNamed = async (request: NamedEvalRequest): Promise<NamedEvalOutcome> => {
    const { sfen, move, settings } = request;
    let detail = '';
    // エンジンが失敗したら 1 度だけ作り直して読み直す（全局面解析と同じく、端末の不調 1 回で諦めない）
    for (let attempt = 0; attempt < 2; attempt++) {
      let current: AnalysisEngine;
      try {
        current = await ensureEngine(settings);
      } catch (error) {
        disposeEngine();
        detail = `解析エンジンを読み込めませんでした（${messageOf(error)}）`;
        log.warn(`drill: engine load failed (${attempt + 1}): ${messageOf(error)}`);
        continue;
      }
      try {
        // 🔴 不成の手も読めるよう、読みの間だけ GenerateAllLegalMoves を有効にする（終わったら戻す）
        const result = await withAllLegalMoves(current.session, () =>
          current.session.analyze(
            sfenPositionCommand(sfen),
            namedGoCommand(settings.movetimeMs, move),
          ),
        );
        const named = namedEvaluationOf(result, move, settings.pvMaxPlies);
        if (named.kind === 'mismatch') return named;
        return {
          kind: 'ok',
          evaluation: {
            move,
            candidate: named.candidate,
            engineBuild: engineInfo.engineBuild,
            evalHash: engineInfo.evalHash,
            engineName: current.name,
            fvScale: engineInfo.fvScale,
            threads: current.threads,
            hashMb: current.hashMb,
            movetimeMs: settings.movetimeMs,
          },
        };
      } catch (error) {
        // 死・時間切れ・`info string Error!`。エンジンは必ず作り直す
        disposeEngine();
        detail = messageOf(error);
        log.warn(`drill: engine failed (${attempt + 1}): ${detail}`);
      }
    }
    return { kind: 'failed', detail };
  };

  return {
    analyze,
    evaluateNamed,
    dispose: () => {
      disposed = true;
      disposeEngine();
    },
  };
}
