/**
 * ブラウザ解析の受け口（prd/14 §5.8）の応答を、次にすることで分けた結果の型と、その分類。
 *
 * 呼ぶ側（`api.ts`）と使う側（`kifuAnalysis.ts`）の両方がここを読む。HTTP にも fetch にも触れない純粋な部分だけを置く。
 */
import {
  isPermanentSubmitStatus,
  type BrowserAnalysisChunk,
  type BrowserAnalysisRun,
  type BrowserAnalysisSettings,
} from 'shared';
import type { AnalysisProfile } from '../analysisProgress';

/** 開始の口の応答を、次にすることで分けたもの */
export type StartResult =
  | { kind: 'run'; run: BrowserAnalysisRun; profile: AnalysisProfile }
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

/** 4xx / 5xx を、口に依らない結果にする（`what` は 403 の文に使う） */
function failureOf(status: number, what: string): Exclude<ChunkResult, { kind: 'ok' }> {
  const kind = classifyFailureStatus(status);
  switch (kind) {
    case 'unauthorized':
      return { kind };
    case 'fatal':
      return { kind, detail: `${what}を送れません (${status})` };
    case 'rejected':
      return { kind, status };
    case 'retry':
      return { kind, detail: `status ${status}` };
  }
}

const isSuccess = (status: number) => status >= 200 && status < 300;

/** 本文に `status`（`kind`）を持たない応答（検証の失敗・エラーの本文）。届いたら想定外として再試行する */
type NoStatusBody = { status?: never };

/** 開始の口の 2xx の本文（server の `routes/browser-analysis.ts`） */
export type StartResponseBody =
  | {
      status: 'run';
      revision: number;
      profile: AnalysisProfile;
      startMoveNumber: number;
      usiMoves: string[];
      settings: BrowserAnalysisSettings;
    }
  | { status: 'complete' | 'failed' | 'unanalyzable' }
  | NoStatusBody;

/**
 * 開始の口の応答を、次にすることで分ける。本文は 2xx のときだけ読む（それ以外は undefined でよい）。
 * - 404 は棋譜が無い（skip）、409 は担当がブラウザでない
 * - 🔒 **開始の拒否（400 など）は fatal**——開始の本文は manifest の値だけなので、拒否は配信物の不整合。続けても直らない
 */
export function startResultOf(status: number, body: StartResponseBody | undefined): StartResult {
  if (status === 404) return { kind: 'skip', reason: 'not-found' };
  if (status === 409) return { kind: 'wrong-assignee' };
  if (!isSuccess(status)) {
    const failed = failureOf(status, '解析の開始');
    return failed.kind === 'rejected'
      ? { kind: 'fatal', detail: `解析を開始できません (${failed.status})` }
      : failed;
  }
  if (body === undefined || body.status === undefined) {
    return { kind: 'retry', detail: 'unexpected response' };
  }
  if (body.status === 'run') {
    return {
      kind: 'run',
      profile: body.profile,
      run: {
        revision: body.revision,
        startMoveNumber: body.startMoveNumber,
        usiMoves: body.usiMoves,
        settings: body.settings,
      },
    };
  }
  return { kind: 'skip', reason: body.status };
}

/** チャンクの報告の 2xx の本文（破棄も 201 `applied: false`） */
export type ChunkResponseBody =
  | { applied: boolean; completed: boolean; stageCompleted: boolean }
  | { applied?: never };

/** チャンクの報告の応答を、次にすることで分ける。本文は 2xx のときだけ読む */
export function chunkResultOf(status: number, body: ChunkResponseBody | undefined): ChunkResult {
  if (!isSuccess(status)) return failureOf(status, '解析結果');
  if (body === undefined || body.applied === undefined) {
    return { kind: 'retry', detail: 'unexpected response' };
  }
  return {
    kind: 'ok',
    applied: body.applied,
    completed: body.completed,
    stageCompleted: body.stageCompleted,
  };
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
