/**
 * 1 つの棋譜をブラウザで解析する（prd/14 §5.2・§5.8）。
 * 開始の口 → 解析のループ（shared の `analyzeKifuForBrowser`）→ チャンクの報告 → 完了。
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
  type BrowserAnalysisChunk,
  type BrowserAnalysisRun,
  type BrowserAnalysisSettings as ServerAnalysisSettings,
  type UsiAnalysisEngine,
} from 'shared';

/** 開始の口の応答を、次にすることで分けたもの */
export type StartResult =
  | { kind: 'run'; run: BrowserAnalysisRun }
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
  | { kind: 'ok'; applied: boolean; completed: boolean }
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

export interface RunnerApi {
  start(
    kifuNo: number,
    engine: { engineBuild: string; evalHash: string },
  ): Promise<StartResult>;
  submitChunk(kifuNo: number, chunk: BrowserAnalysisChunk): Promise<ChunkResult>;
  /** 失敗を記録する。記録できたか（通信の失敗などで送れなければ false） */
  reportError(
    kifuNo: number,
    body: { revision: number; error: string },
  ): Promise<boolean>;
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
  createEngine(settings: ServerAnalysisSettings): Promise<AnalysisEngine>;
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
  log: RunnerLog;
}

export type KifuOutcome =
  | { kind: 'complete' }
  | { kind: 'skipped'; reason: SkipReason }
  /** 失敗として server に記録した */
  | { kind: 'failed'; error: string }
  /** 中断された（未送信のチャンクは送ってある） */
  | { kind: 'aborted' }
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
  /** 1 つの棋譜を解析する。`signal` で中断すると、局面の境目で未送信のチャンクを送ってから戻る */
  analyze(kifuNo: number, signal: AbortSignal): Promise<KifuOutcome>;
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
    // スレッド数・置換表の指定が変わったら作り直す（server の定数なので普段は変わらない）
    const key = `${settings.maxThreads}:${settings.hashMb}`;
    if (engine && engineSettingsKey === key) return engine;
    disposeEngine();
    const created = await deps.createEngine(settings);
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
  ): Promise<KifuOutcome> => {
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
        const { run } = started;
        const total = run.usiMoves.length + 1;
        log.info(
          `kifu #${kifuNo}: start revision=${run.revision} from=${run.startMoveNumber}/${total} movetime=${run.settings.movetimeMs}ms`,
        );

        let current: AnalysisEngine;
        try {
          current = await ensureEngine(run.settings);
        } catch (error) {
          disposeEngine();
          if (signal.aborted) return { kind: 'aborted' };
          if (deps.visibility.isHidden()) {
            // 隠れている間の読み込みの失敗（凍結・通信の切断）は数えない
            log.warn(`engine load failed while hidden: ${messageOf(error)}`);
            await deps.visibility.waitVisible(signal);
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
        deps.onProgress({ kifuNo, revision: run.revision, analyzed: cursor, total });

        try {
          const summary = await analyzeKifuForBrowser(current.session, run, {
            onPositionBoundary: async () => {
              positionStartedAt = deps.now();
              // 中断は局面の境目で受ける（未送信のチャンクは解析のループが送ってから戻る）
              return signal.aborted;
            },
            onProgress: (analyzed) => {
              cursor = analyzed;
              deps.onProgress({ kifuNo, revision: run.revision, analyzed, total });
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
                    `kifu #${kifuNo}: chunk ${first}..${last} applied=${result.applied} completed=${result.completed}`,
                  );
                  if (!result.applied) throw new StaleReportError();
                  if (result.completed) completed = true;
              }
            },
          });
          if (summary.interrupted) return { kind: 'aborted' };
          // 完了のログは呼び出し側（一区切りの通知）が出す。ここでも出すと 2 行になる
          if (completed) return { kind: 'complete' };
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
            return await fail(kifuNo, run.revision, error.message);
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
            await deps.visibility.waitVisible(signal);
            continue;
          }
          if (
            failedAt !== null &&
            failedAt.revision === run.revision &&
            failedAt.position === cursor
          ) {
            return await fail(
              kifuNo,
              run.revision,
              `${cursor} 手目の局面を解析できませんでした: ${detail}`,
            );
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

  /** 棋譜の失敗として記録する。送れなければ後回し（次に同じ失敗をしたときに記録される） */
  const fail = async (
    kifuNo: number,
    revision: number,
    message: string,
  ): Promise<KifuOutcome> => {
    const error = message.slice(0, BROWSER_ANALYSIS_LIMITS.errorMaxLength);
    log.warn(`kifu #${kifuNo}: reporting failure: ${error}`);
    let recorded = false;
    try {
      recorded = await api.reportError(kifuNo, { revision, error });
    } catch {
      recorded = false;
    }
    return recorded
      ? { kind: 'failed', error }
      : { kind: 'deferred', detail: '失敗を記録できませんでした' };
  };

  return {
    analyze,
    dispose: () => {
      disposed = true;
      disposeEngine();
    },
  };
}
