import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainEvaluationJobs,
  evaluateJob,
  InteractiveEngineError,
  type EvalEngine,
  type PositionEvalJob,
  type PositionEvalOutcome,
  type PositionJobSource,
} from "./position-eval.js";
import type { UsiInfo, UsiSearchResult } from "shared";

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

/**
 * 呼び出しを記録し、用意した応答を順に返すエンジン。
 * `setOption` の送信も記録し、実機と同じく「送った値を覚えて返す」ようにする
 * （検討局面の評価が MultiPV を一時的に変えて戻すため）。
 */
function createStubEngine(
  responses: UsiSearchResult[],
  initialOptions: Record<string, string> = {},
) {
  const calls: { position: string; go: string }[] = [];
  /** setoption の送信履歴（`MultiPV=3` のような文字列）。**探索との前後関係も見たい** */
  const optionCalls: string[] = [];
  const options = new Map(Object.entries(initialOptions));
  const engine: EvalEngine = {
    analyze: async (position: string, go: string) => {
      calls.push({ position, go });
      optionCalls.push("(go)");
      const next = responses.shift();
      if (!next) throw new Error("no canned response left");
      return next;
    },
    setOption: (name: string, value: string) => {
      options.set(name, value);
      optionCalls.push(`${name}=${value}`);
    },
    getOption: (name: string) => options.get(name),
  };
  return { engine, calls, optionCalls };
}

beforeEach(() => {
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
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.candidates.map((c) => c.move)).toEqual([
      "7g7f",
      "2g2f",
      "5i6h",
    ]);
    expect(result.candidates[0].score).toEqual({ type: "cp", value: 50 });
  });

  it("定跡の列挙が MultiPV を超えても、要求した本数に切り詰める（issue #67）", async () => {
    const { engine } = createStubEngine([
      searchResult([
        info(1, ["2g2f", "8c8d"], 50),
        info(2, ["7g7f", "8c8d"], 44),
        info(3, ["6i7h", "8c8d"], 35),
        info(4, ["5g5f", "8c8d"], 20),
        info(5, ["3i4h", "8c8d"], 10),
      ]),
    ]);

    const result = await evaluateJob(engine, { id: "eval-1", sfen: SFEN, move: null }, GO, 3);

    expect(result).toMatchObject({
      candidates: [{ move: "2g2f" }, { move: "7g7f" }, { move: "6i7h" }],
    });
    expect(result).toHaveProperty("candidates.length", 3);
  });

  // 🔴 dev 実測（2026-08-28）: `analyzeKifu` が解析の終わりに MultiPV を 1 へ戻すため、
  // エンジンの設定に乗るだけだと候補手が「解析中なら 3 本・アイドルなら 1 本」と揺れた。
  // 局面評価は自分で設定し、終わったら元へ戻す（prd/12 §2.2）
  it("MultiPV を指定値にしてから探索し、探索後に元の値へ戻す", async () => {
    const { engine, optionCalls } = createStubEngine([
      searchResult([info(1, ["7g7f"], 50)]),
    ]);

    await evaluateJob(engine, { id: "eval-1", sfen: SFEN, move: null }, GO, 3);

    // 設定 → 探索 → 復元の順であること（探索中に値が変わっていないこと）
    expect(optionCalls).toEqual(["MultiPV=3", "(go)", "MultiPV=1"]);
  });

  it("棋譜解析が既に同じ値にしているなら setoption を送らない", async () => {
    const { engine, optionCalls } = createStubEngine(
      [searchResult([info(1, ["7g7f"], 50)])],
      { MultiPV: "3" },
    );

    await evaluateJob(engine, { id: "eval-1", sfen: SFEN, move: null }, GO, 3);

    expect(optionCalls).toEqual(["(go)"]);
  });

  it("探索が失敗しても MultiPV を元へ戻す（解析中の棋譜の候補手数を変えない）", async () => {
    const { engine, optionCalls } = createStubEngine([], { MultiPV: "1" });

    await expect(
      evaluateJob(engine, { id: "eval-1", sfen: SFEN, move: null }, GO, 3),
    ).rejects.toThrow();

    expect(optionCalls).toEqual(["MultiPV=3", "(go)", "MultiPV=1"]);
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
    expect(result).toEqual({
      candidates: [
        {
          rank: 1,
          move: "9g9f",
          score: { type: "cp", value: -20 },
          pv: ["9g9f", "3c3d", "2g2f"],
          depth: 12,
        },
      ],
    });
  });

  it("MultiPV は触らない（返すのはその手 1 本だけ）・GenerateAllLegalMoves は読みの間だけ有効にする", async () => {
    const { engine, optionCalls } = createStubEngine([
      searchResult([info(1, ["9g9f", "3c3d"], -20)]),
    ]);

    await evaluateJob(engine, job, GO, 3);

    expect(optionCalls).toEqual([
      "GenerateAllLegalMoves=true",
      "(go)",
      "GenerateAllLegalMoves=false",
    ]);
  });

  it("🔴 不成の手も名指しで読む（GenerateAllLegalMoves を有効にしてから searchmoves）", async () => {
    const { engine, calls, optionCalls } = createStubEngine([
      searchResult([info(1, ["9d9c", "9b9c"], -300)]),
    ]);

    const result = await evaluateJob(engine, { ...job, move: "9d9c" }, GO);

    expect(calls[0].go).toBe(`${GO} searchmoves 9d9c`);
    expect(optionCalls[0]).toBe("GenerateAllLegalMoves=true");
    expect(result).toMatchObject({ candidates: [{ move: "9d9c", pv: ["9d9c", "9b9c"] }] });
  });

  it("探索が失敗しても GenerateAllLegalMoves を戻す", async () => {
    const { engine, optionCalls } = createStubEngine([]);

    await expect(evaluateJob(engine, job, GO)).rejects.toThrow();

    expect(optionCalls.at(-1)).toBe("GenerateAllLegalMoves=false");
  });

  it("局面評価（名指しなし）では GenerateAllLegalMoves に触れない", async () => {
    const { engine, optionCalls } = createStubEngine([
      searchResult([info(1, ["7g7f", "3c3d"], 50)]),
    ]);

    await evaluateJob(engine, { ...job, move: null }, GO, 1);

    expect(optionCalls.some((c) => c.startsWith("GenerateAllLegalMoves"))).toBe(false);
  });

  // 🔒 名指しが効かなかった（別の手が返った）ら、数字を作らずそのジョブの失敗にする。
  // 以前はプロセスの生存期間ずっと符号反転のフォールバックに切り替わっていた（大域の判定）
  it("名指ししていない手が返ったら、そのジョブの失敗にする（フォールバックしない）", async () => {
    const { engine, calls } = createStubEngine([
      searchResult([info(1, ["7g7f", "3c3d"], 50)]),
    ]);

    const result = await evaluateJob(engine, job, GO);

    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      error: "Named move was not searched (requested 9g9f, returned 7g7f)",
    });
  });

  it("一度効かなくても、次のジョブはまた searchmoves で読む（判定を覚えない）", async () => {
    const { engine, calls } = createStubEngine([
      searchResult([info(1, ["7g7f"], 50)]),
      searchResult([info(1, ["9g9f", "3c3d"], -20)]),
    ]);

    await evaluateJob(engine, job, GO);
    const second = await evaluateJob(engine, job, GO);

    expect(calls.map((c) => c.go)).toEqual([`${GO} searchmoves 9g9f`, `${GO} searchmoves 9g9f`]);
    expect(second).toMatchObject({ candidates: [{ move: "9g9f", score: { type: "cp", value: -20 } }] });
  });

  it("評価を出さずに名指しした手を指したら候補なしで返す（数字を作らない）", async () => {
    const { engine } = createStubEngine([
      { bestmove: { move: "9g9f" }, infoLines: [], lastInfo: {} },
    ]);
    expect(await evaluateJob(engine, job, GO)).toEqual({ candidates: [] });
  });

  it("即詰みの手は mate の評価をそのまま返す（ブラウザの採点と同じ解釈）", async () => {
    const { engine } = createStubEngine([
      searchResult([
        { multipv: 1, depth: 1, score: { type: "mate", value: 1 }, pv: ["9g9f"] },
      ]),
    ]);
    expect(await evaluateJob(engine, job, GO)).toEqual({
      candidates: [
        { rank: 1, move: "9g9f", score: { type: "mate", value: 1 }, pv: ["9g9f"], depth: 1 },
      ],
    });
  });
});

/** claim するジョブを並べ、報告を記録する source */
function createStubSource(jobs: PositionEvalJob[]) {
  const reports: { id: string; report: PositionEvalOutcome }[] = [];
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

  // 🔴 局面評価の 3 本は API の契約（prd/12 §2.2）。棋譜解析の `ENGINE_MULTIPV` は
  // 運用で増減してよいつまみなので、そちらに乗せると設定次第で 1 本・5 本と揺れる
  it("MultiPV を 3 に設定してから探索する（ENGINE_MULTIPV に乗らない）", async () => {
    const { engine, optionCalls } = createStubEngine(
      [searchResult([info(1, ["7g7f"], 50)])],
      { MultiPV: "1" },
    );
    const { source } = createStubSource([job("eval-1")]);

    await drainEvaluationJobs(engine, source, GO);

    expect(optionCalls).toEqual(["MultiPV=3", "(go)", "MultiPV=1"]);
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

    const processed = await drainEvaluationJobs(engine, source, GO, {
      maxJobs: 2,
    });

    expect(processed).toBe(2);
    expect(reports).toHaveLength(2);
  });

  it("エンジンが落ちたら失敗を報告してから InteractiveEngineError を投げる", async () => {
    const engine: EvalEngine = {
      analyze: async () => {
        throw new Error("[USI] Engine process exited (code 1)");
      },
      setOption: () => {},
      getOption: () => undefined,
    };
    const { source, reports } = createStubSource([job("eval-1")]);

    await expect(drainEvaluationJobs(engine, source, GO)).rejects.toBeInstanceOf(
      InteractiveEngineError,
    );
    // エラーも完了として報告する（結果もエラーも出ないまま宙に浮かせない）
    expect(reports).toEqual([
      {
        id: "eval-1",
        report: { error: "[USI] Engine process exited (code 1)" },
      },
    ]);
  });

  it("名指しが効かなかったジョブは失敗として報告し、エンジンの再起動には回さない", async () => {
    const { engine } = createStubEngine([
      searchResult([info(1, ["7g7f"], 50)]),
      searchResult([info(1, ["2g2f"], 30)]),
    ]);
    const { source, reports } = createStubSource([
      { id: "eval-1", sfen: SFEN, move: "9g9f" },
      job("eval-2"),
    ]);

    await expect(drainEvaluationJobs(engine, source, GO)).resolves.toBe(2);
    expect(reports[0]).toEqual({
      id: "eval-1",
      report: { error: "Named move was not searched (requested 9g9f, returned 7g7f)" },
    });
    expect(reports[1]).toMatchObject({ id: "eval-2", report: { candidates: [{ move: "2g2f" }] } });
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
