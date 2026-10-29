/**
 * 検討盤の局面評価をこのブラウザのエンジンで読む（担当 `browser` の利用者。prd/12 §2.4・prd/14 §5.1）。
 *
 * 🔒 **画面で完結させる。** 結果は server に送らず、保存もしない（server に新しい口は作らない。
 * `POST /api/positions/evaluate` は担当 `browser` に 403 のまま）。返すのは server の口と同じ `EvalResult` で、
 * 検討盤（`useStudyEval.ts` の `run()`）は出所を気にせず同じ表示・同じ直前の手の採点（`gradeLastMove`）に流す。
 *
 * - **棋譜解析の再利用はしない**（prd/12 §2.6 は server の判定）。ブラウザの全局面解析は MultiPV 1 なので、
 *   候補手 3 本を返す局面評価の再利用にはもともと当たらない。毎回その場で読み、出所は `engine`
 * - 読むのは常駐の解析（`controller.ts`）が持つエンジン。全局面解析より先に読む（出題の採点の読みと同じ割り込み。`readerRegistry.ts`）
 * - 🔒 **ダウンロードに同意していなければ、押した時点で同意を求める**（{@link askStudyEvalConsent}。出題の詰将棋の判定と同じ導線）。
 *   断っても覚えない（次に押したらまた聞く）——押すこと自体が「評価したい」という明示の操作なので
 *
 * ⚠ このモジュールは検討盤から読み込むので、エンジンや runner の実装を import しない（型だけ）。
 */
import { useSyncExternalStore } from 'react';
import { BROWSER_ANALYSIS_LIMITS } from 'shared';
import type { EvalResult } from '../positionEval';
import { validateEvalTarget } from '../positionEval';
import type { EvalTarget } from '../study';
import type { PositionEvalOutcome, PositionEvalRequest, PositionEvalSettings } from './engineReads';
import {
  requestWith,
  type ReaderDeps,
  type ReaderUnavailable,
  type ReaderUnavailableReason,
} from './readerRegistry';
import { getBrowserAnalysisSettings, setBrowserAnalysisSettings, withConsent } from './settings';
import { getBrowserAnalysisState, subscribeBrowserAnalysisState } from './store';

/**
 * 局面評価の読み方（prd/12 §2.4。2026-10-29 決定）。🔒 **web の定数に置く**——server を経由しないので、server が決めて渡す経路が無い。
 *
 * - **候補手 3 本**（MultiPV 3。prd/12 §2.2 の契約。手元 worker の局面評価と同じ本数）
 * - **1000ms**（手元 worker の局面評価の思考時間 `ENGINE_MOVETIME` と同じ長さ）
 * - **スレッドは最大 4**（負荷「控えめ」ならその半分の 2）。全局面解析の full の段と同じ決め方（prd/14 §5.5）
 * - ⚠ `maxThreads` と `hashMb` は全局面解析の値（server の `BROWSER_ANALYSIS_SETTINGS`）とそろえる。違うと、全局面解析と共用の
 *   エンジンを局面評価のたびに作り直す（評価関数の読み込みからになる）。server の値を変えたら、ここも合わせる
 */
export const STUDY_EVAL_SETTINGS: PositionEvalSettings = {
  multiPv: 3,
  movetimeMs: 1000,
  stageMaxThreads: 4,
  maxThreads: 8,
  hashMb: 64,
  pvMaxPlies: BROWSER_ANALYSIS_LIMITS.pvMaxPlies,
};

/** 検討盤の局面評価の結果（{@link requestBrowserPositionEval}） */
export type PositionReadingResult = PositionEvalOutcome | ReaderUnavailable;

/**
 * 検討盤の局面評価を頼む（prd/12 §2.4。担当 `browser` の利用者）。受け持ち手の待ち方・頼めない理由・頼み直しは
 * 出題の採点の読みと同じ（`readerRegistry.ts` の {@link requestWith}）。`signal` が中断されたら（局面が変わった）、待つのをやめて `aborted` を返す
 */
export async function requestBrowserPositionEval(
  request: PositionEvalRequest,
  signal: AbortSignal,
  deps: ReaderDeps,
): Promise<PositionReadingResult> {
  if (signal.aborted) return { kind: 'aborted' };
  return requestWith((reader) => reader.position(request, signal), deps, signal);
}


/**
 * 局面評価をこのブラウザで読み、検討盤の `EvalResult` にする。**例外は投げない**（`requestPositionEval` と同じ）。
 * 局面が変わったら（`signal` の中断）、待ち・同意の案内・読みをやめて `aborted`（画面には何も出さない）
 */
export async function requestBrowserStudyEval(
  target: EvalTarget,
  signal: AbortSignal,
): Promise<EvalResult> {
  // 🔒 **エンジンに渡す前に検証する**（prd/12 §2.5）。server の口を通らないので、ここが唯一の関門
  // （呼び出し側も送る前に同じ検証を掛けているが、エンジンを落とさないための守りはここで閉じる）
  const violations = validateEvalTarget(target.from, target.move);
  if (violations.length > 0) return { kind: 'invalid', violations };
  if (target.move !== null) return { kind: 'failed', message: '指し手を名指しした評価には対応していません' };

  // 同意の案内は、この要求が終わったら（読めた・読めなかった・取り下げ）必ず閉じる。
  // 待つ間にほかの案内（棋譜の詳細の「ダウンロードして解析する」）から同意されて先へ進んだときに、案内だけが残らないように
  const consent = new AbortController();
  const withdraw = () => consent.abort();
  signal.addEventListener('abort', withdraw, { once: true });
  let result;
  try {
    result = await requestBrowserPositionEval(
      { sfen: target.sfen, settings: STUDY_EVAL_SETTINGS },
      signal,
      {
        getPhase: () => getBrowserAnalysisState().phase,
        subscribe: subscribeBrowserAnalysisState,
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        askConsent: () => askStudyEvalConsent(consent.signal),
      },
    );
  } finally {
    signal.removeEventListener('abort', withdraw);
    consent.abort();
  }
  switch (result.kind) {
    case 'ok':
      return {
        kind: 'done',
        candidates: result.candidates,
        source: 'engine',
        fallback: false,
        evaluatedAt: new Date().toISOString(),
      };
    case 'aborted':
      return { kind: 'aborted' };
    case 'failed':
      return { kind: 'failed', message: `この局面を評価できませんでした（${result.detail}）` };
    case 'unavailable':
      return { kind: 'failed', message: studyEvalUnavailableMessage(result.reason) };
  }
}

/** このブラウザで評価できない理由の文（画面に出す）。🔒 内部の用語（担当・MultiPV）は出さない */
export function studyEvalUnavailableMessage(reason: ReaderUnavailableReason): string {
  switch (reason) {
    case 'needs-consent':
    case 'declined':
      return 'この局面を評価するには、解析エンジンのデータをダウンロードしてください。';
    case 'unsupported':
      return 'この端末（ブラウザ）では、局面を評価できません。';
    case 'no-engine':
      return '解析エンジンが配置されていないため、局面を評価できません。';
    case 'error':
      return '解析エンジンが止まっているため、局面を評価できません。';
    case 'off':
      return 'この端末では、局面を評価できません（解析エンジンを起動できませんでした）。';
  }
}

// --- ダウンロードの同意（押した時点で求める）---

let asking = false;
const listeners = new Set<() => void>();
/** 同意の答えを待っている呼び出し */
let waiters: ((agreed: boolean) => void)[] = [];
/** 案内を出している間だけ、常駐の解析の状態を聞く（{@link setAsking}） */
let offPhase: (() => void) | null = null;

function setAsking(next: boolean): void {
  if (asking === next) return;
  asking = next;
  offPhase?.();
  offPhase = null;
  if (next) {
    // ほかの案内（棋譜の詳細の「ダウンロードして解析する」・設定のページ）から同意された。常駐が起動し直して
    // 同意の前の状態を抜けるので、同意したものとして答える（案内を閉じる）
    offPhase = subscribeBrowserAnalysisState(() => {
      if (getBrowserAnalysisState().phase !== 'needs-consent') resolveAll(true);
    });
  }
  for (const listener of [...listeners]) listener();
}

function resolveAll(agreed: boolean): void {
  const resolved = waiters;
  waiters = [];
  setAsking(false);
  for (const resolve of resolved) resolve(agreed);
}

/** 同意を求めているか（画面が案内を出す） */
export function isAskingStudyEvalConsent(): boolean {
  return asking;
}

export function subscribeStudyEvalConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStudyEvalConsentAsking(): boolean {
  return useSyncExternalStore(subscribeStudyEvalConsent, isAskingStudyEvalConsent);
}

/**
 * 同意を求め、答えを待つ。既に求めていればその答えを待つ。
 * `signal` が中断されたら（局面が変わった）false で返し、ほかに待つ呼び出しが無ければ案内を閉じる
 */
export function askStudyEvalConsent(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const waiter = (agreed: boolean) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(agreed);
    };
    const onAbort = () => {
      waiters = waiters.filter((w) => w !== waiter);
      if (waiters.length === 0) setAsking(false);
      resolve(false);
    };
    waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    setAsking(true);
  });
}

/**
 * 同意の答え（案内のボタン）。同意なら評価関数（`nn.bin` の sha256）の同意を端末の設定に足す——常駐の解析が
 * 起動し直してエンジンを読み込む（`BrowserAnalysisHost`。全局面解析の同意と同じもの）
 */
export function answerStudyEvalConsent(agreed: boolean, evalSha256: string | null): void {
  if (agreed && evalSha256) {
    setBrowserAnalysisSettings({
      consentedEvalSha256s: withConsent(getBrowserAnalysisSettings().consentedEvalSha256s, evalSha256),
    });
  }
  resolveAll(agreed);
}

/** テスト用: 状態を最初に戻す */
export function resetStudyEvalConsentForTest(): void {
  offPhase?.();
  offPhase = null;
  asking = false;
  waiters = [];
  listeners.clear();
}
