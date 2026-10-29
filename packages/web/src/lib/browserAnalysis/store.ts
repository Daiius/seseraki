/**
 * ブラウザ解析の、いまの状態（画面の表示用）。
 *
 * 🔒 **進捗は server に持たせない**（prd/14 §4.2・§5.8）。解析しているのはこのタブなので、
 * 進捗（解析中の局面数）・エンジンの準備の様子・解析できない理由は、ここ（タブの中のメモリ）にだけ置く。
 * 常駐の解析（`controller.ts`）が書き、画面（一覧・詳細・設定）が読む。
 */
import { useSyncExternalStore } from 'react';
import type { EngineManifest } from 'shared';
import type { LocalProgress } from './kifuAnalysis';
import type { UnsupportedReason } from './support';

export type BrowserAnalysisPhase =
  /** 動かしていない（担当がサーバー・未ログイン・起動の途中） */
  | 'off'
  /** この環境では解析できない（案内を出す） */
  | 'unsupported'
  /** エンジンが配信されていない */
  | 'no-engine'
  /** 評価関数のダウンロードに、まだ同意していない */
  | 'needs-consent'
  /** 解析する棋譜を待っている */
  | 'idle'
  /** エンジンを読み込んでいる（評価関数のダウンロードを含む） */
  | 'loading'
  /** 解析している */
  | 'analyzing'
  /** 止まった（エンジンを読み込めない・報告を送れない）。やり直しは利用者が押す */
  | 'error';

export interface BrowserAnalysisState {
  phase: BrowserAnalysisPhase;
  /** 配信されているエンジンの一覧（取得できたとき）。同意の画面とライセンスの表示に使う */
  manifest: EngineManifest | null;
  unsupported: readonly UnsupportedReason[];
  /** 評価関数の受信バイト数（`loading` の間） */
  download: { loaded: number; total: number } | null;
  /** 解析中の棋譜の進捗（`analyzing` の間） */
  progress: LocalProgress | null;
  /** `error` のときの文 */
  error: string | null;
  /** 「やり直す」が押された回数（常駐の解析を起動し直す合図） */
  restartNonce: number;
}

const INITIAL: BrowserAnalysisState = {
  phase: 'off',
  manifest: null,
  unsupported: [],
  download: null,
  progress: null,
  error: null,
  restartNonce: 0,
};

let state: BrowserAnalysisState = INITIAL;
const listeners = new Set<() => void>();

export function getBrowserAnalysisState(): BrowserAnalysisState {
  return state;
}

export function patchBrowserAnalysisState(
  patch: Partial<BrowserAnalysisState>,
): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

/** 動かしていない状態へ戻す（manifest とやり直しの回数は残す） */
export function resetBrowserAnalysisState(): void {
  patchBrowserAnalysisState({
    phase: 'off',
    unsupported: [],
    download: null,
    progress: null,
    error: null,
  });
}

/** 止まった解析をやり直す（`error` の画面のボタン） */
export function requestBrowserAnalysisRestart(): void {
  patchBrowserAnalysisState({ restartNonce: state.restartNonce + 1 });
}

/** 状態の変化を聞く（React の外から。返り値で外す） */
export function subscribeBrowserAnalysisState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBrowserAnalysisState(): BrowserAnalysisState {
  return useSyncExternalStore(subscribeBrowserAnalysisState, getBrowserAnalysisState);
}

// --- 開いている詳細ページの棋譜（解析の最優先。prd/14 §5.10）---

let focus: number | null = null;
const focusListeners = new Set<(kifuNo: number | null) => void>();
const pokeListeners = new Set<() => void>();

export function getAnalysisFocus(): number | null {
  return focus;
}

/** 詳細ページが、解析を待っている自分の棋譜を知らせる（離れるときは null） */
export function setAnalysisFocus(kifuNo: number | null): void {
  if (focus === kifuNo) return;
  focus = kifuNo;
  for (const listener of [...focusListeners]) listener(kifuNo);
}

export function onAnalysisFocusChange(
  listener: (kifuNo: number | null) => void,
): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}

/** 状況が変わったかもしれないことを知らせる（ページの移動など）。待機中の解析が次の棋譜を選び直す */
export function pokeBrowserAnalysis(): void {
  for (const listener of [...pokeListeners]) listener();
}

export function onBrowserAnalysisPoke(listener: () => void): () => void {
  pokeListeners.add(listener);
  return () => pokeListeners.delete(listener);
}
