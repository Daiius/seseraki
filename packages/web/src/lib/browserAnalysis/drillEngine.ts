/**
 * 詰将棋の判定をこのブラウザで読むための、担当 `worker` の端末の段取り（prd/13 §5.5）。
 *
 * 担当 `worker` の端末では常駐の解析が動かない（エンジンの一覧も取りに行かない。prd/14 §5.10）。詰将棋の判定のためだけに
 * エンジンを用意する常駐（`controller.ts` の `startDrillGrading`）を、**初めて詰将棋を解くとき（最初の 1 手を指したとき）**に
 * 起こし（{@link requestDrillEngine}）、評価関数のダウンロードに同意していなければその場で同意を求める（{@link askDrillEngineConsent}）。
 *
 * - 🔒 **同意を断ったら手元 worker で判定する**（解答の本文で「読めない」と申告する）。断ったことは**このタブの間だけ**覚える
 *   （次に開いたときにまた聞く。設定の画面には置かない）
 * - 同意は全局面解析と同じく評価関数ごと（端末の設定の `consentedEvalSha256s`。prd/14 §5.10）——同意すれば、後で担当を
 *   ブラウザに切り替えたときにも聞き直さない
 *
 * ⚠ このモジュールは出題の画面から読み込むので、エンジンや runner の実装を import しない。
 */
import { useSyncExternalStore } from 'react';
import { getBrowserAnalysisSettings, setBrowserAnalysisSettings, withConsent } from './settings';

export interface DrillEngineState {
  /** 判定だけの常駐を起こしてほしい（最初の 1 手を指した）。タブの間は落とさない */
  wanted: boolean;
  /** 同意を求めている（画面が案内を出す） */
  asking: boolean;
  /** このタブで同意を断った */
  declined: boolean;
}

let state: DrillEngineState = { wanted: false, asking: false, declined: false };
const listeners = new Set<() => void>();
/** 同意の答えを待っている呼び出し */
let waiters: ((agreed: boolean) => void)[] = [];

function patch(next: Partial<DrillEngineState>): void {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

export function getDrillEngineState(): DrillEngineState {
  return state;
}

export function subscribeDrillEngine(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDrillEngineState(): DrillEngineState {
  return useSyncExternalStore(subscribeDrillEngine, getDrillEngineState);
}

/** 詰将棋の最初の 1 手を指した。判定だけの常駐を起こす（何度呼んでもよい） */
export function requestDrillEngine(): void {
  if (!state.wanted) patch({ wanted: true });
}

/**
 * 同意を求め、答えを待つ。既に求めていればその答えを待つ。このタブで断っていれば聞かずに false
 */
export function askDrillEngineConsent(): Promise<boolean> {
  if (state.declined) return Promise.resolve(false);
  return new Promise((resolve) => {
    waiters.push(resolve);
    if (!state.asking) patch({ asking: true });
  });
}

/**
 * 同意の答え（案内のボタン）。同意なら評価関数（`nn.bin` の sha256）の同意を端末の設定に足す——
 * 判定だけの常駐が起動し直してエンジンを読み込む（`DrillGradingHost`）
 */
export function answerDrillEngineConsent(agreed: boolean, evalSha256: string | null): void {
  if (agreed && evalSha256) {
    setBrowserAnalysisSettings({
      consentedEvalSha256s: withConsent(getBrowserAnalysisSettings().consentedEvalSha256s, evalSha256),
    });
  }
  const resolved = waiters;
  waiters = [];
  patch({ asking: false, declined: !agreed });
  for (const resolve of resolved) resolve(agreed);
}

/** テスト用: 状態を最初に戻す */
export function resetDrillEngineForTest(): void {
  state = { wanted: false, asking: false, declined: false };
  waiters = [];
  listeners.clear();
}
