/**
 * 出題の採点の読み（名指し評価。prd/13 §5.3・prd/14 §5.10）と検討盤の局面評価（prd/12 §2.4）を、画面から常駐の解析へ頼む口。
 *
 * 解答の口が「この局面のこの手を名指しで読んで」（`status: 'evaluate'`）を返したら、出題の画面がここを呼ぶ。
 * 担当 `browser` の利用者が検討盤で「評価する」を押したら、検討盤がここを呼ぶ（`studyEval.ts`）。
 * 常駐の解析（`controller.ts`）が動いていれば、全局面解析より先に同じエンジンで読む。
 *
 * 🔒 **エンジンを使えない端末では読まない**（推測で判定しない）。同意の前・解析できない環境・エンジンが無い・止まっている、
 * のときは `unavailable` を返し、画面が「この端末では採点できない」旨を出す。
 *
 * ⚠ このモジュールは出題の画面からも読み込むので、エンジンや runner の実装を import しない（型だけ）。
 * 常駐の解析の本体は、動かすときにだけ読み込む（`components/BrowserAnalysis.tsx`）。
 */
import type {
  NamedEvalOutcome,
  NamedEvalRequest,
  PositionEvalOutcome,
  PositionEvalRequest,
} from './runner';
import type { BrowserAnalysisPhase } from './store';

/** 採点の読みを頼めない理由（端末の状態） */
export type GradingUnavailableReason =
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

export type GradingResult =
  | NamedEvalOutcome
  | { kind: 'unavailable'; reason: GradingUnavailableReason };

/** 検討盤の局面評価の結果（{@link requestBrowserPositionEval}） */
export type PositionReadingResult =
  | PositionEvalOutcome
  | { kind: 'unavailable'; reason: GradingUnavailableReason };

/** 常駐の解析が受け持つ読み（どちらも全局面解析より先に、同じエンジンで読む） */
export interface BrowserReader {
  /** 出題の採点の名指しの読み */
  named(request: NamedEvalRequest): Promise<NamedEvalOutcome>;
  /** 検討盤の局面評価。`signal` が中断されたら読まない・読みを打ち切る */
  position(request: PositionEvalRequest, signal: AbortSignal): Promise<PositionEvalOutcome>;
}

let grader: BrowserReader | null = null;
const graderListeners = new Set<() => void>();

/** 常駐の解析が、採点の読みと局面評価を受け持つ（止めるときは返り値で外す） */
export function setBrowserReader(next: BrowserReader): () => void {
  grader = next;
  for (const listener of [...graderListeners]) listener();
  return () => {
    if (grader !== next) return;
    grader = null;
    for (const listener of [...graderListeners]) listener();
  };
}

/**
 * 常駐の解析の状態から、採点の読みを頼めない理由を決める。null は「頼める（か、じきに頼めるようになる）」
 * ——起動の途中（`off`）・待機中・読み込み中・解析中は、待てば受け持ち手が付く
 */
export function unavailableReasonOf(
  phase: BrowserAnalysisPhase,
): Exclude<GradingUnavailableReason, 'off' | 'declined'> | null {
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

/** 常駐の解析が起動するのを待つ時間（ページを開いた直後に答えたとき） */
export const GRADER_WAIT_MS = 15_000;

export interface GradingDeps {
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

/**
 * 採点の読みを頼む。受け持ち手（常駐の解析）がいればすぐ頼み、起動の途中なら {@link GRADER_WAIT_MS} まで待つ。
 * 端末の状態で頼めないとき・待っても受け持ち手が付かないときは `unavailable`。
 * 常駐が読み終える前に止まった（設定の変更で起動し直したなど）ら、もう一度受け持ち手を待って頼み直す
 */
export async function requestBrowserGrading(
  request: NamedEvalRequest,
  deps: GradingDeps,
): Promise<GradingResult> {
  const result = await requestWith((reader) => reader.named(request), deps);
  // 取り下げの合図（signal）を渡していないので aborted は返らない（型を閉じるだけ）
  return result.kind === 'aborted' ? { kind: 'unavailable', reason: 'off' } : result;
}

/**
 * 検討盤の局面評価を頼む（prd/12 §2.4。担当 `browser` の利用者）。受け持ち手の待ち方・頼めない理由・頼み直しは
 * {@link requestBrowserGrading} と同じ。`signal` が中断されたら（局面が変わった）、待つのをやめて `aborted` を返す
 */
export async function requestBrowserPositionEval(
  request: PositionEvalRequest,
  signal: AbortSignal,
  deps: GradingDeps,
): Promise<PositionReadingResult> {
  if (signal.aborted) return { kind: 'aborted' };
  return requestWith((reader) => reader.position(request, signal), deps, signal);
}

async function requestWith<T>(
  read: (reader: BrowserReader) => Promise<T>,
  deps: GradingDeps,
  signal?: AbortSignal,
): Promise<T | { kind: 'unavailable'; reason: GradingUnavailableReason } | { kind: 'aborted' }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = grader ?? (await waitForGrader(deps, signal));
    if (current === ABORTED) return { kind: 'aborted' };
    if (typeof current === 'string') return { kind: 'unavailable', reason: current };
    try {
      return await read(current);
    } catch {
      // 常駐が止まった（SchedulerStoppedError）。起動し直すのを待って頼み直す
    }
  }
  return { kind: 'unavailable', reason: unavailableReasonOf(deps.getPhase()) ?? 'off' };
}

/** 待っている間に頼んだ側が取り下げた（{@link waitForGrader}） */
const ABORTED = Symbol('aborted');

/**
 * 受け持ち手が付くのを待つ。頼めない状態になった・時間切れなら理由を返す。
 * 同意を求める（{@link GradingDeps.askConsent}）間は時間切れを数えない——同意の後に起動を待ち直す。
 * `signal` が中断されたら {@link ABORTED}
 */
function waitForGrader(
  deps: GradingDeps,
  signal?: AbortSignal,
): Promise<BrowserReader | GradingUnavailableReason | typeof ABORTED> {
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
      }, GRADER_WAIT_MS);
    };
    const stopTimer = () => {
      timerGeneration++;
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    };
    const finish = (value: BrowserReader | GradingUnavailableReason | typeof ABORTED) => {
      if (settled) return;
      settled = true;
      stopTimer();
      offPhase();
      graderListeners.delete(check);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(ABORTED);
    const check = () => {
      if (grader) return finish(grader);
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
    graderListeners.add(check);
    signal?.addEventListener('abort', onAbort);
    check();
  });
}

/**
 * 採点できなかったときの文（画面に出す）。🔒 内部の用語（担当・名指し・段）は出さない
 */
export function gradingFailureMessage(
  result: Exclude<GradingResult, { kind: 'ok' }>,
): string {
  if (result.kind === 'mismatch') return 'この手は採点できませんでした。';
  if (result.kind === 'failed') return `この手を採点できませんでした（${result.detail}）。`;
  switch (result.reason) {
    case 'needs-consent':
      return 'この手を採点するには、解析エンジンのデータをダウンロードしてください。';
    case 'unsupported':
      return 'この端末（ブラウザ）では、この手を採点できません。';
    case 'no-engine':
      return '解析エンジンが配置されていないため、この手を採点できません。';
    case 'error':
      return '解析エンジンが止まっているため、この手を採点できません。';
    case 'off':
      return 'この端末では、この手を採点できません（解析エンジンを起動できませんでした）。';
    case 'declined':
      return 'この端末では、この手を採点できません（解析エンジンのデータをダウンロードしていません）。';
  }
}
