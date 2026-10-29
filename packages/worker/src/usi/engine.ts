import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import {
  createUsiSession,
  type UsiLog,
  type UsiSearchResult,
  type UsiSession,
  type UsiTimers,
  type UsiTransport,
} from "shared";

/**
 * `shared` の解析のループ・USI のセッションに渡すログの出力先（worker は標準出力・標準エラーへ出す）。
 * `shared` は環境非依存で `console` を持たないので、使う側が注入する。
 */
export const consoleLog: UsiLog = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

const timers: UsiTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * やねうら王のプロセス。**プロセスの起動と行の入出力（transport）だけ**を持ち、USI の手順
 * （`usi` / `isready` / `setoption` / `position` + `go`・時間切れ・`id name`）は `shared` の
 * セッションに任せる（ブラウザの WASM エンジンと共用。prd/14 §5.11）。
 *
 * セッションは**プロセス 1 つにつき 1 つ**。再起動すると作り直すので、`setOption` で覚えた値と
 * `id name` も新しいプロセスのものになる（呼び出し側が setOption / ready() を再適用する）。
 */
export class UsiEngine {
  private process: ChildProcess | null = null;
  private session: UsiSession | null = null;
  private dead = false;
  /** 今のプロセスの stdout / stderr の readline（後始末で閉じる） */
  private lineReaders: Interface[] = [];

  constructor(
    private readonly enginePath: string,
    private readonly args: string[] = [],
  ) {}

  async start(): Promise<void> {
    this.dead = false;
    // 新しいプロセスはオプション未設定・版文字列も未取得の状態から始まる
    this.session = null;
    const proc = spawn(this.enginePath, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = proc;

    // 再起動後に旧プロセスの遅延イベントが新プロセスの状態を汚さないようガードする
    const isCurrent = () => this.process === proc;

    let onLine: (line: string) => void = () => {};
    let onDeath: (err: Error) => void = () => {};

    const die = (err: Error) => {
      if (!isCurrent()) return;
      this.dead = true;
      onDeath(err);
    };

    // 🔴 stdin の `error` を受ける。エンジンが終了した直後の書き込みは EPIPE になり、聞き手が無いと
    // **worker のプロセスごと落ちる**（未処理の 'error' イベント）。エンジンの死として扱う
    proc.stdin!.on("error", (err) => {
      console.error("[USI] Engine stdin error:", err.message);
      die(new Error(`[USI] Engine stdin error: ${err.message}`));
    });

    proc.on("error", (err) => {
      console.error("[USI] Engine process error:", err.message);
      die(new Error(`[USI] Engine process error: ${err.message}`));
    });

    proc.on("close", (code) => {
      console.log("[USI] Engine process exited with code:", code);
      die(new Error(`[USI] Engine process exited (code ${code})`));
    });

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      if (!isCurrent()) return;
      onLine(line);
    });

    // stderr logging
    const stderrRl = createInterface({ input: proc.stderr! });
    stderrRl.on("line", (line) => {
      console.error("[USI stderr]", line);
    });
    this.lineReaders = [rl, stderrRl];

    const transport: UsiTransport = {
      send: (line) => {
        // 死んだ後・閉じた後の stdin には書かない（書いても `error` で返るだけ）
        if (!isCurrent() || this.dead || !proc.stdin!.writable) return;
        proc.stdin!.write(line + "\n");
      },
      onLine: (listener) => {
        onLine = listener;
      },
      onDeath: (listener) => {
        onDeath = listener;
      },
    };
    this.session = createUsiSession(transport, { timers, log: consoleLog });
    try {
      await this.session.start();
    } catch (err) {
      // 起動に失敗したプロセス（usiok が来ない・すぐ死んだ）を残さない
      this.killAndForget(proc);
      throw err;
    }
  }

  /** 起動に失敗したプロセスを片付ける（待たない）。以降このプロセスのイベントは無視する */
  private killAndForget(proc: ChildProcess): void {
    if (this.process === proc) {
      this.process = null;
      this.session = null;
      this.dead = true;
    }
    this.closeLineReaders();
    if (proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }

  private closeLineReaders(): void {
    for (const reader of this.lineReaders) reader.close();
    this.lineReaders = [];
  }

  /** エンジンを再起動する（呼び出し側は setOption / ready() を再適用すること） */
  async restart(): Promise<void> {
    await this.quit();
    this.process = null;
    this.session = null;
    await this.start();
  }

  async ready(): Promise<void> {
    await this.active().ready();
  }

  setOption(name: string, value: string): void {
    this.active().setOption(name, value);
  }

  /**
   * エンジンが名乗った `id name`（来歴用。例 "YaneuraOu NNUE 8.40 ..."）。まだ受け取っていなければ undefined。
   *
   * 🔴 **来歴の記録専用**（prd/03 §3 / prd/05 §1.1d）。**上書き・再開の判定には使わない**——
   * 本番イメージはやねうら王を最新で clone してビルドするため再ビルドで版文字列が変わり、
   * 識別子で「別エンジン＝やり直し」と判定すると**全棋譜の意図しない全再解析**を招く。
   */
  getName(): string | undefined {
    return this.session?.getName();
  }

  /**
   * `setOption` で設定した値。**まだ設定していなければ undefined**
   * （＝エンジンの既定値のまま。呼び出し側が既定を補う）。
   *
   * 一時的に値を変えて戻したい呼び出し（検討局面の評価が MultiPV を上げる。prd/12 §2.2）が
   * 「元の値」を知るために使う（USI にオプション値を問い合わせる術はない）。
   */
  getOption(name: string): string | undefined {
    return this.session?.getOption(name);
  }

  async analyze(
    position: string,
    goCommand: string,
  ): Promise<UsiSearchResult> {
    return this.active().analyze(position, goCommand);
  }

  async quit(): Promise<void> {
    const proc = this.process;
    if (!proc) return;

    // 起動できなかった（pid が無い）・既に終わったプロセスは待たない
    if (proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        // 終わらなければ SIGKILL し、**close まで待つ**（再起動で新旧のプロセスが並ばないように）。
        // 死んだ扱い（stdin が壊れた）でプロセスが残っているときは quit を送れないので、すぐ SIGKILL する
        const forceKill = setTimeout(
          () => {
            if (!this.dead) console.warn("[USI] Engine did not quit in 5s, sending SIGKILL");
            proc.kill("SIGKILL");
          },
          this.dead ? 0 : 5_000,
        );
        proc.once("close", () => {
          clearTimeout(forceKill);
          resolve();
        });
        if (!this.dead) this.active().send("quit");
      });
    }
    this.closeLineReaders();
  }

  /** 起動済みのセッション。起動前・起動に失敗した後は投げる */
  private active(): UsiSession {
    if (!this.session) {
      throw new Error("[USI] Engine is not running");
    }
    return this.session;
  }
}
