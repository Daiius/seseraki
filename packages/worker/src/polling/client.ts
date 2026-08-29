import { hc } from "hono/client";
import type { AppType } from "server";
import type { MoveAnalysis } from "../kifu-analysis.js";
import type { PositionEvalJob, PositionEvalResult } from "../position-eval.js";

export function createClient(baseUrl: string, apiKey: string) {
  // server は basePath('/api') 配下。worker は server を直叩きするので baseUrl は
  // SERVER_URL のまま、呼び出しで `client.api.worker.*` と basePath を明示する
  // （実 URL は `${SERVER_URL}/api/worker/...` になる）。
  const client = hc<AppType>(baseUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return {
    /**
     * 未解析の最古の棋譜を1件取得（なければ null）。
     * `analyzedCount` は既に server に入っている局面数＝解析を再開する局面番号。
     */
    async fetchNextKifu() {
      const res = await client.api.worker.kifus.$get();
      if (!res.ok) throw new Error(`Failed to fetch kifus: ${res.status}`);
      return await res.json();
    },

    /**
     * 解析結果のチャンクをサーバーに送信（revision = 取得時の解析世代）。
     * server は追記 upsert し、全局面が揃った時点で完了を確定する（`{ applied, completed }` を返す）。
     */
    async submitAnalysis(
      kifuId: number,
      revision: number,
      analyses: MoveAnalysis[],
    ) {
      const res = await client.api.worker.analyses.$post({
        json: {
          kifuId,
          revision,
          analyses: analyses.map((a) => ({
            moveNumber: a.moveNumber,
            candidates: a.candidates.map((c) => ({
              rank: c.rank,
              move: c.move,
              scoreType: c.score.type,
              scoreValue: c.score.value,
              pv: c.pv,
              depth: c.depth,
            })),
          })),
        },
      });
      if (!res.ok) throw new Error(`Failed to submit analysis: ${res.status}`);
      return await res.json();
    },

    /**
     * 解析の進捗を報告する（revision = 取得時の解析世代）。
     * server 側はメモリに載せるだけで DB を書かない。呼び出し側は失敗を握りつぶす（解析を止めない）。
     */
    async reportProgress(
      kifuId: number,
      revision: number,
      analyzed: number,
      total: number,
    ) {
      const res = await client.api.worker.analyses.progress.$post({
        json: { kifuId, revision, analyzed, total },
      });
      if (!res.ok) throw new Error(`Failed to report progress: ${res.status}`);
      return await res.json();
    },

    /**
     * 検討局面の評価ジョブを 1 件取る（無ければ null。prd/12 §2.1）。
     * 棋譜解析の局面境界と、棋譜が無いときの poll から叩く。
     */
    async claimPositionJob(): Promise<PositionEvalJob | null> {
      const res = await client.api.worker["position-jobs"].$get();
      if (!res.ok) throw new Error(`Failed to claim position job: ${res.status}`);
      return await res.json();
    },

    /**
     * 評価結果 or 失敗を報告する（**失敗も完了**。要求側が取りに来る結果になる）。
     * 🔒 棋譜の analysisError / analysisRevision には触れない（prd/12 §2.5）。
     */
    async reportPositionResult(
      id: string,
      report: PositionEvalResult | { error: string },
    ) {
      const json =
        "error" in report
          ? { error: report.error }
          : {
              fallback: report.fallback,
              // 予算は「検出なし」の意味を決める値なので結果と一緒に運ぶ（設計 §2.7）
              budget: report.budget,
              candidates: report.candidates.map((c) => ({
                rank: c.rank,
                move: c.move,
                scoreType: c.score.type,
                scoreValue: c.score.value,
                pv: c.pv,
                depth: c.depth,
              })),
            };
      const res = await client.api.worker["position-jobs"][":id"].result.$post({
        param: { id },
        json,
      });
      if (!res.ok) {
        throw new Error(`Failed to report position result: ${res.status}`);
      }
      return await res.json();
    },

    /** 解析失敗（棋譜起因）を報告し analysisError を記録させる（revision = 取得時の解析世代） */
    async reportError(kifuId: number, revision: number, error: string) {
      const res = await client.api.worker.kifus[":id"].error.$post({
        param: { id: String(kifuId) },
        json: { error, revision },
      });
      if (!res.ok) throw new Error(`Failed to report error: ${res.status}`);
      return await res.json();
    },
  };
}

export type WorkerClient = ReturnType<typeof createClient>;
