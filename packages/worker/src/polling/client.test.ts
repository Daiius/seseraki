import { describe, expect, it } from "vitest";
import { SubmitRejectedError, type UsiMoveAnalysis } from "shared";
import { createClient } from "./client.js";

interface Captured {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** 送った要求を記録し、決めた状態と本文で応える `fetch` */
function createFetch(status = 201, response: unknown = { ok: true, applied: true, completed: false }) {
  const requests: Captured[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const text = await request.text();
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: text ? JSON.parse(text) : undefined,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const PROVENANCE = { profile: "full" as const, engineName: "YaneuraOu", movetimeMs: 1000, targetDepth: null, multiPv: 3 };

describe("submitAnalysis の形の変換", () => {
  it("候補手を server の形（scoreType / scoreValue）に直し、来歴と世代を添える", async () => {
    const { fetch, requests } = createFetch();
    const client = createClient("http://server:4000", "secret", { fetch });
    const analyses: UsiMoveAnalysis[] = [
      {
        moveNumber: 0,
        candidates: [
          { rank: 1, move: "7g7f", score: { type: "cp", value: 30 }, pv: ["7g7f", "3c3d"], depth: 12 },
          { rank: 2, move: "2g2f", score: { type: "mate", value: -5 }, pv: ["2g2f"], depth: 12 },
        ],
      },
    ];

    await client.submitAnalysis(7, 3, analyses, PROVENANCE);

    expect(requests).toEqual([
      {
        method: "POST",
        url: "http://server:4000/api/worker/analyses",
        authorization: "Bearer secret",
        body: {
          kifuId: 7,
          revision: 3,
          ...PROVENANCE,
          analyses: [
            {
              moveNumber: 0,
              candidates: [
                { rank: 1, move: "7g7f", scoreType: "cp", scoreValue: 30, pv: ["7g7f", "3c3d"], depth: 12 },
                { rank: 2, move: "2g2f", scoreType: "mate", scoreValue: -5, pv: ["2g2f"], depth: 12 },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("数として読めない候補は送る前に落とし、欠番より後も落とす（400 で恒久失敗にさせない）", async () => {
    const { fetch, requests } = createFetch();
    const client = createClient("http://server:4000", "secret", { fetch });

    await client.submitAnalysis(
      7,
      3,
      [
        {
          moveNumber: 4,
          candidates: [
            { rank: 1, move: "7g7f", score: { type: "cp", value: 12.7 }, pv: ["7g7f"], depth: 10 },
            { rank: 2, move: "2g2f", score: { type: "cp", value: Number.NaN }, pv: ["2g2f"], depth: 10 },
            { rank: 3, move: "5i6h", score: { type: "cp", value: 1 }, pv: ["5i6h"], depth: 10 },
          ],
        },
      ],
      PROVENANCE,
    );

    const body = requests[0]?.body as { analyses: { candidates: { move: string; scoreValue: number }[] }[] };
    expect(body.analyses[0]?.candidates).toEqual([
      { rank: 1, move: "7g7f", scoreType: "cp", scoreValue: 12, pv: ["7g7f"], depth: 10 },
    ]);
  });

  it("入力の誤り（4xx）は SubmitRejectedError、API_KEY の誤り・5xx は一時失敗の Error", async () => {
    const submit = (status: number) =>
      createClient("http://server:4000", "secret", { fetch: createFetch(status, { error: "x" }).fetch }).submitAnalysis(
        7,
        3,
        [],
        PROVENANCE,
      );

    await expect(submit(400)).rejects.toBeInstanceOf(SubmitRejectedError);
    for (const status of [401, 429, 500, 503]) {
      const failure = submit(status);
      await expect(failure).rejects.toThrow(`Failed to submit analysis: ${status}`);
      await expect(failure).rejects.not.toBeInstanceOf(SubmitRejectedError);
    }
  });
});

describe("reportPositionResult の形の変換", () => {
  it("候補手を server の形に直す（`fallback` は送らない）", async () => {
    const { fetch, requests } = createFetch(201, { ok: true, applied: true });
    const client = createClient("http://server:4000", "secret", { fetch });

    await client.reportPositionResult("eval-1", {
      candidates: [{ rank: 1, move: "9g9f", score: { type: "cp", value: -20 }, pv: ["9g9f", "3c3d"], depth: 12 }],
    });

    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "http://server:4000/api/worker/position-jobs/eval-1/result",
      body: {
        candidates: [{ rank: 1, move: "9g9f", scoreType: "cp", scoreValue: -20, pv: ["9g9f", "3c3d"], depth: 12 }],
      },
    });
    expect(requests[0]?.body).not.toHaveProperty("fallback");
  });

  it("失敗はそのまま error で送る", async () => {
    const { fetch, requests } = createFetch(201, { ok: true, applied: true });
    const client = createClient("http://server:4000", "secret", { fetch });

    await client.reportPositionResult("eval-1", { error: "Named move was not searched" });

    expect(requests[0]?.body).toEqual({ error: "Named move was not searched" });
  });
});

describe("そのほかの口", () => {
  it("棋譜の取得は quick の設定の有無を query で伝える", async () => {
    const { fetch, requests } = createFetch(200, null);
    const client = createClient("http://server:4000", "secret", { fetch });

    await expect(client.fetchNextKifu(true)).resolves.toBeNull();
    await client.fetchNextKifu(false);

    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", "http://server:4000/api/worker/kifus?quick=1"],
      ["GET", "http://server:4000/api/worker/kifus?quick=0"],
    ]);
  });

  it("失敗の記録は棋譜の ID と世代を送る・失敗の応答は投げる", async () => {
    const { fetch, requests } = createFetch(201, { ok: true, applied: true });
    const client = createClient("http://server:4000", "secret", { fetch });

    await client.reportError(7, 3, "info string Error!");

    expect(requests[0]).toMatchObject({
      url: "http://server:4000/api/worker/kifus/7/error",
      body: { error: "info string Error!", revision: 3 },
    });
    const failing = createClient("http://server:4000", "secret", { fetch: createFetch(500, {}).fetch });
    await expect(failing.reportError(7, 3, "x")).rejects.toThrow("Failed to report error: 500");
  });
});
