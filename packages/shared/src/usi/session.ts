/**
 * USI の手順（`usi` / `isready` / `setoption` / `position` + `go`）を、エンジンの置き場によらない形で持つ。
 *
 * エンジンとの行のやり取りは {@link UsiTransport} に切り出してあり、手元 worker は子プロセスの
 * 標準入出力、ブラウザは WASM エンジンを載せた Worker を、それぞれ transport として包んで渡す
 * （prd/14 §5.11）。このモジュールは**環境非依存**で、タイマーとログも注入で受ける
 * （`shared` は `lib: esnext`・`types: []` で、`setTimeout` も `console` も型を持たない）。
 */
import { parseBestmove, parseInfoLine } from './parser';
import type { UsiAnalyzeOptions, UsiInfo, UsiSearchResult } from './types';

/**
 * エンジンとの行の入出力。**1 つのエンジンの 1 回の起動**に対応する
 * （作り直したら transport もセッションも作り直す）。
 */
export interface UsiTransport {
  /**
   * 1 行（改行を含まない USI のコマンド）をエンジンへ送る。
   *
   * ⚠ 送信の失敗がエンジンの終了を意味する環境では、transport が**死として伝える**（`onDeath` の聞き手を呼ぶ）。
   * WASM のエンジンは不正な指し手でプロセスごと終了し、送信の呼び出しが投げる。死として伝えないと、
   * 後から届く `info string Error!` の行が次の探索の失敗として拾われる
   */
  send(line: string): void;
  /** エンジンが出した行を受け取る。セッションが**作成時に 1 度だけ**登録する */
  onLine(listener: (line: string) => void): void;
  /**
   * エンジンが死んだ（プロセスの終了・Worker のエラーなど）ことを受け取る。
   * セッションが**作成時に 1 度だけ**登録する。待っている呼び出しはこのエラーで失敗する
   */
  onDeath(listener: (error: Error) => void): void;
}

/** 時間切れに使うタイマー（node / ブラウザの `setTimeout` / `clearTimeout` を渡す） */
export interface UsiTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 時計（経過時間の計測に使う。node / ブラウザの `Date.now` を渡す。テストでは進め方を決めた時計を渡す） */
export interface UsiClock {
  now(): number;
}

/** ログの出力先（node / ブラウザの `console` を包んで渡す） */
export interface UsiLog {
  info(message: string): void;
  error(message: string): void;
}

/**
 * 応答を待つ時間の既定値（`usiok` / `readyok`、および時間切れを指定しない `bestmove`）。
 * 探索は呼び出しごとに {@link UsiAnalyzeOptions.timeoutMs} で渡せる
 */
export const USI_DEFAULT_TIMEOUT_MS = 60_000;

export interface UsiSessionOptions {
  timers: UsiTimers;
  /** 省略時はログを出さない */
  log?: UsiLog;
  /** 応答を待つ時間（既定 {@link USI_DEFAULT_TIMEOUT_MS}） */
  timeoutMs?: number;
}

export interface UsiSession {
  /** `usi` を送り `usiok` を待つ（この間に `id name` を拾う） */
  start(): Promise<void>;
  /** `isready` を送り `readyok` を待つ */
  ready(): Promise<void>;
  /** `setoption` を送り、値を覚える（{@link UsiSession.getOption} で読める） */
  setOption(name: string, value: string): void;
  /**
   * `setOption` で設定した値。**まだ設定していなければ undefined**
   * （＝エンジンの既定値のまま。USI にオプションの値を問い合わせる術はない）
   */
  getOption(name: string): string | undefined;
  /**
   * エンジンが名乗った `id name`。まだ受け取っていなければ undefined。
   *
   * 🔴 **来歴の記録専用**（prd/03 §3 / prd/05 §1.1d）。**上書き・再開の判定には使わない**——
   * 版文字列はビルドのたびに変わりうるので、これで「別エンジン＝やり直し」と判定すると
   * **全棋譜の意図しない全再解析**を招く。
   */
  getName(): string | undefined;
  /**
   * `position …` と `go …` を送り、`bestmove` までの info 行を集めて返す。
   * `options.stopWhen` を渡すと、それが true を返した `info` で `stop` を送って打ち切る（詰将棋の判定。prd/13 §5.5）。
   * `options.timeoutMs` で `bestmove` を待つ時間を呼び出しごとに決める（省略時はセッションの既定）
   */
  analyze(position: string, goCommand: string, options?: UsiAnalyzeOptions): Promise<UsiSearchResult>;
  /** `expected` と一致する行（前後の空白は無視）が来るまで待つ */
  waitFor(expected: string, timeoutMs?: number): Promise<void>;
  /** コマンドをそのまま送る（`quit` など）。エンジンが死んでいれば投げる */
  send(command: string): void;
}

/**
 * 投げられた値を Error にする。Error でないオブジェクトも `message` を持てばそれを文面にする
 * （WASM のエンジンは終了時に `{ name: 'ExitStatus', message }` の形の値を投げる）。
 */
function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'object' && thrown !== null && 'message' in thrown) {
    const { message } = thrown;
    if (typeof message === 'string') return new Error(message);
  }
  return new Error(String(thrown));
}

/**
 * transport の上に USI のセッションを作る。
 *
 * - エンジンが死んだら、待っている呼び出しはすべてそのエラーで失敗し、以後の送信は投げる
 * - 時間内に応答が無ければ失敗する（**エンジンは止めない**。作り直すのは呼び出し側の責務）
 * - 探索中の `info string Error!`（不正な指し手など）は、その行を文面にしたエラーで失敗する
 */
export function createUsiSession(
  transport: UsiTransport,
  options: UsiSessionOptions,
): UsiSession {
  const {
    timers,
    log,
    timeoutMs: defaultTimeoutMs = USI_DEFAULT_TIMEOUT_MS,
  } = options;

  const lineListeners: ((line: string) => void)[] = [];
  /** エンジンの死で失敗させる、待っている呼び出し */
  const deathHandlers: ((error: Error) => void)[] = [];
  let dead = false;
  const optionValues = new Map<string, string>();
  let name: string | undefined;

  transport.onLine((line) => {
    // 聞き手は応答を受け取ると自分を外すので、配る前の並びを写しておく
    for (const listener of [...lineListeners]) listener(line);
  });
  transport.onDeath((error) => {
    if (dead) return;
    dead = true;
    for (const handler of deathHandlers.splice(0)) handler(error);
  });

  // `id name` は usiok より前に流れてくる。恒久の聞き手で拾う
  lineListeners.push((line) => {
    if (line.startsWith('id name ')) {
      name = line.slice('id name '.length).trim();
    }
  });

  const send = (command: string): void => {
    if (dead) throw new Error('[USI] Engine is not running');
    log?.info(`[USI >] ${command}`);
    transport.send(command);
  };

  /**
   * 応答を待つ。`onLine` が `resolve` / `reject` を呼ぶか、時間切れか、エンジンの死で決着する。
   * `begin` は聞き手を登録した**後**に呼ぶ（送ったコマンドの応答を取りこぼさない）。
   */
  const waitForReply = <T>(
    timeoutMs: number,
    timeoutMessage: string,
    onLine: (
      line: string,
      settle: { resolve: (value: T) => void; reject: (error: Error) => void },
    ) => void,
    begin?: () => void,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (dead) {
        reject(new Error('[USI] Engine is not running'));
        return;
      }
      const cleanup = () => {
        timers.clearTimeout(timeout);
        const li = lineListeners.indexOf(listener);
        if (li !== -1) lineListeners.splice(li, 1);
        const di = deathHandlers.indexOf(onDeath);
        if (di !== -1) deathHandlers.splice(di, 1);
      };
      const settle = {
        resolve: (value: T) => {
          cleanup();
          resolve(value);
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      const timeout = timers.setTimeout(
        () => settle.reject(new Error(timeoutMessage)),
        timeoutMs,
      );
      const onDeath = (error: Error) => settle.reject(error);
      const listener = (line: string) => onLine(line, settle);

      lineListeners.push(listener);
      deathHandlers.push(onDeath);
      try {
        begin?.();
      } catch (error) {
        settle.reject(toError(error));
      }
    });

  const waitFor = (
    expected: string,
    timeoutMs = defaultTimeoutMs,
    begin?: () => void,
  ): Promise<void> =>
    waitForReply<void>(
      timeoutMs,
      `[USI] Timeout waiting for "${expected}"`,
      (line, settle) => {
        if (line.trim() === expected) settle.resolve();
      },
      begin,
    );

  return {
    async start() {
      // 聞き手を登録してから送る。同じスレッドで動くエンジン（node 上の WASM など）は、
      // 送信の呼び出しの中で応答を返すことがある
      await waitFor('usiok', defaultTimeoutMs, () => send('usi'));
      log?.info('[USI] Engine initialized (usiok)');
    },

    async ready() {
      await waitFor('readyok', defaultTimeoutMs, () => send('isready'));
      log?.info('[USI] Engine ready (readyok)');
    },

    setOption(optionName, value) {
      optionValues.set(optionName, value);
      send(`setoption name ${optionName} value ${value}`);
    },

    getOption: (optionName) => optionValues.get(optionName),

    getName: () => name,

    analyze(position, goCommand, analyzeOptions = {}) {
      const infoLines: UsiInfo[] = [];
      let stoppedBy: UsiInfo | undefined;
      return waitForReply<UsiSearchResult>(
        analyzeOptions.timeoutMs ?? defaultTimeoutMs,
        '[USI] Analysis timed out',
        (line, settle) => {
          if (line.startsWith('info string Error!')) {
            log?.error(`[USI] Engine error: ${line}`);
            settle.reject(new Error(line));
            return;
          }
          if (line.startsWith('info ')) {
            const info = parseInfoLine(line);
            infoLines.push(info);
            // 打ち切りは 1 度だけ（`stop` の後に出る行では送り直さない）
            if (stoppedBy === undefined && analyzeOptions.stopWhen?.(info)) {
              stoppedBy = info;
              try {
                send('stop');
              } catch (error) {
                settle.reject(toError(error));
              }
            }
          } else if (line.startsWith('bestmove ')) {
            const bestmove = parseBestmove(line);
            const lastInfo = infoLines.at(-1) ?? {};
            settle.resolve({ bestmove, infoLines, lastInfo, ...(stoppedBy ? { stoppedBy } : {}) });
          }
        },
        () => {
          send(position);
          send(goCommand);
        },
      );
    },

    waitFor,
    send,
  };
}
