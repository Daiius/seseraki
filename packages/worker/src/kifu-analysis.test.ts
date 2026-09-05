import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeKifu,
  ChunkSubmitError,
  type AnalysisEngine,
  type MoveAnalysis,
} from "./kifu-analysis.js";
import type { UsiInfo, UsiSearchResult } from "./usi/types.js";

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
  const engine: AnalysisEngine = {
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
  const chunks: MoveAnalysis[][] = [];
  const onChunk = async (analyses: MoveAnalysis[]) => {
    chunks.push(analyses);
    if (chunks.length === failAt) {
      throw new ChunkSubmitError(new Error("Failed to submit analysis: 500"));
    }
  };
  return { chunks, onChunk };
}

const moveNumbers = (chunks: MoveAnalysis[][]) =>
  chunks.map((chunk) => chunk.map((a) => a.moveNumber));

describe("analyzeKifu のチャンク submit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
});

describe("go コマンド", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 送られた go コマンドを記録するエンジン */
  function createCommandRecorder() {
    const commands: string[] = [];
    const engine: AnalysisEngine = {
      setOption: () => {},
      analyze: async (_position, goCommand): Promise<UsiSearchResult> => {
        commands.push(goCommand);
        const info = {
          multipv: 1,
          depth: 5,
          score: { type: "cp" as const, value: 0 },
          pv: ["7g7f"],
        };
        return { bestmove: { move: "7g7f" }, infoLines: [info], lastInfo: info };
      },
    };
    return { engine, commands };
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
});

/** 与えた info 行をそのまま返すエンジン（候補手の抽出だけを見るためのスタブ） */
function createInfoEngine(infoLines: UsiInfo[]): AnalysisEngine {
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
  const chunks: MoveAnalysis[][] = [];
  await analyzeKifu(createInfoEngine(infoLines), [], {
    onChunk: async (analyses) => {
      chunks.push(analyses);
    },
  });
  return chunks.flat()[0].candidates;
}

describe("候補手の抽出", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 局面ごとに指定の hashfull を返すエンジン（統計だけの info 行として返す） */
  function createHashfullEngine(hashfulls: (number | undefined)[]): AnalysisEngine {
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
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 解析した局面と、割り込みが呼ばれた位置を混ぜて記録するエンジン */
  function createTracingEngine(trace: string[]): AnalysisEngine {
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
    const chunks: MoveAnalysis[][] = [];

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
