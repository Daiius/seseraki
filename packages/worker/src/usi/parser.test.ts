import { describe, expect, it } from "vitest";
import { parseInfoLine } from "./parser.js";

describe("parseInfoLine", () => {
  it("確定した読み筋の行を読む", () => {
    const info = parseInfoLine(
      "info depth 13 seldepth 28 multipv 1 score cp 55 nodes 6639432 nps 3678355 hashfull 17 time 1805 pv P*4f P*6c 6b6c",
    );

    expect(info.depth).toBe(13);
    expect(info.seldepth).toBe(28);
    expect(info.multipv).toBe(1);
    expect(info.score).toEqual({ type: "cp", value: 55 });
    expect(info.pv).toEqual(["P*4f", "P*6c", "6b6c"]);
    expect(info.hashfull).toBe(17);
    expect(info.bound).toBeUndefined();
  });

  it("hashfull を持たない行では undefined のままにする", () => {
    const info = parseInfoLine(
      "info depth 51 seldepth 14 multipv 1 score mate 13 nodes 100 nps 100 time 10 pv N*2e 2d2e",
    );

    expect(info.hashfull).toBeUndefined();
  });

  it("lowerbound を読む（fail high の暫定行を見分けるため）", () => {
    // aspiration window を上に外したときの行。score は下限、pv は再探索前の途中経過
    const info = parseInfoLine(
      "info depth 13 seldepth 19 multipv 1 score cp 75 lowerbound nodes 6924070 nps 3677148 hashfull 17 time 1883 pv P*4f P*6c",
    );

    expect(info.bound).toBe("lower");
    expect(info.score).toEqual({ type: "cp", value: 75 });
    expect(info.pv).toEqual(["P*4f", "P*6c"]);
  });

  it("upperbound を読む（fail low の暫定行を見分けるため）", () => {
    const info = parseInfoLine(
      "info depth 21 seldepth 22 multipv 3 score cp -56 upperbound nodes 7432279 nps 3947041 hashfull 16 time 1883 pv 7i8h 7c7d",
    );

    expect(info.bound).toBe("upper");
    expect(info.multipv).toBe(3);
  });

  it("mate のスコアを読む", () => {
    const info = parseInfoLine(
      "info depth 51 seldepth 14 multipv 1 score mate 13 nodes 100 nps 100 time 10 pv N*2e 2d2e",
    );

    expect(info.score).toEqual({ type: "mate", value: 13 });
  });

  it("定跡ヒット時の行（depth 0・pv は指し手と応手だけ）を読む", () => {
    const info = parseInfoLine(
      "info depth 0 multipv 1 score cp 44 nodes 0 nps 0 hashfull 0 time 76 pv 7g7f 8c8d",
    );

    expect(info.depth).toBe(0);
    expect(info.pv).toEqual(["7g7f", "8c8d"]);
  });
});
