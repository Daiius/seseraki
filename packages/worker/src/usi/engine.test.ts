/**
 * `UsiEngine` のプロセスの後始末（偽のエンジンを node で動かす。やねうら王は要らない）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsiEngine } from "./engine.js";

type Mode = "normal" | "ignore-quit" | "exit-at-start";

/** usi に usiok・isready に readyok を返す偽のエンジン。`mode` で終わり方を変える */
function fakeEngine(mode: Mode): string[] {
  const script = `
const mode = ${JSON.stringify(mode)};
if (mode === "exit-at-start") process.exit(3);
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line === "usi") {
    console.log("id name fake");
    console.log("usiok");
  } else if (line === "isready") console.log("readyok");
  else if (line === "quit" && mode !== "ignore-quit") process.exit(0);
});
if (mode === "ignore-quit") setInterval(() => {}, 1000);
`;
  return ["-e", script];
}

const engines: UsiEngine[] = [];
const make = (mode: Mode) => {
  const engine = new UsiEngine(process.execPath, fakeEngine(mode));
  engines.push(engine);
  return engine;
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) await engine.quit();
});

describe("UsiEngine", () => {
  it("起動・ready・quit が終わる", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const engine = make("normal");
    await engine.start();
    await engine.ready();
    expect(engine.getName()).toBe("fake");
    await engine.quit();
  });

  it("🔴 stdin の error（EPIPE）でプロセスごと落ちず、エンジンの死として扱う", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = make("normal");
    await engine.start();
    // エンジンが終わった直後の書き込みで起きる EPIPE を再現する。聞き手が無ければ emit がここで投げる
    const stdin = (engine as unknown as { process: { stdin: NodeJS.EventEmitter } }).process.stdin;
    expect(() =>
      stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    ).not.toThrow();
    await expect(engine.ready()).rejects.toThrow(/not running/);
    // 死んだ扱いでもプロセスは生きている。quit は quit を送らずに SIGKILL して close まで待つ
    await engine.quit();
  });

  it("起動に失敗したら投げて、セッションを残さない", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = make("exit-at-start");
    await expect(engine.start()).rejects.toThrow();
    expect(() => engine.setOption("Threads", "1")).toThrow(/not running/);
  });

  it("quit に応じないエンジンは 5 秒で SIGKILL し、close まで待つ", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = make("ignore-quit");
    await engine.start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const quitting = engine.quit();
    await vi.advanceTimersByTimeAsync(5_000);
    await quitting;
  });
});
