/**
 * ブラウザ解析の常駐（prd/14 §5.10）。実物の依存（Worker・fetch・Web Locks・document）を
 * runner と scheduler に配線する。画面からは `__root.tsx` の `BrowserAnalysisHost` が起動・停止する。
 *
 * 判断はここに書かない（`runner.ts` / `scheduler.ts` / `support.ts` の、テストのある側に置く）。
 *
 * コンソールに `[browser-analysis]` の接頭辞で経過を出す（実機での確認用）。
 * `localStorage['seseraki:browserAnalysis:debug'] = '1'` で、USI のやり取りと局面ごとの結果も出す。
 */
import { engineHostUrl } from 'virtual:engine-host';
import {
  createUsiSession,
  engineEntryDownloadBytes,
  engineEntryOf,
  type BrowserAnalysisSettings as ServerAnalysisSettings,
  type EngineManifest,
  type EngineManifestEntry,
} from 'shared';
import { fetchPendingKifuNos, runnerApi } from './api';
import {
  connectEngineHost,
  engineOptions,
  initRequest,
  type HostWorkerLike,
} from './engineHost';
import { engineUrls, fetchEngineManifest } from './enginePaths';
import {
  createKifuRunner,
  type AnalysisEngine,
  type EngineChoice,
  type RunnerDeps,
  type RunnerLog,
} from './runner';
import { createScheduler } from './scheduler';
import { setBrowserGrader } from './grading';
import {
  getBrowserAnalysisSettings,
  hasConsented,
  type AnalysisLoad,
  type AnalysisMode,
} from './settings';
import {
  getAnalysisFocus,
  onAnalysisFocusChange,
  onBrowserAnalysisPoke,
  patchBrowserAnalysisState,
  resetBrowserAnalysisState,
} from './store';
import { detectSupport, readBrowserEnv } from './support';

const LOG_PREFIX = '[browser-analysis]';
/** 同じブラウザの中の解析を 1 本に絞るロックの名前 */
const LOCK_NAME = 'seseraki:browser-analysis';
/**
 * 採点の読みが待っている印のロック（prd/14 §5.10）。採点の読みはこれを取ってから {@link LOCK_NAME} を待つ。
 * ほかのタブの解析は、局面の境目でこれが取られている（待たれている）のを見て譲る
 */
const PRIORITY_LOCK_NAME = 'seseraki:browser-analysis:drill';

/** ほかのタブで採点の読みが待っているか（Web Locks の照会） */
async function priorityWaiting(): Promise<boolean> {
  const snapshot = await navigator.locks.query();
  return [...(snapshot.held ?? []), ...(snapshot.pending ?? [])].some(
    (lock) => lock.name === PRIORITY_LOCK_NAME,
  );
}

const log: RunnerLog = {
  info: (message) => console.info(LOG_PREFIX, message),
  warn: (message) => console.warn(LOG_PREFIX, message),
};

function debugEnabled(): boolean {
  try {
    return localStorage.getItem('seseraki:browserAnalysis:debug') === '1';
  } catch {
    return false;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });

/** ページの可視（スマホはバックグラウンドで凍結する。その間の失敗を数えないために見る） */
function createVisibility(signal: AbortSignal): RunnerDeps['visibility'] {
  let lastChangedAt: number | null =
    document.visibilityState === 'hidden' ? Date.now() : null;
  const onChange = () => {
    lastChangedAt = Date.now();
  };
  document.addEventListener('visibilitychange', onChange);
  signal.addEventListener('abort', () =>
    document.removeEventListener('visibilitychange', onChange),
  );
  return {
    isHidden: () => document.visibilityState === 'hidden',
    lastChangedAt: () => lastChangedAt,
    waitVisible: (waitSignal) =>
      new Promise<void>((resolve) => {
        if (document.visibilityState !== 'hidden' || waitSignal.aborted) {
          return resolve();
        }
        const done = () => {
          if (document.visibilityState === 'hidden' && !waitSignal.aborted) return;
          document.removeEventListener('visibilitychange', done);
          waitSignal.removeEventListener('abort', done);
          resolve();
        };
        document.addEventListener('visibilitychange', done);
        waitSignal.addEventListener('abort', done);
      }),
  };
}

/**
 * いま選んでいる評価関数（端末の設定と manifest から。prd/14 §5.5）。
 * 🔒 選んだ評価関数のダウンロードに同意していなければ null（前の評価関数でも解析しない）
 */
function currentChoice(manifest: EngineManifest): EngineChoice | null {
  const settings = getBrowserAnalysisSettings();
  const entry = engineEntryOf(manifest, settings.evalId);
  if (!hasConsented(settings, entry.nn.sha256)) return null;
  return {
    id: entry.id,
    info: {
      engineBuild: entry.engine.buildId,
      evalHash: entry.nn.sha256,
      fvScale: entry.fvScale,
    },
  };
}

/** エンジンのホスト（Worker）を起動し、評価関数を渡して `readyok` まで進める */
async function createEngine(
  origin: string,
  entry: EngineManifestEntry,
  settings: ServerAnalysisSettings,
  load: AnalysisLoad,
  signal: AbortSignal,
  patch: typeof patchBrowserAnalysisState,
): Promise<AnalysisEngine> {
  log.info(
    `loading engine eval=${entry.id} build=${entry.engine.buildId} nn=${entry.nn.sha256.slice(0, 16)} load=${load} host=${engineHostUrl}`,
  );
  patch({
    phase: 'loading',
    download: { loaded: 0, total: engineEntryDownloadBytes(entry) },
  });
  // 🔒 classic の Worker（`type: 'module'` を付けない）。ホストは importScripts でエンジンのグルーを読む
  const worker = new Worker(engineHostUrl, { name: 'seseraki-engine' });
  const connection = connectEngineHost(
    worker as unknown as HostWorkerLike,
    initRequest(entry, engineUrls(origin, entry)),
    {
      onDownload: (loaded, total) => patch({ download: { loaded, total } }),
    },
  );
  const onAbort = () => connection.dispose();
  signal.addEventListener('abort', onAbort);
  try {
    await connection.ready;
    log.info('engine instantiated and eval loaded');
    const debug = debugEnabled();
    const session = createUsiSession(connection.transport, {
      timers: {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      log: debug
        ? {
            info: (message) => console.debug(LOG_PREFIX, message),
            error: (message) => console.warn(LOG_PREFIX, message),
          }
        : undefined,
    });
    await session.start();
    const options = engineOptions(entry, settings, navigator.hardwareConcurrency, load);
    for (const [name, value] of options.options) session.setOption(name, value);
    await session.ready();
    const name = session.getName() ?? null;
    log.info(
      `readyok name="${name ?? ''}" eval=${entry.id} threads=${options.threads} hash=${options.hashMb}MB fvScale=${entry.fvScale}`,
    );
    return {
      session,
      name,
      threads: options.threads,
      hashMb: options.hashMb,
      dispose: () => {
        log.info('engine disposed');
        connection.dispose();
      },
    };
  } catch (error) {
    connection.dispose();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    patch({ phase: 'idle', download: null });
  }
}

export interface BrowserAnalysisOptions {
  mode: AnalysisMode;
  /** 棋譜の解析が一区切りした（段が 1 つ揃ったときも）。画面のデータを取り直す */
  onSettled(): void;
  /** 担当が変わった・ログインが切れた。`GET /api/me` を取り直す */
  onAccountChanged(): void;
}

async function main(
  options: BrowserAnalysisOptions,
  signal: AbortSignal,
): Promise<void> {
  // 止めた後に遅れて届く更新（ダウンロードの進捗など）で、止めた後の状態を書き換えない
  const patch: typeof patchBrowserAnalysisState = (next) => {
    if (!signal.aborted) patchBrowserAnalysisState(next);
  };

  const support = detectSupport(readBrowserEnv());
  if (!support.supported) {
    log.warn(`unsupported: ${support.reasons.join(', ')}`);
    patch({ phase: 'unsupported', unsupported: support.reasons });
    return;
  }

  const origin = window.location.origin;
  const manifest = await fetchEngineManifest(origin, (url, init) => fetch(url, init));
  if (signal.aborted) return;
  if (manifest === null) {
    log.warn('engine manifest not found (the engine is not deployed)');
    patch({ phase: 'no-engine', manifest: null });
    return;
  }
  patch({ manifest });
  // 🔒 同意の前に評価関数を落とし始めない（prd/14 §5.10）。同意は評価関数ごと（選んだエントリの nn.bin の sha256）。
  // エンジンの Worker もここより先でしか作らない
  const selected = engineEntryOf(manifest, getBrowserAnalysisSettings().evalId);
  if (currentChoice(manifest) === null) {
    log.info(
      `waiting for consent (eval ${selected.id} ${engineEntryDownloadBytes(selected)} bytes)`,
    );
    patch({ phase: 'needs-consent' });
    return;
  }

  log.info(
    `started mode=${options.mode} eval=${selected.id} build=${selected.engine.buildId} isolated=${String(globalThis.crossOriginIsolated)}`,
  );
  patch({ phase: 'idle' });

  const runner = createKifuRunner({
    api: runnerApi,
    // 評価関数の選択は常駐を作り直さずに読む（変えたら次の解析の開始で、エンジンを作り直して効かせる）。
    // 同意していない評価関数に切り替えたら null（解析を止めて同意を求める）
    currentEngine: () => currentChoice(manifest),
    // エンジンの読み込みは、棋譜の中断ではなく常駐の停止（`signal`）で止める
    createEngine: (settings, load, choice) =>
      createEngine(
        origin,
        engineEntryOf(manifest, choice.id),
        settings,
        load,
        signal,
        patch,
      ),
    // 負荷の設定は常駐を作り直さずに読む（変えたら次の解析の開始で、エンジンを作り直して効かせる）
    currentLoad: () => getBrowserAnalysisSettings().load,
    sleep,
    now: () => Date.now(),
    visibility: createVisibility(signal),
    onProgress: (progress) => {
      patch(
        progress
          ? { phase: 'analyzing', progress }
          : { phase: 'idle', progress: null },
      );
    },
    // quick が揃ったら、full の完了を待たずに画面のデータを取り直す（quick の結果を出す）
    onStageCompleted: () => options.onSettled(),
    log,
  });
  const scheduler = createScheduler({
    mode: options.mode,
    analyze: (kifuNo, kifuSignal, hooks) => runner.analyze(kifuNo, kifuSignal, hooks),
    pending: fetchPendingKifuNos,
    // ロックを取れたら `fn` を実行し、終わるまで持つ。待っている間に中断されたら AbortError で拒否される
    withLock: <T,>(lockSignal: AbortSignal, fn: () => Promise<T>) =>
      navigator.locks.request(LOCK_NAME, { signal: lockSignal }, fn) as Promise<T>,
    // 採点の読み: 印のロックを取ってから解析のロックを待つ（ほかのタブは印を見て、局面の境目で譲る）
    withPriorityLock: <T,>(lockSignal: AbortSignal, fn: () => Promise<T>) =>
      navigator.locks.request(PRIORITY_LOCK_NAME, { signal: lockSignal }, () =>
        navigator.locks.request(LOCK_NAME, { signal: lockSignal }, fn),
      ) as Promise<T>,
    priorityWaiting,
    sleep,
    now: () => Date.now(),
    log,
    onSettled: (kifuNo, outcome) => {
      log.info(`kifu #${kifuNo}: ${outcome.kind}`);
      options.onSettled();
    },
    onHalt: (outcome) => {
      if (outcome.reason === 'wrong-assignee' || outcome.reason === 'unauthorized') {
        options.onAccountChanged();
        return;
      }
      if (outcome.reason === 'needs-consent') {
        // 同意していない評価関数に切り替えた。同意されたら常駐が起動し直す（`BrowserAnalysisHost`）
        patch({ phase: 'needs-consent', progress: null });
        return;
      }
      patch({
        phase: 'error',
        error:
          outcome.reason === 'engine-load'
            ? `解析エンジンを読み込めませんでした（${outcome.detail}）`
            : outcome.detail,
      });
    },
  });

  // 出題の採点の読み（prd/13 §5.3）。全局面解析より先に、同じエンジンで読む
  const offGrader = setBrowserGrader((request) =>
    scheduler.runPriority(async () => {
      log.info(`drill: reading ${request.move} for ${request.settings.movetimeMs}ms`);
      const outcome = await runner.evaluateNamed(request);
      switch (outcome.kind) {
        case 'ok': {
          const { candidate } = outcome.evaluation;
          log.info(
            candidate
              ? `drill: ${request.move} score ${candidate.scoreType} ${candidate.scoreValue} depth ${candidate.depth}`
              : `drill: ${request.move} no candidate`,
          );
          break;
        }
        case 'mismatch':
          log.warn(`drill: the engine did not read ${request.move} (returned ${outcome.returned})`);
          break;
        case 'failed':
          log.warn(`drill: failed: ${outcome.detail}`);
          break;
      }
      return outcome;
    }),
  );
  const offFocus = onAnalysisFocusChange(scheduler.setFocus);
  const offPoke = onBrowserAnalysisPoke(scheduler.poke);
  scheduler.setFocus(getAnalysisFocus());
  try {
    await scheduler.run(signal);
  } finally {
    offGrader();
    offFocus();
    offPoke();
    runner.dispose();
    log.info('stopped');
  }
}

/**
 * 常駐の解析を起動する。返り値の関数で止める（エンジンも止まる）。
 * 設定（範囲・同意）が変わったら、止めて起動し直す。
 */
export function startBrowserAnalysis(options: BrowserAnalysisOptions): () => void {
  const controller = new AbortController();
  main(options, controller.signal).catch((error: unknown) => {
    if (controller.signal.aborted) return;
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`stopped by error: ${detail}`);
    patchBrowserAnalysisState({ phase: 'error', error: detail, progress: null });
  });
  return () => {
    controller.abort();
    resetBrowserAnalysisState();
  };
}
