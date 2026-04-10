import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { parseInfoLine, parseBestmove } from "./parser.js";
import type { UsiInfo, UsiSearchResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export class UsiEngine {
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private listeners: ((line: string) => void)[] = [];
  private dead = false;

  constructor(
    private readonly enginePath: string,
    private readonly args: string[] = [],
  ) {}

  async start(): Promise<void> {
    this.process = spawn(this.enginePath, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.on("error", (err) => {
      this.dead = true;
      console.error("[USI] Engine process error:", err.message);
    });

    this.process.on("close", (code) => {
      this.dead = true;
      console.log("[USI] Engine process exited with code:", code);
    });

    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on("line", (line) => {
      for (const listener of this.listeners) {
        listener(line);
      }
    });

    // stderr logging
    const stderrRl = createInterface({ input: this.process.stderr! });
    stderrRl.on("line", (line) => {
      console.error("[USI stderr]", line);
    });

    this.sendCommand("usi");
    await this.waitFor("usiok");
    console.log("[USI] Engine initialized (usiok)");
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
        const idx = this.listeners.indexOf(listener);
        if (idx !== -1) this.listeners.splice(idx, 1);
      };

      this.listeners.push(listener);
      this.sendCommand(position);
      this.sendCommand(goCommand);
    });
  }

  async quit(): Promise<void> {
    if (!this.process || this.dead) return;

    return new Promise<void>((resolve) => {
      this.process!.on("close", () => resolve());
      this.sendCommand("quit");

      // Force kill after 5 seconds
      setTimeout(() => {
        if (!this.dead) {
          this.process?.kill("SIGKILL");
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

      const listener = (line: string) => {
        if (line.trim() === expected) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        const idx = this.listeners.indexOf(listener);
        if (idx !== -1) this.listeners.splice(idx, 1);
      };

      this.listeners.push(listener);
    });
  }

  private ensureAlive(): void {
    if (this.dead || !this.process) {
      throw new Error("[USI] Engine is not running");
    }
  }
}
