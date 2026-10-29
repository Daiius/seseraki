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
 * 偽のエンジンと偽の API で unit テストできる（`runner.test.ts`）。
 *
 * 失敗の扱い（prd/14 §5.7・§5.8）:
 * - **報告が破棄された**（`applied: false`。古い世代・別のエンジン・担当違い）→ 中断して開始からやり直す
 * - **5xx・通信の失敗** → 後退して再試行する。続けて失敗したら、この棋譜を後回しにする（失敗とは記録しない）
 * - **開始が 409**（担当がブラウザでない）→ 止める。呼び出し側が `GET /api/me` を取り直す
 * - **エンジンの失敗** → エンジンを作り直す。🔒 **作り直した後に同じ局面でもう一度失敗したときだけ**、
 *   棋譜の失敗として報告する（端末の不調——メモリ不足・凍結——で棋譜を失敗にしない）
 * - **ページが隠れている間の失敗**（スマホの凍結で応答が時間切れになる）→ 数えない。見えるまで待ってやり直す
 */
import { analyzeKifuForBrowser, BROWSER_ANALYSIS_LIMITS } from 'shared';
import type { AnalysisStage, ErrorReportResult, RunnerApi, SkipReason } from './apiResult';
import {
  NEEDS_CONSENT_DETAIL,
  type AnalysisEngine,
  type EngineCache,
  type EngineChoice,
  type RunnerLog,
} from './engineCache';

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

/** ページの可視（スマホはバックグラウンドで凍結する。その間の失敗を数えないために見る） */
export interface Visibility {
  isHidden(): boolean;
  /** 最後にページの可視が切り替わった時刻（隠れた・見えた のどちらも）。まだ無ければ null */
  lastChangedAt(): number | null;
  /** ページが見えるまで待つ。中断されたら待たずに解決する */
  waitVisible(signal: AbortSignal): Promise<void>;
}

export interface KifuAnalysisDeps {
  api: RunnerApi;
  /**
   * いま選んでいる評価関数。開始の口を叩くたびに読み、前と違えばエンジンを作り直す
   * ——選択の変更は、次の解析（次の段・次の棋譜）の開始から効く（負荷の設定と同じ。prd/14 §5.10）。
   * 🔒 **選んだ評価関数のダウンロードに同意していなければ null**。解析を止める（`halt` の `needs-consent`）
   * ——前の評価関数でも解析しない（選んだものと違う結果を作らない）
   */
  currentEngine(): EngineChoice | null;
  /** `ms` 待つ。中断されたら待たずに解決する */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  visibility: Visibility;
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
      /** `needs-consent`: 選んだ評価関数のダウンロードに同意していない（{@link KifuAnalysisDeps.currentEngine}） */
      reason: 'wrong-assignee' | 'unauthorized' | 'fatal' | 'engine-load' | 'needs-consent';
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

/**
 * 1 つの棋譜を解析する関数を作る（quick → full を続けて）。`signal` で中断すると、局面の境目で未送信のチャンクを送ってから戻る。
 * エンジンは `engines`（棋譜・読みをまたいで使い回す 1 本）から借りる
 */
export function createKifuAnalysis(deps: KifuAnalysisDeps, engines: EngineCache) {
  const { api, log } = deps;

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
        if (signal.aborted || engines.isDisposed()) return { kind: 'aborted' };

        // 評価関数の選択は段ごとに読む（開始の口・エンジン・報告で同じものを使う）
        const choice = deps.currentEngine();
        if (choice === null) {
          return { kind: 'halt', reason: 'needs-consent', detail: NEEDS_CONSENT_DETAIL };
        }
        const engineInfo = choice.info;

        const started = await withRetry('start', signal, () =>
          api.start(kifuNo, {
            engineBuild: engineInfo.engineBuild,
            evalHash: engineInfo.evalHash,
          }),
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
          current = await engines.acquire(run.settings, choice);
          // 読み込めた。数えるのは続けて失敗した回数（一度読めたら、後の失敗は初めからまた数える）
          engineLoadFailures = 0;
        } catch (error) {
          engines.discard();
          if (signal.aborted || engines.isDisposed()) return { kind: 'aborted' };
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
          engines.discard();
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

  return analyze;
}
