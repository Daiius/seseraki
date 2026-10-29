import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeKifu,
  analyzeTimeoutMs,
  ChunkSubmitError,
  extractMultiPvResults,
  USI_ANALYZE_TIMEOUT_MARGIN_MS,
  isPermanentSubmitStatus,
  leadingContiguousCandidates,
  toReportCandidates,
  type UsiAnalysisEngine,
  type UsiCandidate,
  type UsiMoveAnalysis,
} from "./kifu-analysis";
import { parseInfoLine } from "./parser";
import type { UsiInfo, UsiSearchResult } from "./types";

/** 相掛かり序盤のサンプル（10 手 = 11 局面） */
const MOVES = [
  "7g7f",
  "3c3d",
  "2g2f",
  "8c8d",
  "2f2e",
  "8d8e",
  "6i7h",
  "4a3b",
  "2e2d",
  "2c2d",
];

/**
 * 1 局面あたり `msPerPosition` かかるエンジンのスタブ。
 * 偽タイマーを進めることで、経過時間によるチャンク分割を実時間を使わず検証する。
 */
function createStubEngine(msPerPosition: number) {
  const positions: string[] = [];
  const engine: UsiAnalysisEngine = {
    setOption: () => {},
    analyze: async (position: string): Promise<UsiSearchResult> => {
      positions.push(position);
      vi.advanceTimersByTime(msPerPosition);
      const info = {
        multipv: 1,
        depth: 5,
        score: { type: "cp" as const, value: 42 },
        pv: ["7g7f", "3c3d"],
      };
      return {
        bestmove: { move: "7g7f" },
        infoLines: [info],
        lastInfo: info,
      };
    },
  };
  return { engine, positions };
}

/** チャンクを受け取って溜める。`failAt` 回目の呼び出しでは submit 失敗を模す */
function createChunkSink(failAt?: number) {
  const chunks: UsiMoveAnalysis[][] = [];
  const onChunk = async (analyses: UsiMoveAnalysis[]) => {
    chunks.push(analyses);
    if (chunks.length === failAt) {
      throw new ChunkSubmitError(new Error("Failed to submit analysis: 500"));
    }
  };
  return { chunks, onChunk };
}

const moveNumbers = (chunks: UsiMoveAnalysis[][]) =>
  chunks.map((chunk) => chunk.map((a) => a.moveNumber));

describe("analyzeKifu のチャンク submit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("経過時間でチャンクを区切り、全局面を欠番なく渡す", async () => {
    const { engine } = createStubEngine(1000);
    const { chunks, onChunk } = createChunkSink();

    const result = await analyzeKifu(engine, MOVES, {
      chunkIntervalMs: 3000,
      onChunk,
    });

    // 1 局面 1 秒・3 秒ごとの区切りなので 3 局面ずつ、最後の 2 局面は最終チャンクで届く
    expect(moveNumbers(chunks)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [9, 10],
    ]);
    expect(result).toMatchObject({ totalMoves: 10, analyzed: 11, interrupted: false });
  });

  it("区切りに達しないうちに解析が終われば最終チャンク 1 回だけ送る", async () => {
    const { engine } = createStubEngine(100);
    const { chunks, onChunk } = createChunkSink();

    await analyzeKifu(engine, MOVES, { chunkIntervalMs: 30_000, onChunk });

    expect(moveNumbers(chunks)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
  });

  it("startMoveNumber から再開し、既に入っている局面は解析しない", async () => {
    const { engine, positions } = createStubEngine(100);
    const { chunks, onChunk } = createChunkSink();
    const progress: [number, number][] = [];

    const result = await analyzeKifu(engine, MOVES, {
      startMoveNumber: 8,
      chunkIntervalMs: 30_000,
      onChunk,
      onProgress: (analyzed, total) => progress.push([analyzed, total]),
    });

    expect(moveNumbers(chunks)).toEqual([[8, 9, 10]]);
    expect(result).toMatchObject({ totalMoves: 10, analyzed: 3, interrupted: false });
    // 再開直後の局面は「8 手適用後」から始まる
    expect(positions[0]).toBe(
      `position startpos moves ${MOVES.slice(0, 8).join(" ")}`,
    );
    expect(positions).toHaveLength(3);
    // 進捗は再開位置からの通し番号で報告する（棋譜全体に対する N/M）
    expect(progress).toEqual([
      [9, 11],
      [10, 11],
      [11, 11],
    ]);
  });

  it("割り込みで中断すると、未送信チャンクを送ってから抜ける（穴を空けない）", async () => {
    const { engine, positions } = createStubEngine(100);
    const { chunks, onChunk } = createChunkSink();
    const progress: [number, number][] = [];
    let boundary = 0;

    const result = await analyzeKifu(engine, MOVES, {
      chunkIntervalMs: 30_000,
      onChunk,
      onProgress: (analyzed, total) => progress.push([analyzed, total]),
      // 4 回目の局面境界（= 3 局面を解析し終えた時点）で quick 待ちが現れる
      onPositionBoundary: async () => ++boundary === 4,
    });

    expect(result).toMatchObject({ totalMoves: 10, analyzed: 3, interrupted: true });
    // 中断前に解析した 3 局面はすべて送られる（欠番なく 0,1,2）
    expect(moveNumbers(chunks)).toEqual([[0, 1, 2]]);
    expect(positions).toHaveLength(3);
    // 進捗にも穴は空かない（送った件数と一致する）
    expect(progress).toEqual([
      [1, 11],
      [2, 11],
      [3, 11],
    ]);
  });

  it("送るものが無ければ中断で空チャンクを送らない（完了と誤認させない）", async () => {
    const { engine } = createStubEngine(100);
    const { chunks, onChunk } = createChunkSink();

    const result = await analyzeKifu(engine, MOVES, {
      onChunk,
      // 最初の局面境界で中断（1 局面も解析していない）
      onPositionBoundary: async () => true,
    });

    expect(result).toMatchObject({ analyzed: 0, interrupted: true });
    expect(chunks).toEqual([]);
  });

  it("割り込みを求めない境界（false / undefined）では解析を続ける", async () => {
    const { engine } = createStubEngine(100);
    const { chunks, onChunk } = createChunkSink();

    const result = await analyzeKifu(engine, MOVES, {
      chunkIntervalMs: 30_000,
      onChunk,
      onPositionBoundary: async () => {},
    });

    expect(result).toMatchObject({ analyzed: 11, interrupted: false });
    expect(moveNumbers(chunks)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
  });

  it("再開位置が全局面に達していれば空の最終チャンクを送る（完了を確定させる）", async () => {
    const { engine, positions } = createStubEngine(100);
    const { chunks, onChunk } = createChunkSink();

    const result = await analyzeKifu(engine, MOVES, {
      startMoveNumber: 11,
      onChunk,
    });

    expect(positions).toHaveLength(0);
    expect(chunks).toEqual([[]]);
    expect(result).toMatchObject({ totalMoves: 10, analyzed: 0, interrupted: false });
  });

  it("チャンク submit が失敗したらそこで解析を中断する", async () => {
    const { engine, positions } = createStubEngine(1000);
    const { chunks, onChunk } = createChunkSink(2);

    await expect(
      analyzeKifu(engine, MOVES, { chunkIntervalMs: 3000, onChunk }),
    ).rejects.toBeInstanceOf(ChunkSubmitError);

    // 2 チャンク目（6 局面目）まで解析して止まる。残りは次の poll で続きから
    expect(moveNumbers(chunks)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(positions).toHaveLength(6);
  });

  it("chunkMaxPositions を指定すると、時間に達していなくても局面数で区切る", async () => {
    const { engine } = createStubEngine(100);
    const { chunks, onChunk } = createChunkSink();

    await analyzeKifu(engine, MOVES, {
      chunkIntervalMs: 30_000,
      chunkMaxPositions: 4,
      onChunk,
    });

    expect(moveNumbers(chunks)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10],
    ]);
  });

  it("時間と局面数は早いほうで区切る（1 チャンクは局面数の上限を超えない）", async () => {
    const { engine } = createStubEngine(1000);
    const { chunks, onChunk } = createChunkSink();

    // 時間なら 3 局面ごと・局面数なら 2 局面ごと。局面数が先に来る
    await analyzeKifu(engine, MOVES, {
      chunkIntervalMs: 3000,
      chunkMaxPositions: 2,
      onChunk,
    });

    expect(moveNumbers(chunks)).toEqual([[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10]]);

    // 逆に局面数の上限が緩ければ、時間で切れる（既定＝指定なしと同じ並び）
    const second = createChunkSink();
    await analyzeKifu(createStubEngine(1000).engine, MOVES, {
      chunkIntervalMs: 3000,
      chunkMaxPositions: 100,
      onChunk: second.onChunk,
    });
    expect(moveNumbers(second.chunks)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [9, 10],
    ]);
  });

  it("局面数ちょうどで終わったら、空の最終チャンクで完了を確定させる", async () => {
    const { engine } = createStubEngine(100);
    const { chunks, onChunk } = createChunkSink();

    // 4 局面（3 手）を 2 局面ずつ
    await analyzeKifu(engine, MOVES.slice(0, 3), {
      chunkMaxPositions: 2,
      onChunk,
    });

    expect(moveNumbers(chunks)).toEqual([[0, 1], [2, 3], []]);
  });
});

describe("ログの注入", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ログは注入した出力先へ出す（局面ごとの 1 行・再開・エンジンの失敗）", async () => {
    const info: string[] = [];
    const error: string[] = [];
    const log = {
      info: (message: string) => info.push(message),
      error: (message: string) => error.push(message),
    };
    const { engine } = createStubEngine(0);

    await analyzeKifu(engine, MOVES, {
      startMoveNumber: 9,
      onChunk: async () => {},
      log,
    });

    expect(info[0]).toBe("[Analysis] Resuming from 9/10");
    expect(info.slice(1)).toEqual([
      expect.stringMatching(/^\[Analysis\] 9\/10 \d+ms d5 1candidates$/),
      expect.stringMatching(/^\[Analysis\] 10\/10 \d+ms d5 1candidates$/),
    ]);
    expect(error).toEqual([]);

    const failing: UsiAnalysisEngine = {
      setOption: () => {},
      analyze: async () => {
        throw new Error("info string Error! : Illegal Input Move : 9z9z");
      },
    };
    await expect(analyzeKifu(failing, ["7g7f"], { log })).rejects.toThrow(
      "Illegal Input Move",
    );
    expect(error).toEqual([
      "[Analysis] 0/1 Engine error at position: position startpos",
    ]);
  });

  it("ログを渡さなくても動く", async () => {
    const { engine } = createStubEngine(0);
    const result = await analyzeKifu(engine, ["7g7f"]);
    expect(result).toMatchObject({ analyzed: 2, interrupted: false });
  });
});

describe("go コマンド", () => {
  /** 送られた go コマンドを記録するエンジン */
  function createCommandRecorder() {
    const commands: string[] = [];
    const timeouts: (number | undefined)[] = [];
    const engine: UsiAnalysisEngine = {
      setOption: () => {},
      analyze: async (_position, goCommand, options): Promise<UsiSearchResult> => {
        commands.push(goCommand);
        timeouts.push(options?.timeoutMs);
        const info = {
          multipv: 1,
          depth: 5,
          score: { type: "cp" as const, value: 0 },
          pv: ["7g7f"],
        };
        return { bestmove: { move: "7g7f" }, infoLines: [info], lastInfo: info };
      },
    };
    return { engine, commands, timeouts };
  }

  it("思考時間の指定には movetime を使う（byoyomi は指定どおりの時間にならない）", async () => {
    const { engine, commands } = createCommandRecorder();

    await analyzeKifu(engine, [], { movetime: 1000, onChunk: async () => {} });

    expect(commands).toEqual(["go movetime 1000"]);
  });

  it("思考時間の指定がなければ depth で区切る", async () => {
    const { engine, commands } = createCommandRecorder();

    await analyzeKifu(engine, [], { depth: 12, onChunk: async () => {} });

    expect(commands).toEqual(["go depth 12"]);
  });

  it("movetime の探索は「思考時間 + 余裕」で時間切れにし、depth の探索はセッションの既定に任せる", async () => {
    const byTime = createCommandRecorder();
    await analyzeKifu(byTime.engine, [], { movetime: 1000, onChunk: async () => {} });
    expect(byTime.timeouts).toEqual([1000 + USI_ANALYZE_TIMEOUT_MARGIN_MS]);

    const byDepth = createCommandRecorder();
    await analyzeKifu(byDepth.engine, [], { depth: 12, onChunk: async () => {} });
    expect(byDepth.timeouts).toEqual([undefined]);
  });
});

describe("analyzeTimeoutMs", () => {
  it("movetime があれば思考時間 + 余裕、無ければ undefined（セッションの既定）", () => {
    expect(analyzeTimeoutMs({ movetime: 600 })).toBe(600 + USI_ANALYZE_TIMEOUT_MARGIN_MS);
    expect(analyzeTimeoutMs({ movetime: 120_000 })).toBe(120_000 + USI_ANALYZE_TIMEOUT_MARGIN_MS);
    expect(analyzeTimeoutMs({})).toBeUndefined();
  });
});

/** 与えた info 行をそのまま返すエンジン（候補手の抽出だけを見るためのスタブ） */
function createInfoEngine(infoLines: UsiInfo[]): UsiAnalysisEngine {
  return {
    setOption: () => {},
    analyze: async (): Promise<UsiSearchResult> => ({
      bestmove: { move: infoLines.at(-1)?.pv?.[0] ?? "resign" },
      infoLines,
      lastInfo: infoLines.at(-1) ?? {},
    }),
  };
}

/** 初期局面 1 つだけを解析させ、その候補手を取り出す */
async function candidatesOf(infoLines: UsiInfo[]) {
  const chunks: UsiMoveAnalysis[][] = [];
  await analyzeKifu(createInfoEngine(infoLines), [], {
    onChunk: async (analyses) => {
      chunks.push(analyses);
    },
  });
  return chunks.flat()[0].candidates;
}

describe("候補手の抽出", () => {
  it("🔴 MultiPV の番号が欠けたら欠番以降を捨てて送る（server は rank 1..n の連番しか受けない。prd/16 §4.1）", async () => {
    const line = (multipv: number, move: string): UsiInfo => ({
      multipv,
      depth: 10,
      score: { type: "cp", value: 10 },
      pv: [move],
    });
    const candidates = await candidatesOf([line(1, "7g7f"), line(3, "6i7h")]);
    expect(candidates.map((c) => [c.rank, c.move])).toEqual([[1, "7g7f"]]);
  });

  it("同じ PV 番号は後の（より深い）行で上書きする", async () => {
    const candidates = await candidatesOf([
      {
        multipv: 1,
        depth: 10,
        score: { type: "cp", value: 30 },
        pv: ["7g7f", "3c3d"],
      },
      {
        multipv: 1,
        depth: 13,
        score: { type: "cp", value: 42 },
        pv: ["7g7f", "3c3d", "2g2f", "8c8d"],
      },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].depth).toBe(13);
    expect(candidates[0].pv).toEqual(["7g7f", "3c3d", "2g2f", "8c8d"]);
  });

  it("fail low/high の暫定行では確定した読み筋を上書きしない", async () => {
    // byoyomi 打ち切り時に実際に出る並び。完全な pv の直後、時間切れの瞬間に
    // fail high の暫定行（pv が 2 手しか埋まっていない）が最後に来る
    const candidates = await candidatesOf([
      {
        multipv: 1,
        depth: 13,
        score: { type: "cp", value: 55 },
        pv: ["P*4f", "P*6c", "6b6c", "4i5h"],
      },
      {
        multipv: 1,
        depth: 13,
        score: { type: "cp", value: 75 },
        bound: "lower",
        pv: ["P*4f", "P*6c"],
      },
    ]);

    // 下限値でしかない score 75 ではなく、確定した 55 と完全な読み筋が残る
    expect(candidates[0].pv).toEqual(["P*4f", "P*6c", "6b6c", "4i5h"]);
    expect(candidates[0].score).toEqual({ type: "cp", value: 55 });
  });

  it("読み筋を持たない行では上書きしない", async () => {
    const candidates = await candidatesOf([
      {
        multipv: 1,
        depth: 13,
        score: { type: "cp", value: 55 },
        pv: ["P*4f", "P*6c", "6b6c"],
      },
      // multipv も pv も持たない統計だけの info 行（PV 番号 1 として扱われる）
      { depth: 13, nodes: 6_924_070, nps: 3_677_148, time: 1883 },
    ]);

    expect(candidates[0].pv).toEqual(["P*4f", "P*6c", "6b6c"]);
  });

  it("暫定行しか出ていなければそれを採る", async () => {
    // 浅い段階で打ち切られ、確定した行が 1 つも無い局面。捨ててしまうと候補手が消える
    const candidates = await candidatesOf([
      {
        multipv: 1,
        depth: 5,
        score: { type: "cp", value: -20 },
        bound: "upper",
        pv: ["7g7f", "3c3d"],
      },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].move).toBe("7g7f");
  });
});

describe("hashfull（置換表の使用率）", () => {
  /** 局面ごとに指定の hashfull を返すエンジン（統計だけの info 行として返す） */
  function createHashfullEngine(hashfulls: (number | undefined)[]): UsiAnalysisEngine {
    let n = 0;
    return {
      setOption: () => {},
      analyze: async (): Promise<UsiSearchResult> => {
        const pvLine: UsiInfo = {
          multipv: 1,
          depth: 5,
          score: { type: "cp", value: 0 },
          pv: ["7g7f"],
        };
        const stats: UsiInfo = { depth: 5, hashfull: hashfulls[n++] };
        return {
          bestmove: { move: "7g7f" },
          infoLines: [pvLine, stats],
          lastInfo: stats,
        };
      },
    };
  }

  it("局面をまたいだ最大値を返す（置換表は 1 局を通して積み上がる）", async () => {
    const engine = createHashfullEngine([120, 480, 310]);

    const summary = await analyzeKifu(engine, ["7g7f", "3c3d"], {
      onChunk: async () => {},
    });

    expect(summary.maxHashfull).toBe(480);
  });

  it("エンジンが報告しなければ undefined のままにする", async () => {
    const engine = createHashfullEngine([undefined, undefined, undefined]);

    const summary = await analyzeKifu(engine, ["7g7f", "3c3d"], {
      onChunk: async () => {},
    });

    expect(summary.maxHashfull).toBeUndefined();
  });
});

describe("局面境界の割り込み（prd/12 §2.1）", () => {
  /** 解析した局面と、割り込みが呼ばれた位置を混ぜて記録するエンジン */
  function createTracingEngine(trace: string[]): UsiAnalysisEngine {
    return {
      setOption: () => {},
      analyze: async (position: string): Promise<UsiSearchResult> => {
        trace.push(position);
        const line: UsiInfo = {
          multipv: 1,
          depth: 5,
          score: { type: "cp", value: 0 },
          pv: ["7g7f"],
        };
        return { bestmove: { move: "7g7f" }, infoLines: [line], lastInfo: line };
      },
    };
  }

  it("1 局面ごとに、解析の前へ割り込みを挟む", async () => {
    const trace: string[] = [];
    const engine = createTracingEngine(trace);

    await analyzeKifu(engine, ["7g7f", "3c3d"], {
      onChunk: async () => {},
      onPositionBoundary: async () => {
        trace.push("boundary");
      },
    });

    // 3 局面（初期局面 + 2 手）それぞれの手前で呼ばれる
    expect(trace).toEqual([
      "boundary",
      "position startpos",
      "boundary",
      "position startpos moves 7g7f",
      "boundary",
      "position startpos moves 7g7f 3c3d",
    ]);
  });

  it("再開時は残りの局面ぶんだけ割り込む", async () => {
    const trace: string[] = [];
    const engine = createTracingEngine(trace);

    await analyzeKifu(engine, ["7g7f", "3c3d"], {
      startMoveNumber: 2,
      onChunk: async () => {},
      onPositionBoundary: async () => {
        trace.push("boundary");
      },
    });

    expect(trace.filter((t) => t === "boundary")).toHaveLength(1);
  });

  it("割り込みが投げたら解析を中断する（エンジンの再起動は呼び出し側の責務）", async () => {
    const engine = createTracingEngine([]);
    const chunks: UsiMoveAnalysis[][] = [];

    await expect(
      analyzeKifu(engine, ["7g7f", "3c3d"], {
        onChunk: async (analyses) => {
          chunks.push(analyses);
        },
        onPositionBoundary: async () => {
          throw new Error("engine died during interactive evaluation");
        },
      }),
    ).rejects.toThrow("engine died");
    expect(chunks).toHaveLength(0);
  });
});

describe("leadingContiguousCandidates", () => {
  const c = (rank: number): UsiCandidate => ({
    rank,
    move: `m${rank}`,
    score: { type: "cp", value: 0 },
    pv: [],
    depth: 1,
  });
  const ranks = (cs: UsiCandidate[]) => cs.map((x) => x.rank);

  it("連番ならそのまま（rank 順に並べる）", () => {
    expect(ranks(leadingContiguousCandidates([c(2), c(1), c(3)]))).toEqual([1, 2, 3]);
    expect(leadingContiguousCandidates([])).toEqual([]);
  });

  it("欠番以降を捨てる・1 から始まらなければ空", () => {
    expect(ranks(leadingContiguousCandidates([c(1), c(3)]))).toEqual([1]);
    expect(ranks(leadingContiguousCandidates([c(1), c(2), c(4), c(5)]))).toEqual([1, 2]);
    expect(ranks(leadingContiguousCandidates([c(2), c(3)]))).toEqual([]);
    expect(ranks(leadingContiguousCandidates([c(0), c(1)]))).toEqual([]);
  });
});

describe("isPermanentSubmitStatus", () => {
  it("入力の誤り（4xx）は恒久失敗", () => {
    for (const status of [400, 404, 409, 413, 422]) {
      expect(isPermanentSubmitStatus(status)).toBe(true);
    }
  });

  it("⚠ 認証（401 / 403）と混雑（408 / 429）は一時失敗（恒久にすると全棋譜が失敗になる）", () => {
    for (const status of [401, 403, 408, 429]) {
      expect(isPermanentSubmitStatus(status)).toBe(false);
    }
  });

  it("5xx と成功は恒久失敗ではない", () => {
    for (const status of [200, 201, 500, 502, 503]) {
      expect(isPermanentSubmitStatus(status)).toBe(false);
    }
  });
});

/**
 * 定跡ヒット局面・終局局面の出力（issue #67。本番と同じオプションでやねうら王を直接叩いて観察した形）。
 * 定跡にヒットすると、MultiPV の設定によらず定跡の候補を `multipv 1..N` で列挙し、最後に採用手の
 * 確定行（depth 0・pv は指し手＋ponder の 2 手固定）を出す。
 */
describe("定跡ヒット局面・終局局面の候補手（issue #67）", () => {
  const lines = (text: string): UsiInfo[] =>
    text.trim().split("\n").map((l) => parseInfoLine(l.trim()));

  /** 初期局面（BookMoves=999）: 定跡の列挙 → 採用手の確定行 */
  const BOOK_HIT = lines(`
    info depth 32 multipv 1 score cp 50 nodes 0 pv 2g2f 8c8d 2f2e 8d8e 6i7h 4a3b 2e2d 2c2d
    info depth 30 multipv 2 score cp 44 nodes 0 pv 7g7f 8c8d 2g2f 4a3b 6i7h 8d8e 8h7g 3c3d
    info depth 36 multipv 3 score cp 35 nodes 0 pv 6i7h 8c8d 2g2f 8d8e 2f2e 4a3b 2e2d 2c2d
    info depth 28 multipv 4 score cp 20 nodes 0 pv 5g5f 8c8d 2h5h 4a3b 6i7h 8d8e 8h7g 3c3d
    info depth 25 multipv 5 score cp 10 nodes 0 pv 3i4h 8c8d 2g2f 4a3b 6i7h 8d8e 8h7g 3c3d
    info depth 0 multipv 1 score cp 50 nodes 0 pv 2g2f 8c8d
  `);

  /** 4 手目（定跡を採用しなかった局面）: 列挙の残骸（depth 0・pv 1 手）の後に通常の探索 */
  const BOOK_RESIDUE = lines(`
    info depth 0 multipv 1 score cp 30 nodes 0 pv 2g2f
    info depth 0 multipv 2 score cp 25 nodes 0 pv 6i7h
    info depth 0 multipv 3 score cp 20 nodes 0 pv 2h6h
    info depth 0 multipv 4 score cp 15 nodes 0 pv 5g5f
    info depth 0 multipv 5 score cp 10 nodes 0 pv 4i5h
    info depth 18 seldepth 24 multipv 1 score cp 41 nodes 912345 nps 1500000 time 600 pv 2g2f 8d8e 8h7g 3c3d 7i6h
    info depth 18 seldepth 22 multipv 2 score cp 33 nodes 912345 nps 1500000 time 600 pv 6i7h 8d8e 8h7g 3c3d 2g2f
    info depth 18 seldepth 21 multipv 3 score cp 12 nodes 912345 nps 1500000 time 600 pv 2h6h 8d8e 8h7g 3c3d 7i6h
  `);

  /** 詰んでいる局面 */
  const MATED = lines(`
    info depth 0 score mate -1 pv resign
  `);

  function engineOf(infoLines: UsiInfo[], bestmove: string): UsiAnalysisEngine {
    return {
      setOption: () => {},
      analyze: async () => ({
        bestmove: { move: bestmove },
        infoLines,
        lastInfo: infoLines.at(-1) ?? {},
      }),
    };
  }

  async function analyzeOne(infoLines: UsiInfo[], bestmove: string, multiPv = 3) {
    const chunks: UsiMoveAnalysis[][] = [];
    const info: string[] = [];
    await analyzeKifu(engineOf(infoLines, bestmove), [], {
      multiPv,
      log: { info: (m) => info.push(m), error: () => {} },
      onChunk: async (analyses) => {
        chunks.push(analyses);
      },
    });
    return { candidates: chunks.flat()[0].candidates, log: info.at(-1) ?? "" };
  }

  it("定跡の列挙は MultiPV の本数に切り詰め、確定行で rank 1 の読み筋を上書きしない", async () => {
    const { candidates, log } = await analyzeOne(BOOK_HIT, "2g2f");

    expect(candidates.map((c) => [c.rank, c.move, c.pv.length])).toEqual([
      [1, "2g2f", 8],
      [2, "7g7f", 8],
      [3, "6i7h", 8],
    ]);
    expect(candidates[0].depth).toBe(32);
    // 定跡ヒットはログに出る（候補手の depth ではなく生の確定行で判定する）
    expect(log).toMatch(/ BOOK 3candidates$/);
  });

  it("定跡を採用しなかった局面では、列挙の残骸を候補手に残さない", async () => {
    const { candidates, log } = await analyzeOne(BOOK_RESIDUE, "2g2f");

    expect(candidates.map((c) => [c.rank, c.move, c.depth])).toEqual([
      [1, "2g2f", 18],
      [2, "6i7h", 18],
      [3, "2h6h", 18],
    ]);
    expect(log).toMatch(/ d18 3candidates$/);
  });

  it("MultiPV 1 なら 1 本に切り詰める（ブラウザ解析の構成）", async () => {
    const { candidates } = await analyzeOne(BOOK_HIT, "2g2f", 1);
    expect(candidates.map((c) => [c.rank, c.move, c.pv.length])).toEqual([[1, "2g2f", 8]]);
  });

  it("確定行しか無ければそれを採る", async () => {
    const { candidates, log } = await analyzeOne(lines("info depth 0 multipv 1 score cp 50 nodes 0 pv 2g2f 8c8d"), "2g2f");
    expect(candidates.map((c) => [c.rank, c.move, c.pv])).toEqual([[1, "2g2f", ["2g2f", "8c8d"]]]);
    expect(log).toMatch(/ BOOK 1candidates$/);
  });

  it("終局局面の投了（depth 0・pv resign）しか無ければそれを残し、定跡とは出さない", async () => {
    const { candidates, log } = await analyzeOne(MATED, "resign");
    expect(candidates).toEqual([
      { rank: 1, move: "resign", score: { type: "mate", value: -1 }, pv: ["resign"], depth: 0 },
    ]);
    expect(log).toMatch(/ d0 1candidates$/);
  });

  it("extractMultiPvResults: multiPv を指定しなければ切り詰めない（名指し評価は手で探す）", () => {
    expect(extractMultiPvResults(BOOK_HIT)).toHaveLength(5);
    expect(extractMultiPvResults(BOOK_HIT, { multiPv: 2 }).map((c) => c.move)).toEqual([
      "2g2f",
      "7g7f",
    ]);
  });
});

describe("toReportCandidates", () => {
  const c = (rank: number, value: number, depth = 10) => ({
    rank,
    move: "7g7f",
    score: { type: "cp" as const, value },
    pv: ["7g7f"],
    depth,
  });

  it("正常な候補はそのまま", () => {
    expect(toReportCandidates([c(1, 50), c(2, -20)])).toEqual([c(1, 50), c(2, -20)]);
  });

  it("評価値・深さが数でない候補は捨て、欠番より後も捨てる", () => {
    expect(toReportCandidates([c(1, 50), c(2, Number.NaN), c(3, 10)]).map((x) => x.rank)).toEqual([1]);
    expect(toReportCandidates([c(1, 50, Number.NaN)])).toEqual([]);
    expect(toReportCandidates([c(1, Number.POSITIVE_INFINITY)])).toEqual([]);
  });

  it("評価値は整数にして上限に収め、深さは 0 以上の整数にする", () => {
    const [a] = toReportCandidates([c(1, 5_000_000.7, -3.5)]);
    expect(a.score.value).toBe(1_000_000);
    expect(a.depth).toBe(0);
    const [b] = toReportCandidates([c(1, -12.9, 7.9)]);
    expect(b.score.value).toBe(-12);
    expect(b.depth).toBe(7);
  });
});
