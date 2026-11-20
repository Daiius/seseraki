/**
 * **停止の合図（SIGTERM / SIGINT）で、ハンドラが始まったリクエストを最後まで返してから終了する。**
 *
 * 手順: 受け付けを止める → 処理中の応答が 0 になり、{@link SETTLE_MS} のあいだ新しく始まらないのを待つ
 * （上限 {@link SHUTDOWN_TIMEOUT_MS}）→ closer を順に閉じる → ログの書き出しを待つ → `exit`。
 * 残った接続（アイドルの keep-alive など）は、プロセスの終了で OS が閉じる。
 *
 * 写すときの注意:
 * - **サーバーを起こした直後に呼ぶ**（処理中の応答は、呼んだ時点から数える）
 * - 上限の配分を、コンテナの停止の猶予（docker の既定 10 秒）に収める（下の定数）
 * - Node の標準の API だけで書いてある（Hono にも依存しない）
 *
 * 前提と対象外: 前段のリバースプロキシが、1 リクエストごとに接続し、リクエストと応答をバッファリングする構成。
 * 目的は「ハンドラが始まったリクエストを返し切る」ことで、合図の瞬間の受信途中まで取りこぼさないことは目指さない。
 * - 直接つないだクライアントの keep-alive・HTTP/1.1 のパイプライン: 処理中の応答は返すが、同じ接続の
 *   次のリクエストは終了のときに接続ごと閉じられることがある（冪等なものはクライアントが再送する種類の切断）
 * - ヘッダーや本文を受信している途中の接続: 落ち着きの時間の中でハンドラが始まれば待つが、遅ければ待たない。
 *   本文を読み切る前に返した応答（413 など）が終了と重なり、RST と競合することもある
 * - メモリの上の状態（`position-eval.ts` の局面評価のジョブなど）は保存しない。終了で失われる
 *
 * - **2 回目以降の合図は無視する（ログだけ）。** 手順は自前の上限で必ず終わり、コンテナなら SIGKILL も来る。
 *   即終了にすると、合図を重ねて送る道具（`tsx watch`・`pnpm` の Ctrl+C）の下で毎回待たずに落ちる
 * - **終了コードは、手順を最後まで進めたら 0**（時間切れ・closer の失敗でも。ログに `warn`）。止めてと言われて
 *   止まったのであって、1 にすると再起動の方針や監視が障害と取り違える。手順が想定外の例外で崩れたときだけ 1
 */
import type { Server } from 'node:http';
import net from 'node:net';

/** 処理中のリクエストを待つ上限。7.5 + closer 0.5 × 2 + ログ 0.5 = 9 秒で、停止の猶予 10 秒に収める */
export const SHUTDOWN_TIMEOUT_MS = 7_500;
/** 処理中が 0 になってから、合図の瞬間に届きかけていたリクエストが始まるのを待つ時間 */
export const SETTLE_MS = 150;
/** closer 1 つを待つ上限 */
export const CLOSER_TIMEOUT_MS = 500;
/** 終了の前に標準出力の書き出しを待つ上限（`process.exit` は書き出し待ちのログを捨てることがある） */
export const LOG_FLUSH_TIMEOUT_MS = 500;

export interface Closer {
  name: string;
  close: () => Promise<void> | void;
}

export interface GracefulShutdownOptions {
  server: Server;
  /** 処理中のリクエストが片付いた後に、この順で閉じる */
  closers?: Closer[];
  timeoutMs?: number;
  settleMs?: number;
  closerTimeoutMs?: number;
  signals?: NodeJS.Signals[];
  // ↓ テストで差し替える（本物のプロセスを終了させない・本物の合図を登録しない）
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

export function installGracefulShutdown(options: GracefulShutdownOptions): {
  shutdown: (reason: string) => Promise<void>;
} {
  const {
    server,
    closers = [],
    timeoutMs = SHUTDOWN_TIMEOUT_MS,
    settleMs = SETTLE_MS,
    closerTimeoutMs = CLOSER_TIMEOUT_MS,
    signals = ['SIGTERM', 'SIGINT'],
    onSignal = (signal, handler) => process.on(signal, handler),
    exit = (code) =>
      void withTimeout(
        new Promise((resolve) => process.stdout.write('', resolve)),
        LOG_FLUSH_TIMEOUT_MS,
      ).then(() => process.exit(code)),
    log = (message) => console.log(message),
  } = options;

  // 処理中の応答の数。`finish` は本文を送信のバッファから書き終えたとき（`end()` の呼び出しではない）
  let inFlight = 0;
  let changed = () => {};
  server.on('request', (_req, res) => {
    inFlight++;
    changed();
    let counted = true;
    const done = () => {
      if (!counted) return;
      counted = false;
      inFlight--;
      changed();
    };
    res.once('finish', done);
    res.once('close', done);
  });

  const drain = () =>
    new Promise<boolean>((resolve) => {
      let settle: NodeJS.Timeout | undefined;
      const end = (ok: boolean) => {
        clearTimeout(deadline);
        clearTimeout(settle);
        changed = () => {};
        resolve(ok);
      };
      const deadline = setTimeout(() => end(false), timeoutMs);
      changed = () => {
        clearTimeout(settle);
        if (inFlight === 0) settle = setTimeout(() => end(true), settleMs);
      };
      changed();
    });

  const run = async (reason: string): Promise<number> => {
    log(
      `[shutdown] ${reason} を受けた。受け付けを止め、処理中のリクエストを待つ（上限 ${timeoutMs}ms）`,
    );
    // 受け付けだけを止める。http の close() は中で closeIdleConnections() を呼び、`end()` の後で
    // 送信のバッファに本文が残る応答も切る（Node 24 で確かめた）ので通さない
    net.Server.prototype.close.call(server);
    log(
      (await drain())
        ? '[shutdown] 処理中のリクエストが終わった'
        : `[shutdown] warn: ${timeoutMs}ms を過ぎたので待つのをやめた`,
    );
    for (const closer of closers) {
      const result = await withTimeout(
        Promise.resolve().then(closer.close),
        closerTimeoutMs,
      );
      if (result !== 'ok')
        log(`[shutdown] warn: ${closer.name} を閉じられなかった: ${result}`);
    }
    log('[shutdown] 終了する');
    return 0;
  };

  let started: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    if (started) {
      log(`[shutdown] ${reason} を受けたが、終了の手順はすでに進行中`);
      return started;
    }
    started = run(reason).then(exit, (error: unknown) => {
      log(
        `[shutdown] warn: 終了の手順が想定外の例外で崩れた: ${String(error)}`,
      );
      exit(1);
    });
    return started;
  };

  for (const signal of signals) onSignal(signal, () => void shutdown(signal));
  return { shutdown };
}

/** 上限つきで待つ。済めば 'ok'、失敗ならその理由、時間切れならその旨を返す（throw しない） */
async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`${ms}ms で時間切れ`), ms);
  });
  try {
    return await Promise.race([promise.then(() => 'ok', String), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
