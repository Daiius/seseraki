import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainEvaluationJobs,
  evaluateJob,
  InteractiveEngineError,
  resetSearchmovesSupport,
  type EvalEngine,
  type PositionEvalJob,
  type PositionEvalResult,
  type PositionJobSource,
} from "./position-eval.js";
import type { UsiInfo, UsiSearchResult } from "./usi/types.js";

/** 局面キー（手数を持たない 3 フィールドの SFEN） */
const SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -";
const GO = "go movetime 1000";

/** info 行 1 本（1 候補手ぶん） */
function info(multipv: number, pv: string[], value: number): UsiInfo {
  return { multipv, depth: 12, score: { type: "cp", value }, pv };
}

function searchResult(infoLines: UsiInfo[]): UsiSearchResult {
  return {
    bestmove: { move: infoLines[0]?.pv?.[0] ?? "resign" },
    infoLines,
    lastInfo: infoLines.at(-1) ?? {},
  };
}

/** 呼び出しを記録し、用意した応答を順に返すエンジン */
function createStubEngine(responses: UsiSearchResult[]) {
  const calls: { position: string; go: string }[] = [];
  const engine: EvalEngine = {
    analyze: async (position: string, go: string) => {
      calls.push({ position, go });
      const next = responses.shift();
      if (!next) throw new Error("no canned response left");
      return next;
    },
  };
  return { engine, calls };
}

beforeEach(() => {
  resetSearchmovesSupport();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("evaluateJob（局面評価）", () => {
  it("MultiPV の候補手をそのまま返し、手数を補って position に渡す", async () => {
    const { engine, calls } = createStubEngine([
      searchResult([
        info(1, ["7g7f", "3c3d"], 50),
        info(2, ["2g2f", "8c8d"], 30),
        info(3, ["5i6h", "3c3d"], 10),
      ]),
    ]);

    const result = await evaluateJob(
      engine,
      { id: "eval-1", sfen: SFEN, move: null },
      GO,
    );

    // 3 フィールドの局面キーに手数 1 を補って渡す（USI は 4 フィールドを要求する）
    expect(calls[0].position).toBe(`position sfen ${SFEN} 1`);
    expect(calls[0].go).toBe(GO);
    expect(result.fallback).toBe(false);
    expect(result.candidates.map((c) => c.move)).toEqual([
      "7g7f",
      "2g2f",
      "5i6h",
    ]);
    expect(result.candidates[0].score).toEqual({ type: "cp", value: 50 });
  });

  it("手数付き（4 フィールド）の SFEN はそのまま渡す", async () => {
    const { engine, calls } = createStubEngine([
      searchResult([info(1, ["7g7f"], 50)]),
    ]);
    await evaluateJob(
      engine,
      { id: "eval-1", sfen: `${SFEN} 25`, move: null },
      GO,
    );
    expect(calls[0].position).toBe(`position sfen ${SFEN} 25`);
  });
});

describe("evaluateJob（名指し評価）", () => {
  const job: PositionEvalJob = { id: "eval-1", sfen: SFEN, move: "9g9f" };

  it("searchmoves が効くなら、その手のスコアと読み筋を返す", async () => {
    const { engine, calls } = createStubEngine([
      searchResult([info(1, ["9g9f", "3c3d", "2g2f"], -20)]),
    ]);

    const result = await evaluateJob(engine, job, GO);

    expect(calls).toHaveLength(1);
    expect(calls[0].go).toBe(`${GO} searchmoves 9g9f`);
    expect(result.fallback).toBe(false);
    expect(result.candidates).toEqual([
      {
        rank: 1,
        move: "9g9f",
        score: { type: "cp", value: -20 },
        pv: ["9g9f", "3c3d", "2g2f"],
        depth: 12,
      },
    ]);
  });

  it("searchmoves が無視されたら、手を適用した局面を評価して符号を反転する", async () => {
    const { engine, calls } = createStubEngine([
      // searchmoves を無視して自分の最善手を返すエンジン
      searchResult([info(1, ["7g7f", "3c3d"], 50)]),
      // フォールバック: 9g9f を指した後の局面（相手番）の評価
      searchResult([info(1, ["3c3d", "2g2f"], 60)]),
    ]);

    const result = await evaluateJob(engine, job, GO);

    expect(calls).toHaveLength(2);
    expect(calls[1].position).toBe(`position sfen ${SFEN} 1 moves 9g9f`);
    expect(calls[1].go).toBe(GO);
    expect(result.fallback).toBe(true);
    // 相手番の +60 は自分から見れば -60。読み筋の先頭に名指しした手を足して契約を揃える
    expect(result.candidates).toEqual([
      {
        rank: 1,
        move: "9g9f",
        score: { type: "cp", value: -60 },
        pv: ["9g9f", "3c3d", "2g2f"],
        depth: 12,
      },
    ]);
  });

  it("詰みの評価値も符号を反転する", async () => {
    const { engine } = createStubEngine([
      searchResult([info(1, ["7g7f"], 50)]),
      searchResult([
        { multipv: 1, depth: 20, score: { type: "mate", value: 3 }, pv: ["3c3d"] },
      ]),
    ]);
    const result = await evaluateJob(engine, job, GO);
    expect(result.candidates[0].score).toEqual({ type: "mate", value: -3 });
  });

  it("一度 searchmoves が非対応と分かったら、以降は直接フォールバックする", async () => {
    const first = createStubEngine([
      searchResult([info(1, ["7g7f"], 50)]),
      searchResult([info(1, ["3c3d"], 60)]),
    ]);
    await evaluateJob(first.engine, job, GO);
    expect(first.calls).toHaveLength(2);

    const second = createStubEngine([searchResult([info(1, ["3c3d"], 60)])]);
    const result = await evaluateJob(second.engine, job, GO);
    // searchmoves は送らず、いきなり手を適用した局面を評価する
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0].position).toBe(`position sfen ${SFEN} 1 moves 9g9f`);
    expect(result.fallback).toBe(true);
  });

  it("フォールバック先に候補が無ければ候補なしで返す（数字を作らない）", async () => {
    const { engine } = createStubEngine([
      searchResult([info(1, ["7g7f"], 50)]),
      searchResult([]),
    ]);
    const result = await evaluateJob(engine, job, GO);
    expect(result).toEqual({ candidates: [], fallback: true });
  });
});

/** claim するジョブを並べ、報告を記録する source */
function createStubSource(jobs: PositionEvalJob[]) {
  const reports: { id: string; report: PositionEvalResult | { error: string } }[] =
    [];
  const source: PositionJobSource = {
    claim: async () => jobs.shift() ?? null,
    report: async (id, report) => {
      reports.push({ id, report });
    },
  };
  return { source, reports };
}

describe("drainEvaluationJobs", () => {
  const job = (id: string): PositionEvalJob => ({ id, sfen: SFEN, move: null });

  it("待っているジョブを処理しきって戻る", async () => {
    const { engine } = createStubEngine([
      searchResult([info(1, ["7g7f"], 50)]),
      searchResult([info(1, ["2g2f"], 30)]),
    ]);
    const { source, reports } = createStubSource([job("eval-1"), job("eval-2")]);

    const processed = await drainEvaluationJobs(engine, source, GO);

    expect(processed).toBe(2);
    expect(reports.map((r) => r.id)).toEqual(["eval-1", "eval-2"]);
  });

  it("上限で打ち切る（棋譜解析が評価要求で止まり続けない）", async () => {
    const { engine } = createStubEngine([
      searchResult([info(1, ["7g7f"], 50)]),
      searchResult([info(1, ["2g2f"], 30)]),
    ]);
    const { source, reports } = createStubSource([
      job("eval-1"),
      job("eval-2"),
      job("eval-3"),
    ]);

    const processed = await drainEvaluationJobs(engine, source, GO, 2);

    expect(processed).toBe(2);
    expect(reports).toHaveLength(2);
  });

  it("エンジンが落ちたら失敗を報告してから InteractiveEngineError を投げる", async () => {
    const engine: EvalEngine = {
      analyze: async () => {
        throw new Error("[USI] Engine process exited (code 1)");
      },
    };
    const { source, reports } = createStubSource([job("eval-1")]);

    await expect(drainEvaluationJobs(engine, source, GO)).rejects.toBeInstanceOf(
      InteractiveEngineError,
    );
    // 待っている long-poll をエラーで起こす（結果もエラーも返さないまま待たせない）
    expect(reports).toEqual([
      {
        id: "eval-1",
        report: { error: "[USI] Engine process exited (code 1)" },
      },
    ]);
  });

  it("claim の失敗は握りつぶして戻る（棋譜解析を止めない）", async () => {
    const { engine } = createStubEngine([]);
    const source: PositionJobSource = {
      claim: async () => {
        throw new Error("Failed to claim position job: 500");
      },
      report: async () => {},
    };
    await expect(drainEvaluationJobs(engine, source, GO)).resolves.toBe(0);
  });

  it("報告の失敗も握りつぶして戻る", async () => {
    const { engine } = createStubEngine([
      searchResult([info(1, ["7g7f"], 50)]),
    ]);
    const claimed: PositionEvalJob[] = [job("eval-1"), job("eval-2")];
    const source: PositionJobSource = {
      claim: async () => claimed.shift() ?? null,
      report: async () => {
        throw new Error("Failed to report position result: 500");
      },
    };
    // 1 件目の報告で失敗したらそこで戻る（2 件目は次の境界で拾う）
    await expect(drainEvaluationJobs(engine, source, GO)).resolves.toBe(1);
  });
});
