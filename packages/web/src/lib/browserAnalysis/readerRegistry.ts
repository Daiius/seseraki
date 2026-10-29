/**
 * 常駐の解析が受け持つ読み（出題の採点の名指し評価・検討盤の局面評価）の登録所と、画面から頼むときの共通の段取り
 * （受け持ち手が付くのを待つ・頼めない理由・同意を求める・頼み直す）。prd/13 §5.3・prd/12 §2.4・prd/14 §5.10。
 *
 * 常駐の解析（`controller.ts`）が動いていれば受け持ち手を登録し（{@link setBrowserReader}）、画面は
 * 出題（`drillGrading.ts`）・検討盤（`studyEval.ts`）からここを通して頼む。全局面解析より先に同じエンジンで読む。
 *
 * 🔒 **エンジンを使えない端末では読まない**（推測で判定しない）。同意の前・解析できない環境・エンジンが無い・止まっている、
 * のときは `unavailable` を返し、画面が「この端末では読めない」旨を出す。
 *
 * ⚠ このモジュールは出題の画面・検討盤からも読み込むので、エンジンや runner の実装を import しない（型だけ。
 * `scheduler` からはエラーの型だけを読む——scheduler は runner を型でしか読まない）。
 * 常駐の解析の本体は、動かすときにだけ読み込む（`components/BrowserAnalysis.tsx`）。
 */
import type {
  NamedEvalOutcome,
  NamedEvalRequest,
  PositionEvalOutcome,
  PositionEvalRequest,
} from './engineReads';
import { SchedulerStoppedError } from './scheduler';
import type { BrowserAnalysisPhase } from './store';

/** 読みを頼めない理由（端末の状態） */
export type ReaderUnavailableReason =
  /** 解析エンジンのデータのダウンロードに、まだ同意していない */
  | 'needs-consent'
  /** この環境では解析できない */
  | 'unsupported'
  /** 解析エンジンが配信されていない */
  | 'no-engine'
  /** 常駐の解析が止まっている（エンジンを読み込めないなど） */
  | 'error'
  /** 常駐の解析が動いていない（待っても起動しなかった） */
  | 'off'
  /** ダウンロードを断った（詰将棋の判定の同意。prd/13 §5.5。判定は手元 worker に回る） */
  | 'declined';

/** 常駐の解析が受け持つ読み（どちらも全局面解析より先に、同じエンジンで読む） */
export interface BrowserReader {
  /** 出題の採点の名指しの読み。`signal` が中断されたら、順番を待っている読みを取り下げる（読み始めた読みは読み終える） */
  named(request: NamedEvalRequest, signal?: AbortSignal): Promise<NamedEvalOutcome>;
  /** 検討盤の局面評価。`signal` が中断されたら読まない・読みを打ち切る */
  position(request: PositionEvalRequest, signal: AbortSignal): Promise<PositionEvalOutcome>;
}

let registered: BrowserReader | null = null;
const readerListeners = new Set<() => void>();

/** 常駐の解析が、採点の読みと局面評価を受け持つ（止めるときは返り値で外す） */
export function setBrowserReader(next: BrowserReader): () => void {
  registered = next;
  for (const listener of [...readerListeners]) listener();
  return () => {
    if (registered !== next) return;
    registered = null;
    for (const listener of [...readerListeners]) listener();
  };
}

/**
 * 常駐の解析の状態から、読みを頼めない理由を決める。null は「頼める（か、じきに頼めるようになる）」
 * ——起動の途中（`off`）・待機中・読み込み中・解析中は、待てば受け持ち手が付く
 */
export function unavailableReasonOf(
  phase: BrowserAnalysisPhase,
): Exclude<ReaderUnavailableReason, 'off' | 'declined'> | null {
  switch (phase) {
    case 'needs-consent':
    case 'unsupported':
    case 'no-engine':
    case 'error':
      return phase;
    default:
      return null;
  }
}

/** 常駐の解析が起動するのを待つ時間（ページを開いた直後に頼んだとき） */
export const READER_WAIT_MS = 15_000;

export interface ReaderDeps {
  getPhase(): BrowserAnalysisPhase;
  /** 常駐の解析の状態の変化を聞く（返り値で外す） */
  subscribe(listener: () => void): () => void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /**
   * 同意の前（`needs-consent`）なら、利用者に同意を求めて答えを待つ（担当 `worker` の詰将棋の判定。prd/13 §5.5。担当 `browser` の検討盤の局面評価。prd/12 §2.4）。
   * true は同意した（常駐が起動し直すのを待って頼む）、false は断った（`declined`）。
   * 無ければ今までどおり、同意の前はすぐ `needs-consent` を返す（同意は画面の案内から）。
   * `signal` は頼んだ側の取り下げ（検討盤の局面評価。取り下げられたら案内を閉じてよい）
   */
  askConsent?(signal?: AbortSignal): Promise<boolean>;
}

/** 頼めないときの結果 */
export type ReaderUnavailable = { kind: 'unavailable'; reason: ReaderUnavailableReason };

/**
 * 受け持ち手に読みを頼む。受け持ち手がいればすぐ頼み、起動の途中なら {@link READER_WAIT_MS} まで待つ。
 * 端末の状態で頼めないとき・待っても受け持ち手が付かないときは `unavailable`。
 * 常駐が読み終える前に止まった（設定の変更で起動し直したなど）ら、もう一度受け持ち手を待って頼み直す。
 * `signal` が中断されたら、受け持ち手・同意・順番を待つのをやめて `aborted` を返す
 */
export async function requestWith<T>(
  read: (reader: BrowserReader) => Promise<T>,
  deps: ReaderDeps,
  signal?: AbortSignal,
): Promise<
  | T
  | ReaderUnavailable
  | { kind: 'aborted' }
  | { kind: 'failed'; detail: string }
> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = registered ?? (await waitForReader(deps, signal));
    if (current === ABORTED) return { kind: 'aborted' };
    if (typeof current === 'string') return { kind: 'unavailable', reason: current };
    try {
      return await read(current);
    } catch (error) {
      // 頼んだ側が取り下げた（待っている間に局面が変わった）
      if (signal?.aborted) return { kind: 'aborted' };
      // 常駐が止まった（SchedulerStoppedError）。起動し直すのを待って頼み直す
      if (error instanceof SchedulerStoppedError) continue;
      // それ以外は想定外の失敗。頼み直しても同じなので、失敗として返す（黙って握りつぶさない）
      const detail = error instanceof Error ? error.message : String(error);
      console.warn('[browser-analysis]', 'reading failed:', error);
      return { kind: 'failed', detail };
    }
  }
  return { kind: 'unavailable', reason: unavailableReasonOf(deps.getPhase()) ?? 'off' };
}

/** 待っている間に頼んだ側が取り下げた（{@link waitForReader}） */
const ABORTED = Symbol('aborted');

/**
 * 受け持ち手が付くのを待つ。頼めない状態になった・時間切れなら理由を返す。
 * 同意を求める（{@link ReaderDeps.askConsent}）間は時間切れを数えない——同意の後に起動を待ち直す。
 * `signal` が中断されたら {@link ABORTED}
 */
function waitForReader(
  deps: ReaderDeps,
  signal?: AbortSignal,
): Promise<BrowserReader | ReaderUnavailableReason | typeof ABORTED> {
  return new Promise((resolve) => {
    let settled = false;
    /** 同意を求めている（null）・同意した（true）。まだ求めていなければ false */
    let consent: boolean | null = false;
    let timer: unknown = null;
    /** 掛けたタイマーの通し番号（外したタイマーが遅れて発火しても数えない） */
    let timerGeneration = 0;
    const startTimer = () => {
      const generation = ++timerGeneration;
      timer = deps.setTimeout(() => {
        if (generation === timerGeneration) finish('off');
      }, READER_WAIT_MS);
    };
    const stopTimer = () => {
      timerGeneration++;
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    };
    const finish = (value: BrowserReader | ReaderUnavailableReason | typeof ABORTED) => {
      if (settled) return;
      settled = true;
      stopTimer();
      offPhase();
      readerListeners.delete(check);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(ABORTED);
    const check = () => {
      if (registered) return finish(registered);
      const reason = unavailableReasonOf(deps.getPhase());
      if (reason === 'needs-consent' && deps.askConsent) {
        // 同意した後は、常駐が起動し直すまで同意の前の状態が残る。求め直さずに待つ
        if (consent !== false) return;
        consent = null;
        stopTimer();
        deps.askConsent(signal).then(
          (agreed) => {
            if (!agreed) return finish('declined');
            consent = true;
            startTimer();
            check();
          },
          () => finish('declined'),
        );
        return;
      }
      if (reason) finish(reason);
    };
    startTimer();
    const offPhase = deps.subscribe(check);
    readerListeners.add(check);
    signal?.addEventListener('abort', onAbort);
    check();
  });
}
