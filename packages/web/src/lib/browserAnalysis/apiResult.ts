/**
 * ブラウザ解析の受け口（prd/14 §5.8）の応答を、次にすることで分けた結果の型と、その分類。
 *
 * 呼ぶ側（`api.ts`）と使う側（`kifuAnalysis.ts`）の両方がここを読む。HTTP にも fetch にも触れない純粋な部分だけを置く。
 */
import {
  isPermanentSubmitStatus,
  type BrowserAnalysisChunk,
  type BrowserAnalysisRun,
} from 'shared';

/** 解析の段（prd/14 §5.7。server が決める） */
export type AnalysisStage = 'quick' | 'full';

/** 開始の口の応答を、次にすることで分けたもの */
export type StartResult =
  | { kind: 'run'; run: BrowserAnalysisRun; profile: AnalysisStage }
  /** 解析しない（解析済み・失敗の記録あり・指し手列が無い・棋譜が無い） */
  | { kind: 'skip'; reason: SkipReason }
  /** 担当がブラウザでない（409） */
  | { kind: 'wrong-assignee' }
  /** セッションが切れた（401） */
  | { kind: 'unauthorized' }
  /** 続けても直らない拒否（403 = Origin の検査など） */
  | { kind: 'fatal'; detail: string }
  /** 5xx・通信の失敗・混雑。後退して再試行する */
  | { kind: 'retry'; detail: string };

export type SkipReason = 'complete' | 'failed' | 'unanalyzable' | 'not-found';

export type ChunkResult =
  | {
      kind: 'ok';
      applied: boolean;
      /** full まで揃った（解析全体の完了） */
      completed: boolean;
      /** 届いたチャンクの段が揃った */
      stageCompleted: boolean;
    }
  /** 入力の誤りとして拒否された（4xx）。送り直しても変わらない */
  | { kind: 'rejected'; status: number }
  | { kind: 'unauthorized' }
  | { kind: 'fatal'; detail: string }
  | { kind: 'retry'; detail: string };

/**
 * HTTP ステータスを結果の種類にする（開始・チャンクの報告で共通の部分）。
 * 2xx と、口ごとに意味の違うステータス（開始の 404 / 409）は呼び出し側が先に見る。
 */
export function classifyFailureStatus(
  status: number,
): 'unauthorized' | 'fatal' | 'rejected' | 'retry' {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'fatal';
  return isPermanentSubmitStatus(status) ? 'rejected' : 'retry';
}

export type ErrorReportResult = 'recorded' | 'discarded' | 'unsent';

/** 失敗の報告の応答（201 の本文）を結果にする。`applied` が true のときだけ記録済み */
export function errorReportResultOf(body: unknown): ErrorReportResult {
  return typeof body === 'object' &&
    body !== null &&
    'applied' in body &&
    body.applied === true
    ? 'recorded'
    : 'discarded';
}

export interface RunnerApi {
  start(
    kifuNo: number,
    engine: { engineBuild: string; evalHash: string },
  ): Promise<StartResult>;
  submitChunk(kifuNo: number, chunk: BrowserAnalysisChunk): Promise<ChunkResult>;
  /**
   * 失敗を記録する。
   * - `recorded`: 記録された
   * - `discarded`: 破棄された（201 `applied: false`。世代が進んだ・別のタブが完了させた・担当が変わった）。
   *   🔒 **記録済みとして扱わない**——server に失敗は残っていないので、開始の口で今の状態を聞き直す
   * - `unsent`: 送れなかった（通信の失敗・4xx / 5xx）
   */
  reportError(
    kifuNo: number,
    body: { revision: number; error: string },
  ): Promise<ErrorReportResult>;
}
