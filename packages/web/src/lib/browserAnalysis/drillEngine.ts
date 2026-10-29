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
import { createConsentPrompt } from './consentPrompt';

export interface DrillEngineState {
  /** 判定だけの常駐を起こしてほしい（最初の 1 手を指した）。タブの間は落とさない */
  wanted: boolean;
  /** 同意を求めている（画面が案内を出す） */
  asking: boolean;
  /** このタブで同意を断った */
  declined: boolean;
}

/** 🔒 断ったらこのタブでは聞き直さない（判定は手元 worker に回る） */
const consent = createConsentPrompt({ rememberDecline: true });

let state: DrillEngineState = { wanted: false, ...consent.getState() };
const listeners = new Set<() => void>();

function patch(next: Partial<DrillEngineState>): void {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

/** 同意の案内の状態を、この段取りの状態に写す */
function followConsent(): void {
  consent.subscribe(() => patch(consent.getState()));
}
followConsent();

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
 * 同意を求め、答えを待つ。既に求めていればその答えを待つ。このタブで断っていれば聞かずに false。
 * `signal` が中断されたら（解いている画面を離れた）待つのをやめて false を返す——断ったことにはしない。
 * ほかに待つ呼び出しが無ければ案内も閉じる（次に開いた画面に、頼まれていない同意の案内が残らないように）
 */
export function askDrillEngineConsent(signal?: AbortSignal): Promise<boolean> {
  return consent.ask(signal);
}

/**
 * 同意の答え（案内のボタン）。同意なら評価関数（`nn.bin` の sha256）の同意を端末の設定に足す——
 * 判定だけの常駐が起動し直してエンジンを読み込む（`DrillGradingHost`）。sha256 が無ければ断ったものとして扱う
 */
export function answerDrillEngineConsent(agreed: boolean, evalSha256: string | null): void {
  consent.answer(agreed, evalSha256);
}

/** テスト用: 状態を最初に戻す */
export function resetDrillEngineForTest(): void {
  consent.reset();
  followConsent();
  state = { wanted: false, ...consent.getState() };
  listeners.clear();
}
