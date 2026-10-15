/**
 * 出題の採点の読み（名指し評価。prd/13 §5.3・prd/14 §5.10）を、画面から常駐の解析へ頼む口。
 *
 * 解答の口が「この局面のこの手を名指しで読んで」（`status: 'evaluate'`）を返したら、出題の画面がここを呼ぶ。
 * 常駐の解析（`controller.ts`）が動いていれば、全局面解析より先に同じエンジンで読む。
 *
 * 🔒 **エンジンを使えない端末では読まない**（推測で判定しない）。同意の前・解析できない環境・エンジンが無い・止まっている、
 * のときは `unavailable` を返し、画面が「この端末では採点できない」旨を出す。
 *
 * ⚠ このモジュールは出題の画面からも読み込むので、エンジンや runner の実装を import しない（型だけ）。
 * 常駐の解析の本体は、動かすときにだけ読み込む（`components/BrowserAnalysis.tsx`）。
 */
import type { NamedEvalOutcome, NamedEvalRequest } from './runner';
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
  | 'off';

export type GradingResult =
  | NamedEvalOutcome
  | { kind: 'unavailable'; reason: GradingUnavailableReason };

type Grader = (request: NamedEvalRequest) => Promise<NamedEvalOutcome>;

let grader: Grader | null = null;
const graderListeners = new Set<() => void>();

/** 常駐の解析が、採点の読みを受け持つ（止めるときは返り値で外す） */
export function setBrowserGrader(next: Grader): () => void {
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
): Exclude<GradingUnavailableReason, 'off'> | null {
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = grader ?? (await waitForGrader(deps));
    if (typeof current === 'string') return { kind: 'unavailable', reason: current };
    try {
      return await current(request);
    } catch {
      // 常駐が止まった（SchedulerStoppedError）。起動し直すのを待って頼み直す
    }
  }
  return { kind: 'unavailable', reason: unavailableReasonOf(deps.getPhase()) ?? 'off' };
}

/** 受け持ち手が付くのを待つ。頼めない状態になった・時間切れなら理由を返す */
function waitForGrader(deps: GradingDeps): Promise<Grader | GradingUnavailableReason> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Grader | GradingUnavailableReason) => {
      if (settled) return;
      settled = true;
      deps.clearTimeout(timer);
      offPhase();
      graderListeners.delete(check);
      resolve(value);
    };
    const check = () => {
      if (grader) return finish(grader);
      const reason = unavailableReasonOf(deps.getPhase());
      if (reason) finish(reason);
    };
    const timer = deps.setTimeout(() => finish('off'), GRADER_WAIT_MS);
    const offPhase = deps.subscribe(check);
    graderListeners.add(check);
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
  }
}
