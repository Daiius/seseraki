import { describe, expect, it } from "vitest";
import {
  evalProvenance,
  hasQuickProfile,
  parseEvalSha256,
  parseFvScale,
  profileSettings,
  type Config,
} from "./config.js";

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
  engineFvScale: undefined,
  engineEvalSha256: undefined,
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

const NN_SHA256 =
  "45323c65135da65d6c2c364eea93a5af6a285c27ebfb07eab4afbe737ef74508";

describe("parseFvScale", () => {
  it("未設定・空はエンジンの既定に任せる（undefined）", () => {
    expect(parseFvScale(undefined)).toBeUndefined();
    expect(parseFvScale("")).toBeUndefined();
  });

  it("正の整数を受ける", () => {
    expect(parseFvScale("16")).toBe(16);
  });

  it("正の整数でなければ起動時に落とす（黙って既定に戻さない）", () => {
    for (const raw of ["0", "-16", "16.5", "abc"]) {
      expect(() => parseFvScale(raw)).toThrow(/ENGINE_FV_SCALE/);
    }
  });
});

describe("parseEvalSha256", () => {
  it("未設定・空は送らない（undefined）", () => {
    expect(parseEvalSha256(undefined)).toBeUndefined();
    expect(parseEvalSha256("")).toBeUndefined();
  });

  it("64 桁の 16 進を小文字で受ける", () => {
    expect(parseEvalSha256(NN_SHA256)).toBe(NN_SHA256);
    expect(parseEvalSha256(NN_SHA256.toUpperCase())).toBe(NN_SHA256);
  });

  it("sha256 の形でなければ起動時に落とす", () => {
    expect(() => parseEvalSha256("abc")).toThrow(/ENGINE_EVAL_SHA256/);
    expect(() => parseEvalSha256(`${NN_SHA256}0`)).toThrow(/ENGINE_EVAL_SHA256/);
  });
});

describe("evalProvenance", () => {
  it("未設定なら項目を載せない（dev の MATERIAL など・今までどおり）", () => {
    expect(evalProvenance(base)).toEqual({});
  });

  it("設定されていれば evalHash / fvScale を載せる", () => {
    expect(
      evalProvenance({ engineEvalSha256: NN_SHA256, engineFvScale: 16 }),
    ).toEqual({ evalHash: NN_SHA256, fvScale: 16 });
  });

  it("片方だけでもその項目だけ載せる", () => {
    expect(evalProvenance({ ...base, engineFvScale: 16 })).toEqual({
      fvScale: 16,
    });
  });
});
