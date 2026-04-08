import { hc } from "hono/client";
import type { AppType } from "server";
import type { KifuAnalysisResult } from "../kifu-analysis.js";

export function createClient(baseUrl: string, apiKey: string) {
  const client = hc<AppType>(baseUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return {
    /** 未解析の最古の棋譜を1件取得（なければ null） */
    async fetchNextKifu() {
      const res = await client.worker.kifus.$get();
      if (!res.ok) throw new Error(`Failed to fetch kifus: ${res.status}`);
      return await res.json();
    },

    /** 解析結果をサーバーに送信 */
    async submitAnalysis(kifuId: number, result: KifuAnalysisResult) {
      const res = await client.worker.analyses.$post({
        json: {
          kifuId,
          analyses: result.analyses.map((a) => ({
            moveNumber: a.moveNumber,
            movePlayed: a.movePlayed,
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
  };
}

export type WorkerClient = ReturnType<typeof createClient>;
