/**
 * ブラウザ解析の常駐が使う、ブラウザの実物の依存（コンソール・ページの可視・Web Locks。待ちは `../abortableSleep.ts`）。
 * runner と scheduler には注入する形で渡す（`controller.ts`）。判断はここに書かない。
 *
 * コンソールに `[browser-analysis]` の接頭辞で経過を出す（実機での確認用）。
 * `localStorage['seseraki:browserAnalysis:debug'] = '1'` で、USI のやり取りと局面ごとの結果も出す。
 */
import type { RunnerLog } from './engineCache';
import type { Visibility } from './kifuAnalysis';

export const LOG_PREFIX = '[browser-analysis]';

export const log: RunnerLog = {
  info: (message) => console.info(LOG_PREFIX, message),
  warn: (message) => console.warn(LOG_PREFIX, message),
};

/** USI のやり取りもコンソールに出すか */
export function debugEnabled(): boolean {
  try {
    return localStorage.getItem('seseraki:browserAnalysis:debug') === '1';
  } catch {
    return false;
  }
}

/** ページの可視（スマホはバックグラウンドで凍結する。その間の失敗を数えないために見る）。`signal` で聞き手を外す */
export function createVisibility(signal: AbortSignal): Visibility {
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

/** 同じブラウザの中の解析を 1 本に絞るロックの名前 */
const LOCK_NAME = 'seseraki:browser-analysis';
/**
 * 採点の読みが待っている印のロック（prd/14 §5.10）。採点の読みはこれを取ってから {@link LOCK_NAME} を待つ。
 * ほかのタブの解析は、局面の境目でこれが取られている（待たれている）のを見て譲る
 */
const PRIORITY_LOCK_NAME = 'seseraki:browser-analysis:drill';

/** ロックを取れたら `fn` を実行し、終わるまで持つ。待っている間に中断されたら AbortError で拒否される */
export function withAnalysisLock<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request(LOCK_NAME, { signal }, fn) as Promise<T>;
}

/** 採点の読み: 印のロックを取ってから解析のロックを待つ（ほかのタブは印を見て、局面の境目で譲る） */
export function withPriorityLock<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request(PRIORITY_LOCK_NAME, { signal }, () =>
    navigator.locks.request(LOCK_NAME, { signal }, fn),
  ) as Promise<T>;
}

/** ほかのタブで採点の読みが待っているか（Web Locks の照会） */
export async function priorityWaiting(): Promise<boolean> {
  const snapshot = await navigator.locks.query();
  return [...(snapshot.held ?? []), ...(snapshot.pending ?? [])].some(
    (lock) => lock.name === PRIORITY_LOCK_NAME,
  );
}
