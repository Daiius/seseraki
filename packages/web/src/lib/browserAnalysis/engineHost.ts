/**
 * エンジンのホスト（Worker。`packages/web/engine-plugin/engine-host.js`）とのやり取りを、
 * shared の {@link UsiTransport} に包む（prd/14 §5.11）。
 *
 * 🔴 **WASM のエンジンは不正な指し手でプロセスごと終了する。** ホストはそれを `dead` のメッセージで伝え、
 * ここでは Worker の `error` と送信の例外も同じく**エンジンの死**として扱う。死んだ transport は使い回さない
 * ——呼び出し側は Worker ごと作り直す（遅れて届く行を次の探索に混ぜない）。
 */
import type { EngineManifest, UsiTransport } from 'shared';
import type { BrowserAnalysisSettings as ServerAnalysisSettings } from 'shared';
import type { EngineUrls } from './enginePaths';
import type { AnalysisLoad } from './settings';

/** ホストへ送るメッセージ */
export type HostRequest =
  | {
      type: 'init';
      glueUrl: string;
      baseUrl: string;
      exportName: string;
      evalUrl: string;
      evalBytes: number;
      evalSha256: string;
    }
  | { type: 'cmd'; line: string }
  | { type: 'quit' };

/** この接続が使う Worker の範囲（テストから偽物を差し込めるよう最小限に絞る） */
export interface HostWorkerLike {
  postMessage(message: HostRequest): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface EngineConnection {
  transport: UsiTransport;
  /** エンジンが起動し、評価関数を置き終えたら解決する。起動できなければ（死んだら）拒否する */
  ready: Promise<void>;
  /** エンジンを止めて Worker を閉じる。何度呼んでもよい */
  dispose(): void;
}

/** 投げられた値・イベントを Error にする（エンジンは Error でない値を投げる） */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'object' && thrown !== null && 'message' in thrown) {
    const { message } = thrown;
    if (typeof message === 'string' && message !== '') return new Error(message);
  }
  return new Error(typeof thrown === 'string' ? thrown : 'エンジンが停止しました');
}

export function initRequest(manifest: EngineManifest, urls: EngineUrls): HostRequest {
  return {
    type: 'init',
    glueUrl: urls.glue,
    baseUrl: urls.base,
    exportName: manifest.engine.exportName,
    evalUrl: urls.eval,
    evalBytes: manifest.eval.bytes,
    evalSha256: manifest.eval.sha256,
  };
}

/**
 * ホストの Worker につなぐ。`init` を送り、以後のメッセージを transport の聞き手へ配る。
 *
 * @param options.onDownload 評価関数の受信バイト数（進捗の表示用）
 * @param options.terminateDelayMs `dispose` で `quit` を送ってから Worker を強制終了するまでの猶予
 */
export function connectEngineHost(
  worker: HostWorkerLike,
  init: HostRequest,
  options: {
    onDownload?: (loaded: number, total: number) => void;
    setTimeout?: (callback: () => void, ms: number) => unknown;
    terminateDelayMs?: number;
  } = {},
): EngineConnection {
  let lineListener: ((line: string) => void) | null = null;
  let deathListener: ((error: Error) => void) | null = null;
  let death: Error | null = null;
  let disposed = false;

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // 待つ側がいないうちに死んでも「捕まえていない拒否」にしない
  ready.catch(() => {});

  const die = (error: Error) => {
    if (death) return;
    death = error;
    rejectReady(error);
    deathListener?.(error);
  };

  worker.onmessage = (event) => {
    const message = event.data as
      | { type: 'line'; line: string }
      | { type: 'download'; loaded: number; total: number }
      | { type: 'ready' }
      | { type: 'dead'; message: string }
      | null;
    if (!message || death || disposed) return;
    switch (message.type) {
      case 'line':
        lineListener?.(message.line);
        break;
      case 'download':
        options.onDownload?.(message.loaded, message.total);
        break;
      case 'ready':
        resolveReady();
        break;
      case 'dead':
        die(new Error(message.message));
        break;
    }
  };
  worker.onerror = (event) => die(toError(event));

  const post = (message: HostRequest) => {
    try {
      worker.postMessage(message);
    } catch (error) {
      const failure = toError(error);
      die(failure);
      throw failure;
    }
  };

  post(init);

  return {
    transport: {
      send(line) {
        if (death) throw death;
        if (disposed) throw new Error('エンジンは停止済みです');
        post({ type: 'cmd', line });
      },
      onLine(listener) {
        lineListener = listener;
      },
      onDeath(listener) {
        deathListener = listener;
        // 登録の前に死んでいたら、その場で伝える
        if (death) listener(death);
      },
    },
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      rejectReady(new Error('エンジンは停止済みです'));
      try {
        worker.postMessage({ type: 'quit' });
      } catch {
        // 既に死んでいる Worker への送信の失敗は無視する
      }
      // ホストが自分で閉じるのを少し待ってから、確実に止める（入れ子の Worker も一緒に止まる）
      const delay = options.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
      delay(() => worker.terminate(), options.terminateDelayMs ?? 500);
    },
  };
}

export interface EngineOptions {
  threads: number;
  hashMb: number;
  /** `setoption` に渡す名前と値（この順に送る） */
  options: [name: string, value: string][];
}

/**
 * スレッド数（prd/14 §5.10 負荷の設定）。
 * - 全力（`max`）: **論理コア数と server の上限の小さいほう**
 * - 控えめ（`gentle`）: 全力の半分（切り捨て・最低 1）
 * 論理コア数が分からなければ 1。
 */
export function analysisThreads(
  hardwareConcurrency: number | undefined,
  maxThreads: number,
  load: AnalysisLoad,
): number {
  const cores =
    typeof hardwareConcurrency === 'number' && hardwareConcurrency >= 1
      ? Math.floor(hardwareConcurrency)
      : 1;
  const full = Math.max(1, Math.min(cores, Math.floor(maxThreads)));
  return load === 'gentle' ? Math.max(1, Math.floor(full / 2)) : full;
}

/**
 * エンジンのオプション（prd/14 §5.5）。
 *
 * - 評価関数は仮想 FS のルートに `nn.bin` で置いてある（ホスト）ので、`EvalDir .` / `EvalFile nn.bin`
 * - `FV_SCALE` は manifest の値（手元 worker と同じ尺度にする。違うと悪手判定の閾値が合わない）
 * - スレッド数は負荷の設定で決まる（{@link analysisThreads}）
 * - 定跡は使わない（`BookFile no_book`）
 * - `ConsiderationMode true` は手元 worker と同じ（探索を打ち切ったときの読み筋を置換表から延ばす）
 */
export function engineOptions(
  manifest: Pick<EngineManifest, 'fvScale'>,
  settings: Pick<ServerAnalysisSettings, 'maxThreads' | 'hashMb'>,
  hardwareConcurrency: number | undefined,
  load: AnalysisLoad,
): EngineOptions {
  const threads = analysisThreads(hardwareConcurrency, settings.maxThreads, load);
  const hashMb = Math.max(1, Math.floor(settings.hashMb));
  return {
    threads,
    hashMb,
    options: [
      ['EvalDir', '.'],
      ['EvalFile', 'nn.bin'],
      ['FV_SCALE', String(manifest.fvScale)],
      ['Threads', String(threads)],
      ['USI_Hash', String(hashMb)],
      ['BookFile', 'no_book'],
      ['ConsiderationMode', 'true'],
    ],
  };
}
