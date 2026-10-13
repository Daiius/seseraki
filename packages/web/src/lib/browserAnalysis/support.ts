/**
 * ブラウザ解析が動く環境か（prd/14 §5.10）。
 *
 * 🔒 **動かない環境では解析せず、案内を出す。** 単一スレッド版のエンジンは配らない。
 * エンジンは pthread（SharedArrayBuffer）を使うので、ページが cross-origin isolated（COOP / COEP）で
 * なければならない。同じブラウザの中の解析を 1 本に絞るのに Web Locks も要る。
 */

export type UnsupportedReason =
  /** https（か localhost）でない。SharedArrayBuffer も Web Locks も使えない */
  | 'insecure-context'
  /** cross-origin isolated でない（COOP / COEP のヘッダが付いていない配信） */
  | 'not-isolated'
  | 'no-shared-array-buffer'
  | 'no-web-locks'
  | 'no-worker'
  | 'no-wasm';

export interface BrowserEnv {
  isSecureContext: boolean;
  crossOriginIsolated: boolean;
  hasSharedArrayBuffer: boolean;
  hasWebLocks: boolean;
  hasWorker: boolean;
  hasWasm: boolean;
}

export type Support =
  | { supported: true }
  | { supported: false; reasons: UnsupportedReason[] };

/** 環境の値から、動くかどうかと動かない理由を決める */
export function detectSupport(env: BrowserEnv): Support {
  const reasons: UnsupportedReason[] = [];
  if (!env.isSecureContext) reasons.push('insecure-context');
  if (!env.hasWorker) reasons.push('no-worker');
  if (!env.hasWasm) reasons.push('no-wasm');
  // secure context でなければ下の 3 つは必ず欠ける。理由を重ねて出さない
  if (env.isSecureContext) {
    if (!env.crossOriginIsolated) reasons.push('not-isolated');
    else if (!env.hasSharedArrayBuffer) reasons.push('no-shared-array-buffer');
    if (!env.hasWebLocks) reasons.push('no-web-locks');
  }
  return reasons.length === 0
    ? { supported: true }
    : { supported: false, reasons };
}

/** 画面に出す案内（理由は 1 つにまとめる。内部の用語は出さない） */
export function unsupportedMessage(reasons: readonly UnsupportedReason[]): string {
  if (reasons.includes('insecure-context')) {
    return 'この接続（https ではない接続）では、ブラウザでの解析は使えません。';
  }
  if (reasons.includes('not-isolated')) {
    return 'このページの配信の設定では、ブラウザでの解析は使えません。';
  }
  return 'このブラウザは、解析に必要な機能に対応していません。新しいブラウザでお試しください。';
}

/** 今のブラウザの値を読む（`globalThis` だけを見る。Worker の中でも呼べる） */
export function readBrowserEnv(): BrowserEnv {
  const g = globalThis as typeof globalThis & {
    isSecureContext?: boolean;
    crossOriginIsolated?: boolean;
  };
  return {
    isSecureContext: g.isSecureContext === true,
    crossOriginIsolated: g.crossOriginIsolated === true,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hasWebLocks:
      typeof navigator !== 'undefined' &&
      'locks' in navigator &&
      typeof navigator.locks?.request === 'function',
    hasWorker: typeof Worker !== 'undefined',
    hasWasm: typeof WebAssembly !== 'undefined',
  };
}
