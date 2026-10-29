/**
 * エンジンのホスト（classic の Worker）を起動し、評価関数を渡して `readyok` まで進める（prd/14 §5.5）。
 * runner の `createEngine` の実物（`controller.ts` が配線する）。スレッド数の決め方は `engineHost.ts` の純関数にある。
 */
import { engineHostUrl } from 'virtual:engine-host';
import {
  createUsiSession,
  engineEntryDownloadBytes,
  type EngineManifestEntry,
} from 'shared';
import { debugEnabled, LOG_PREFIX, log } from './browserDeps';
import type { AnalysisEngine, EngineSettings } from './engineCache';
import {
  connectEngineHost,
  engineOptions,
  initRequest,
  threadsFor,
  type HostWorkerLike,
} from './engineHost';
import { engineUrls } from './enginePaths';
import type { AnalysisLoad } from './settings';
import type { patchBrowserAnalysisState } from './store';

export interface CreateEngineParams {
  /** 配信物の URL の基準（`https://example.com`） */
  origin: string;
  /** 選んだ評価関数のエントリ */
  entry: EngineManifestEntry;
  settings: EngineSettings;
  load: AnalysisLoad;
  /** 常駐の停止。止めたら読み込みをやめる（棋譜の中断では止めない） */
  signal: AbortSignal;
  /** 読み込みの表示（ダウンロードの進捗） */
  patch: typeof patchBrowserAnalysisState;
  /** 固定のスレッド数（詰将棋の判定。prd/13 §5.5） */
  fixedThreads?: number;
}

export async function createEngine(params: CreateEngineParams): Promise<AnalysisEngine> {
  const { origin, entry, settings, load, signal, patch, fixedThreads } = params;
  // 止めた後に頼まれたら、Worker を起動しない（読み込みの表示も出さない）
  if (signal.aborted) throw new Error('解析は停止済みです');
  log.info(
    `loading engine eval=${entry.id} build=${entry.engine.buildId} nn=${entry.nn.sha256.slice(0, 16)} load=${load} host=${engineHostUrl}`,
  );
  patch({
    phase: 'loading',
    download: { loaded: 0, total: engineEntryDownloadBytes(entry) },
  });
  let worker: Worker | null = null;
  let connection: ReturnType<typeof connectEngineHost> | null = null;
  const onAbort = () => connection?.dispose();
  try {
    // 🔒 classic の Worker（`type: 'module'` を付けない）。ホストは importScripts でエンジンのグルーを読む
    // ⚠ 起動とつなぐところも try の中に置く（失敗したら Worker を残さない。下の catch）
    worker = new Worker(engineHostUrl, { name: 'seseraki-engine' });
    const connected = connectEngineHost(
      worker as unknown as HostWorkerLike,
      initRequest(entry, engineUrls(origin, entry)),
      {
        onDownload: (loaded, total) => patch({ download: { loaded, total } }),
      },
    );
    connection = connected;
    signal.addEventListener('abort', onAbort);
    await connected.ready;
    log.info('engine instantiated and eval loaded');
    const debug = debugEnabled();
    const session = createUsiSession(connected.transport, {
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
    const options = engineOptions(
      entry,
      settings,
      navigator.hardwareConcurrency,
      load,
      fixedThreads,
    );
    for (const [name, value] of options.options) session.setOption(name, value);
    await session.ready();
    const name = session.getName() ?? null;
    log.info(
      `readyok name="${name ?? ''}" eval=${entry.id} threads=${options.threads} hash=${options.hashMb}MB fvScale=${entry.fvScale}`,
    );
    let threads = options.threads;
    return {
      session,
      name,
      get threads() {
        return threads;
      },
      hashMb: options.hashMb,
      // 詰将棋の判定の固定のスレッド数（prd/13 §5.5）と、段ごとの上限（prd/14 §5.5。full は 4）。上流は setoption Threads で
      // その場でスレッドを作り直す（resize_threads。置換表も確保し直す）。isready で揃うのを待つ。評価関数は読み直さない
      setThreads: async (next, cap) => {
        const want = threadsFor({
          fixed: next,
          cap,
          createdSettings: settings,
          hardwareConcurrency: navigator.hardwareConcurrency,
          load,
        });
        if (want === threads) return;
        const started = Date.now();
        session.setOption('Threads', String(want));
        await session.ready();
        log.info(`threads ${threads} -> ${want} (${Date.now() - started}ms)`);
        threads = want;
      },
      dispose: () => {
        log.info('engine disposed');
        connected.dispose();
      },
    };
  } catch (error) {
    // つないだ後なら dispose（quit を送ってから止める）、つなぐ前に落ちたら Worker を直に止める
    if (connection) connection.dispose();
    else worker?.terminate();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    patch({ phase: 'idle', download: null });
  }
}
