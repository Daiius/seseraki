/**
 * 出題の採点の読み（名指し評価。prd/13 §5.3・prd/14 §5.10）を、画面から常駐の解析へ頼む口。
 *
 * 解答の口が「この局面のこの手を名指しで読んで」（`status: 'evaluate'`）を返したら、出題の画面がここを呼ぶ。
 * 受け持ち手の待ち方・頼めない理由・頼み直しは `readerRegistry.ts`。
 *
 * ⚠ このモジュールは出題の画面から読み込むので、エンジンや runner の実装を import しない（型だけ）。
 */
import type { NamedEvalOutcome, NamedEvalRequest } from './engineReads';
import { requestWith, type ReaderDeps, type ReaderUnavailable } from './readerRegistry';

export type GradingResult = NamedEvalOutcome | ReaderUnavailable;

/** 出題の採点の読みを頼んだ結果（{@link requestBrowserGrading}）。`aborted` は頼んだ側が取り下げた */
export type GradingRequestResult = GradingResult | { kind: 'aborted' };

/**
 * 採点の読みを頼む（{@link requestWith}）。`signal` が中断されたら（解いている画面を離れた）、
 * 受け持ち手・同意・順番を待つのをやめて `aborted` を返す
 */
export async function requestBrowserGrading(
  request: NamedEvalRequest,
  deps: ReaderDeps,
  signal?: AbortSignal,
): Promise<GradingRequestResult> {
  if (signal?.aborted) return { kind: 'aborted' };
  return requestWith((reader) => reader.named(request, signal), deps, signal);
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
