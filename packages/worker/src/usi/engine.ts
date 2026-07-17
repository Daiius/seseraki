import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { parseInfoLine, parseBestmove } from "./parser.js";
import type { UsiInfo, UsiSearchResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export class UsiEngine {
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private listeners: ((line: string) => void)[] = [];
  /** プロセス死（close/error）で解決を待っている呼び出しを起こすためのハンドラ */
  private deathHandlers: ((err: Error) => void)[] = [];
  private dead = false;

  constructor(
    private readonly enginePath: string,
    private readonly args: string[] = [],
  ) {}

  async start(): Promise<void> {
    this.dead = false;
    const proc = spawn(this.enginePath, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = proc;

    // 再起動後に旧プロセスの遅延イベントが新プロセスの状態を汚さないようガードする
    const isCurrent = () => this.process === proc;

    const die = (err: Error) => {
      if (!isCurrent()) return;
      this.dead = true;
      const handlers = this.deathHandlers;
      this.deathHandlers = [];
      for (const handler of handlers) handler(err);
    };

    proc.on("error", (err) => {
      console.error("[USI] Engine process error:", err.message);
      die(new Error(`[USI] Engine process error: ${err.message}`));
    });

    proc.on("close", (code) => {
      console.log("[USI] Engine process exited with code:", code);
      die(new Error(`[USI] Engine process exited (code ${code})`));
    });

    this.rl = createInterface({ input: proc.stdout! });
    this.rl.on("line", (line) => {
      if (!isCurrent()) return;
      for (const listener of this.listeners) {
        listener(line);
      }
    });

    // stderr logging
    const stderrRl = createInterface({ input: proc.stderr! });
    stderrRl.on("line", (line) => {
      console.error("[USI stderr]", line);
    });

    this.sendCommand("usi");
    await this.waitFor("usiok");
    console.log("[USI] Engine initialized (usiok)");
  }

  /** エンジンを再起動する（呼び出し側は setOption / ready() を再適用すること） */
  async restart(): Promise<void> {
    await this.quit();
    this.process = null;
    this.rl = null;
    this.listeners = [];
    this.deathHandlers = [];
    await this.start();
  }

  async ready(): Promise<void> {
    this.sendCommand("isready");
    await this.waitFor("readyok");
    console.log("[USI] Engine ready (readyok)");
  }

  setOption(name: string, value: string): void {
    this.sendCommand(`setoption name ${name} value ${value}`);
  }

  async analyze(
    position: string,
    goCommand: string,
  ): Promise<UsiSearchResult> {
    this.ensureAlive();

    const infoLines: UsiInfo[] = [];

    return new Promise<UsiSearchResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("[USI] Analysis timed out"));
      }, DEFAULT_TIMEOUT_MS);

      const onDeath = (err: Error) => {
        cleanup();
        reject(err);
      };

      const listener = (line: string) => {
        if (line.startsWith("info string Error!")) {
          console.error("[USI] Engine error:", line);
          cleanup();
          reject(new Error(line));
          return;
        }
        if (line.startsWith("info ")) {
          infoLines.push(parseInfoLine(line));
        } else if (line.startsWith("bestmove ")) {
          cleanup();
          const bestmove = parseBestmove(line);
          const lastInfo = infoLines.at(-1) ?? {};
          resolve({ bestmove, infoLines, lastInfo });
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        const li = this.listeners.indexOf(listener);
        if (li !== -1) this.listeners.splice(li, 1);
        const di = this.deathHandlers.indexOf(onDeath);
        if (di !== -1) this.deathHandlers.splice(di, 1);
      };

      this.listeners.push(listener);
      this.deathHandlers.push(onDeath);
      try {
        this.sendCommand(position);
        this.sendCommand(goCommand);
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async quit(): Promise<void> {
    if (!this.process || this.dead) return;

    const proc = this.process;
    return new Promise<void>((resolve) => {
      proc.on("close", () => resolve());
      this.sendCommand("quit");

      // Force kill after 5 seconds
      setTimeout(() => {
        if (!this.dead) {
          proc.kill("SIGKILL");
        }
        resolve();
      }, 5_000);
    });
  }

  private sendCommand(command: string): void {
    this.ensureAlive();
    console.log("[USI >]", command);
    this.process!.stdin!.write(command + "\n");
  }

  private waitFor(
    expected: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(`[USI] Timeout waiting for "${expected}"`),
        );
      }, timeoutMs);

      const onDeath = (err: Error) => {
        cleanup();
        reject(err);
      };

      const listener = (line: string) => {
        if (line.trim() === expected) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        const li = this.listeners.indexOf(listener);
        if (li !== -1) this.listeners.splice(li, 1);
        const di = this.deathHandlers.indexOf(onDeath);
        if (di !== -1) this.deathHandlers.splice(di, 1);
      };

      this.listeners.push(listener);
      this.deathHandlers.push(onDeath);
    });
  }

  private ensureAlive(): void {
    if (this.dead || !this.process) {
      throw new Error("[USI] Engine is not running");
    }
  }
}
