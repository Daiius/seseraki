import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmitRejectedError, type UsiSearchResult } from "shared";
import type { Config } from "./config.js";
import { createPoller, type PollClient, type PollEngine } from "./poll.js";
import type { PositionEvalJob } from "./position-eval.js";

const config: Config = {
  enginePath: "/usr/local/bin/yaneuraou",
  engineThreads: 1,
  engineDepth: 10,
  engineMovetime: 1000,
  engineQuickMovetime: undefined,
  engineQuickDepth: undefined,
  engineMultiPv: 3,
  engineHash: 128,
  engineEvalDir: undefined,
  engineFvScale: undefined,
  engineEvalSha256: undefined,
  engineBookDir: undefined,
  serverUrl: "http://localhost:4000",
  pollIntervalMs: 10_000,
  useMock: false,
};

const QUICK_CONFIG: Config = { ...config, engineQuickMovetime: 100 };

type Kifu = NonNullable<Awaited<ReturnType<PollClient["fetchNextKifu"]>>>;

/** server が渡す棋譜（poll が読む欄だけ） */
function kifu(overrides: Partial<Record<string, unknown>> = {}): Kifu {
  return {
    id: 7,
    title: "テスト",
    usiMoves: ["7g7f", "3c3d"],
    analyzedCount: 0,
    analysisRevision: 3,
    profile: "full",
    ...overrides,
  } as unknown as Kifu;
}

function searchResult(move: string): UsiSearchResult {
  const info = { multipv: 1, depth: 10, score: { type: "cp" as const, value: 30 }, pv: [move] };
  return { bestmove: { move }, infoLines: [info], lastInfo: info };
}

/**
 * エンジンのスタブ。`analyze` は `onAnalyze` に任せる（既定は最善手 1 本を返す）。
 * 作り直し（`restart`）と `ready` の回数を数える
 */
function createEngine(onAnalyze?: (position: string, go: string) => Promise<UsiSearchResult>) {
  const analyzed: string[] = [];
  const engine = {
    analyze: vi.fn(async (position: string, go: string) => {
      analyzed.push(position);
      return onAnalyze ? onAnalyze(position, go) : searchResult("7g7f");
    }),
    setOption: vi.fn(),
    getOption: vi.fn(() => undefined),
    getName: vi.fn(() => "YaneuraOu test"),
    ready: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
  } satisfies PollEngine;
  return { engine, analyzed };
}

/** client のスタブ。局面評価のジョブは `jobs` から順に、quick 待ちの印は `quickPendingAt(呼び出し回数)` で返す */
function createClient(options: {
  kifu?: Kifu | null;
  jobs?: PositionEvalJob[];
  quickPendingAt?: (claimCount: number) => boolean;
} = {}) {
  const jobs = [...(options.jobs ?? [])];
  let claims = 0;
  const client = {
    fetchNextKifu: vi.fn(async () => (options.kifu === undefined ? kifu() : options.kifu)),
    submitAnalysis: vi.fn(async () => ({ ok: true, applied: true, completed: false })),
    reportProgress: vi.fn(async () => ({ ok: true })),
    reportError: vi.fn(async () => ({ ok: true })),
    claimPositionJob: vi.fn(async () => {
      claims++;
      return { job: jobs.shift() ?? null, quickPending: options.quickPendingAt?.(claims) ?? false };
    }),
    reportPositionResult: vi.fn(async () => ({ ok: true, applied: true })),
  };
  return client as typeof client & PollClient;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runOnce: 正常系", () => {
  it("棋譜を最後まで解析し、世代と来歴を付けて送る（失敗は記録しない）", async () => {
    const { engine, analyzed } = createEngine();
    const client = createClient();
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("completed");

    expect(analyzed).toEqual([
      "position startpos",
      "position startpos moves 7g7f",
      "position startpos moves 7g7f 3c3d",
    ]);
    // quick の設定を持たない worker は quick=0 で取りに行く
    expect(client.fetchNextKifu).toHaveBeenCalledWith(false);
    const [kifuId, revision, analyses, provenance] = client.submitAnalysis.mock.calls.at(-1) as unknown as [
      number,
      number,
      { moveNumber: number }[],
      Record<string, unknown>,
    ];
    expect([kifuId, revision]).toEqual([7, 3]);
    expect(analyses.map((a) => a.moveNumber)).toEqual([0, 1, 2]);
    expect(provenance).toEqual({
      profile: "full",
      engineName: "YaneuraOu test",
      movetimeMs: 1000,
      targetDepth: null,
      multiPv: 3,
    });
    expect(client.reportError).not.toHaveBeenCalled();
    expect(engine.restart).not.toHaveBeenCalled();
  });

  it("棋譜が無ければ何もしない・指し手の無い棋譜は飛ばす", async () => {
    const idle = createPoller({
      engine: createEngine().engine,
      client: createClient({ kifu: null }),
      config,
      isRunning: () => true,
    });
    await expect(idle.runOnce()).resolves.toBe("idle");

    const { engine } = createEngine();
    const client = createClient({ kifu: kifu({ usiMoves: null }) });
    const poller = createPoller({ engine, client, config, isRunning: () => true });
    await expect(poller.runOnce()).resolves.toBe("skipped");
    expect(engine.analyze).not.toHaveBeenCalled();
  });

  it("再開位置（analyzedCount）から解析する", async () => {
    const { engine, analyzed } = createEngine();
    const client = createClient({ kifu: kifu({ analyzedCount: 2 }) });
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await poller.runOnce();

    expect(analyzed).toEqual(["position startpos moves 7g7f 3c3d"]);
  });
});

describe("runOnce: 恒久失敗（棋譜の失敗として記録する）", () => {
  it("探索の失敗は analysisError を記録し、エンジンを作り直す", async () => {
    const { engine } = createEngine(async () => {
      throw new Error("info string Error! : Illegal Input Move : 9z9z");
    });
    const client = createClient();
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("failed");

    expect(client.reportError).toHaveBeenCalledWith(7, 3, "info string Error! : Illegal Input Move : 9z9z");
    expect(engine.restart).toHaveBeenCalledTimes(1);
    expect(engine.ready).toHaveBeenCalledTimes(1);
    expect(poller.isEngineReady()).toBe(true);
  });

  it("server が拒否した（4xx）送信は analysisError を記録し、エンジンは作り直さない", async () => {
    const { engine } = createEngine();
    const client = createClient();
    client.submitAnalysis.mockRejectedValueOnce(new SubmitRejectedError(400));
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("rejected");

    expect(client.reportError).toHaveBeenCalledWith(7, 3, "Analysis chunk rejected by server: 400");
    expect(engine.restart).not.toHaveBeenCalled();
  });

  it("失敗の記録が通らなくても投げない（次の poll へ進む）", async () => {
    const { engine } = createEngine(async () => {
      throw new Error("[USI] Analysis timed out");
    });
    const client = createClient();
    client.reportError.mockRejectedValueOnce(new Error("Failed to report error: 500"));
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("failed");
    expect(engine.restart).toHaveBeenCalledTimes(1);
  });
});

describe("runOnce: 一時失敗（記録せず、次の poll で続きから）", () => {
  it("送信の一時失敗（5xx・通信）は記録しない・エンジンも作り直さない", async () => {
    const { engine } = createEngine();
    const client = createClient();
    client.submitAnalysis.mockRejectedValueOnce(new Error("Failed to submit analysis: 503"));
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("submit-failed");

    expect(client.reportError).not.toHaveBeenCalled();
    expect(engine.restart).not.toHaveBeenCalled();
  });

  it("棋譜の取得の失敗は投げる（呼び出し側がログに残し、次の poll で再試行する）", async () => {
    const { engine } = createEngine();
    const client = createClient();
    client.fetchNextKifu.mockRejectedValueOnce(new Error("Failed to fetch kifus: 502"));
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).rejects.toThrow("Failed to fetch kifus: 502");
    expect(client.reportError).not.toHaveBeenCalled();
  });

  it("進捗の報告の失敗は解析を止めない", async () => {
    const { engine } = createEngine();
    const client = createClient();
    client.reportProgress.mockRejectedValue(new Error("Failed to report progress: 500"));
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("completed");
  });
});

describe("runOnce: エンジンの死と作り直し", () => {
  it("作り直しに失敗したら、復旧するまで棋譜を取得しない", async () => {
    const { engine } = createEngine(async () => {
      throw new Error("[USI] Engine process exited (code 1)");
    });
    engine.restart.mockRejectedValueOnce(new Error("spawn ENOENT"));
    const client = createClient();
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("failed");
    expect(poller.isEngineReady()).toBe(false);

    // 次の poll: 頭で作り直しを試す。また失敗したら棋譜は掴まない
    engine.restart.mockRejectedValueOnce(new Error("spawn ENOENT"));
    await expect(poller.runOnce()).resolves.toBe("engine-unavailable");
    expect(client.fetchNextKifu).toHaveBeenCalledTimes(1);

    // その次: 作り直せたら棋譜に進む
    engine.analyze.mockImplementation(async () => searchResult("7g7f"));
    await expect(poller.runOnce()).resolves.toBe("completed");
    expect(poller.isEngineReady()).toBe(true);
    expect(client.fetchNextKifu).toHaveBeenCalledTimes(2);
  });

  it("局面評価でエンジンが落ちたら、ジョブの失敗を報告して作り直し、この poll では棋譜に進まない", async () => {
    const { engine } = createEngine(async () => {
      throw new Error("[USI] Engine process exited (code 1)");
    });
    const client = createClient({ jobs: [{ id: "eval-1", sfen: "9/9/9/9/9/9/9/9/9 b -", move: null }] });
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("interactive-restarted");

    expect(client.reportPositionResult).toHaveBeenCalledWith("eval-1", {
      error: "[USI] Engine process exited (code 1)",
    });
    expect(engine.restart).toHaveBeenCalledTimes(1);
    expect(client.fetchNextKifu).not.toHaveBeenCalled();
    // 🔒 棋譜は無関係なので analysisError は立てない（prd/12 §2.5）
    expect(client.reportError).not.toHaveBeenCalled();
  });

  it("棋譜の解析中に割り込んだ局面評価でエンジンが落ちても、棋譜の失敗にしない", async () => {
    const { engine } = createEngine(async (position) => {
      if (position.startsWith("position sfen")) throw new Error("[USI] Engine process exited (code 1)");
      return searchResult("7g7f");
    });
    // 1 回目の claim（poll の頭）は空、2 回目（最初の局面境界）でジョブが来る
    const jobs: (PositionEvalJob | null)[] = [null, { id: "eval-1", sfen: "9/9/9/9/9/9/9/9/9 b -", move: null }];
    const client = createClient();
    client.claimPositionJob.mockImplementation(async () => ({ job: jobs.shift() ?? null, quickPending: false }));
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("interactive-restarted");

    expect(engine.restart).toHaveBeenCalledTimes(1);
    expect(client.reportError).not.toHaveBeenCalled();
  });
});

describe("runOnce: quick の割り込み（prd/05 §1.1d）", () => {
  it("full の解析中に quick 待ちが現れたら、局面境界で中断する（送ってから抜ける・失敗にしない）", async () => {
    const { engine, analyzed } = createEngine();
    // claim 1 回目は poll の頭、2 回目は局面 0 の前、3 回目は局面 1 の前
    const client = createClient({ quickPendingAt: (n) => n >= 3 });
    const poller = createPoller({ engine, client, config: QUICK_CONFIG, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("interrupted");

    expect(client.fetchNextKifu).toHaveBeenCalledWith(true);
    expect(analyzed).toEqual(["position startpos"]);
    const sent = client.submitAnalysis.mock.calls.map(
      (call) => (call as unknown as [number, number, { moveNumber: number }[]])[2].map((a) => a.moveNumber),
    );
    expect(sent).toEqual([[0]]);
    expect(client.reportError).not.toHaveBeenCalled();
    expect(engine.restart).not.toHaveBeenCalled();
  });

  it("quick を解析している最中は中断しない", async () => {
    const { engine } = createEngine();
    const client = createClient({ kifu: kifu({ profile: "quick" }), quickPendingAt: () => true });
    const poller = createPoller({ engine, client, config: QUICK_CONFIG, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("completed");
  });

  it("quick を持たない worker は中断しない（自分の棋譜が quick 待ちに数えられる）", async () => {
    const { engine } = createEngine();
    const client = createClient({ quickPendingAt: () => true });
    const poller = createPoller({ engine, client, config, isRunning: () => true });

    await expect(poller.runOnce()).resolves.toBe("completed");
  });
});

describe("runOnce: 停止中（SIGTERM・SIGINT）", () => {
  it("停止が始まっていたら棋譜を掴まない", async () => {
    const { engine } = createEngine();
    const client = createClient();
    const poller = createPoller({ engine, client, config, isRunning: () => false });

    await expect(poller.runOnce()).resolves.toBe("stopped");
    expect(client.fetchNextKifu).not.toHaveBeenCalled();
  });

  it("解析中に停止が始まったら、局面境界で中断する（送ってから抜ける）", async () => {
    let running = true;
    const { engine, analyzed } = createEngine(async () => {
      running = false;
      return searchResult("7g7f");
    });
    const client = createClient();
    const poller = createPoller({ engine, client, config, isRunning: () => running });

    await expect(poller.runOnce()).resolves.toBe("interrupted");
    expect(analyzed).toHaveLength(1);
    expect(client.submitAnalysis).toHaveBeenCalledTimes(1);
    expect(client.reportError).not.toHaveBeenCalled();
  });

  it("停止中に探索が落ちても棋譜の失敗にしない（エンジンが止められただけ）", async () => {
    let running = true;
    const { engine } = createEngine(async () => {
      running = false;
      throw new Error("[USI] Engine process exited (code null)");
    });
    const client = createClient();
    const poller = createPoller({ engine, client, config, isRunning: () => running });

    await expect(poller.runOnce()).resolves.toBe("stopped-by-shutdown");
    expect(client.reportError).not.toHaveBeenCalled();
    expect(engine.restart).not.toHaveBeenCalled();
  });
});
