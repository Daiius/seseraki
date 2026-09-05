import { describe, expect, it } from "vitest";
import { hasQuickProfile, profileSettings, type Config } from "./config.js";

/** `ENGINE_QUICK_*` 以外は既定どおりの config */
const base: Config = {
  enginePath: "/usr/local/bin/yaneuraou",
  engineThreads: 1,
  engineDepth: 10,
  engineMovetime: 1000,
  engineQuickMovetime: undefined,
  engineQuickDepth: undefined,
  engineMultiPv: 3,
  engineHash: 128,
  engineEvalDir: undefined,
  engineBookDir: undefined,
  serverUrl: "http://localhost:4000",
  pollIntervalMs: 10_000,
  useMock: false,
};

describe("hasQuickProfile", () => {
  it("両方とも未設定なら quick は無効（1 段階運用の後方互換）", () => {
    expect(hasQuickProfile(base)).toBe(false);
  });

  it("movetime だけでも depth だけでも quick は有効", () => {
    expect(hasQuickProfile({ ...base, engineQuickMovetime: 150 })).toBe(true);
    expect(hasQuickProfile({ ...base, engineQuickDepth: 4 })).toBe(true);
  });
});

describe("profileSettings", () => {
  it("full は ENGINE_MOVETIME / ENGINE_DEPTH のまま（据え置き）", () => {
    expect(profileSettings(base, "full")).toEqual({ movetime: 1000, depth: 10 });
  });

  it("quick は ENGINE_QUICK_* を使う", () => {
    expect(
      profileSettings({ ...base, engineQuickMovetime: 150 }, "quick"),
    ).toMatchObject({ movetime: 150 });
    expect(profileSettings({ ...base, engineQuickDepth: 4 }, "quick")).toEqual({
      movetime: undefined,
      depth: 4,
    });
  });
});
