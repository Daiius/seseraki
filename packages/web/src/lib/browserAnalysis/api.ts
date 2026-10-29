/**
 * ブラウザ解析の受け口（prd/14 §5.8）を呼ぶ。応答を {@link RunnerApi} の形（次にすることで分けた結果）にする。
 *
 * ⚠ 書き込みの口には Origin の検査がある。ブラウザは同一オリジンの POST に `Origin` を付けるので、
 * ここでは何もしない（付かない環境——信頼するオリジンに無い接続——では 403 になり、解析を止める）。
 */
import { client } from '../honoClient';
import {
  classifyFailureStatus,
  errorReportResultOf,
  type ChunkResult,
  type ErrorReportResult,
  type RunnerApi,
  type StartResult,
} from './apiResult';
import { pendingStatusKind, type PendingResult } from './scheduler';

function failure(
  status: number,
  what: string,
): Exclude<ChunkResult, { kind: 'ok' }> {
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

export const runnerApi: RunnerApi = {
  async start(kifuNo, engine): Promise<StartResult> {
    const res = await client.api.kifus[':no'].analysis.start.$post({
      param: { no: String(kifuNo) },
      json: engine,
    });
    if (res.status === 404) return { kind: 'skip', reason: 'not-found' };
    if (res.status === 409) return { kind: 'wrong-assignee' };
    if (!res.ok) {
      const failed = failure(res.status, '解析の開始');
      // 開始の本文は manifest の値だけ。拒否（400 など）は配信物の不整合なので、続けても直らない
      return failed.kind === 'rejected'
        ? { kind: 'fatal', detail: `解析を開始できません (${failed.status})` }
        : failed;
    }
    const body = await res.json();
    if (!('status' in body)) {
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
  },

  async submitChunk(kifuNo, chunk): Promise<ChunkResult> {
    const res = await client.api.kifus[':no'].analysis.chunks.$post({
      param: { no: String(kifuNo) },
      json: chunk,
    });
    if (!res.ok) return failure(res.status, '解析結果');
    const body = await res.json();
    if (!('applied' in body)) {
      return { kind: 'retry', detail: 'unexpected response' };
    }
    return {
      kind: 'ok',
      applied: body.applied,
      completed: body.completed,
      stageCompleted: body.stageCompleted,
    };
  },

  async reportError(kifuNo, body): Promise<ErrorReportResult> {
    const res = await client.api.kifus[':no'].analysis.error.$post({
      param: { no: String(kifuNo) },
      json: body,
    });
    if (!res.ok) return 'unsent';
    // ⚠ 破棄（古い世代・完了済み・担当違い）も 201 で返る。本文の `applied` を見る
    return errorReportResultOf(await res.json());
  },
};

/**
 * 未解析（full が未完了）の棋譜の番号（prd/14 §5.10「使用中は常に」）。**quick が未完了のものが先**、
 * それぞれ新しい順（並びは server が決める。web は段を推測しない）。
 * 401 はログイン切れとして返す（解析を止めて `GET /api/me` を取り直す）。それ以外の失敗は投げる
 */
export async function fetchPendingKifuNos(): Promise<PendingResult> {
  const res = await client.api.analysis.pending.$get({ query: {} });
  if (pendingStatusKind(res.status) === 'unauthorized') {
    return { kind: 'unauthorized' };
  }
  if (!res.ok) throw new Error(`status ${res.status}`);
  return { kind: 'ok', kifuNos: (await res.json()).kifuNos };
}
