import { describe, expect, it } from "vitest";
import { isPermanentSubmitStatus } from "./analysis-submit";

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
