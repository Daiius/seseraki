/**
 * ブラウザ解析の受け口（prd/14 §5.8）を呼ぶ。応答を {@link RunnerApi} の形（次にすることで分けた結果）にする。
 *
 * ⚠ 書き込みの口には Origin の検査がある。ブラウザは同一オリジンの POST に `Origin` を付けるので、
 * ここでは何もしない（付かない環境——信頼するオリジンに無い接続——では 403 になり、解析を止める）。
 */
import { client } from '../honoClient';
import {
  chunkResultOf,
  errorReportResultOf,
  startResultOf,
  type ErrorReportResult,
  type RunnerApi,
} from './apiResult';
import { pendingStatusKind, type PendingResult } from './scheduler';

// 振り分けは apiResult.ts の純関数（テストのある側）。ここは呼んで本文を渡すだけ
export const runnerApi: RunnerApi = {
  async start(kifuNo, engine) {
    const res = await client.api.kifus[':no'].analysis.start.$post({
      param: { no: String(kifuNo) },
      json: engine,
    });
    return startResultOf(res.status, res.ok ? await res.json() : undefined);
  },

  async submitChunk(kifuNo, chunk) {
    const res = await client.api.kifus[':no'].analysis.chunks.$post({
      param: { no: String(kifuNo) },
      json: chunk,
    });
    return chunkResultOf(res.status, res.ok ? await res.json() : undefined);
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
