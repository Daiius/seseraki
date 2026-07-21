import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeKifu,
  ChunkSubmitError,
  type AnalysisEngine,
  type MoveAnalysis,
} from "./kifu-analysis.js";
import type { UsiSearchResult } from "./usi/types.js";

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
    expect(result).toEqual({ totalMoves: 10, analyzed: 11 });
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
    expect(result).toEqual({ totalMoves: 10, analyzed: 3 });
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

  it("再開位置が全局面に達していれば空の最終チャンクを送る（完了を確定させる）", async () => {
    const { engine, positions } = createStubEngine(100);
    const { chunks, onChunk } = createChunkSink();

    const result = await analyzeKifu(engine, MOVES, {
      startMoveNumber: 11,
      onChunk,
    });

    expect(positions).toHaveLength(0);
    expect(chunks).toEqual([[]]);
    expect(result).toEqual({ totalMoves: 10, analyzed: 0 });
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
