/**
 * **停止の合図（SIGTERM / SIGINT）で、処理中のリクエストを終えてから終了する。**
 *
 * 手順: 新しい接続の受け付けを止める → 処理中のリクエストが終わるのを待つ（上限 {@link SHUTDOWN_TIMEOUT_MS}）
 * → 上限を過ぎたら残りの接続を切る → 資源（DB のプールなど）を順に閉じる → `exit`。
 *
 * ⚠ **合図を受けるにはハンドラを登録するしかない。** コンテナで node が PID 1 のとき、ハンドラの無い合図は
 * 無視され、停止の猶予が切れて SIGKILL で落ちる（処理中のリクエストもそこで切れる）。
 * ⚠ メモリの上の状態（`position-eval.ts` の局面評価のジョブなど）は保存しない。終了で失われる。
 *
 * Node の標準の API だけで書く（ほかの Hono のサーバーへ写せるように。`@hono/node-server` にも依存しない）。
 */
import type { Server } from 'node:http';

/**
 * 処理中のリクエストを待つ上限。**コンテナの停止の猶予（docker の既定は 10 秒）より短くする**——
 * 超えると SIGKILL で資源を閉じる前に落ちる。この後の closer の上限（{@link CLOSER_TIMEOUT_MS} × 個数）と
 * 足しても猶予に収まるようにする（8 秒 + 0.5 秒 × 2 = 9 秒）。
 */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

/** closer 1 つを待つ上限。固まった closer が終了を止めないように */
export const CLOSER_TIMEOUT_MS = 500;

/**
 * 待っている間に、アイドルになった keep-alive の接続を閉じ直す間隔。
 * `server.close()` が閉じるのは**呼んだ時点で**アイドルの接続だけで、処理中だった接続は応答の後に
 * keep-alive のまま残る（Node 24 で確かめた。`keepAliveTimeout` の 5 秒まで `close` が終わらない）。
 * 前段のリバースプロキシが上流への接続を使い回すと、これが無いと上限まで待つことになる。
 */
const IDLE_SWEEP_MS = 100;

export interface Closer {
  /** ログに出す名前 */
  name: string;
  close: () => Promise<void> | void;
}

export interface GracefulShutdownOptions {
  server: Server;
  /** 接続が片付いた後に、この順で閉じる */
  closers?: Closer[];
  timeoutMs?: number;
  closerTimeoutMs?: number;
  signals?: NodeJS.Signals[];
  // ↓ テストで差し替える（本物のプロセスを終了させない・本物の合図を登録しない）
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

/**
 * 合図のハンドラを登録する。戻り値の `shutdown` は手順そのもの（テストと、合図以外から止めたいとき用）。
 *
 * - **2 回目以降の合図は無視する（ログだけ）。** 手順は自前の上限で必ず終わり、コンテナの停止なら
 *   猶予の後に SIGKILL も来る。即終了にすると、合図を子へ重ねて送る道具（`tsx watch`・`pnpm` の Ctrl+C）の
 *   下で毎回待たずに落ちてしまう
 * - **終了コードは、手順を最後まで進めたら 0**（時間切れ・closer の失敗でも。ログに `warn` で出す）。
 *   止めてと言われて止まったのであって異常終了ではない——1 にすると、再起動の方針や監視が障害と取り違える。
 *   手順そのものが想定外の例外で崩れたときだけ 1
 * - 停止の途中に届いたリクエスト: `server.close()` の後は新しい接続を受けない（接続を拒まれる）。
 *   既存の keep-alive の接続に来た次のリクエストは処理し、`Connection: close` を付けて接続を閉じる
 *   （Node は自分では付けないので、下の `request` のハンドラで付ける）
 */
export function installGracefulShutdown(options: GracefulShutdownOptions): {
  shutdown: (reason: string) => Promise<void>;
} {
  const {
    server,
    closers = [],
    timeoutMs = SHUTDOWN_TIMEOUT_MS,
    closerTimeoutMs = CLOSER_TIMEOUT_MS,
    signals = ['SIGTERM', 'SIGINT'],
    onSignal = (signal, handler) => process.on(signal, handler),
    exit = (code) => process.exit(code),
    log = (message) => console.log(message),
  } = options;

  let started: Promise<void> | null = null;

  const shutdown = (reason: string): Promise<void> => {
    if (started) {
      log(`[shutdown] ${reason} を受けたが、終了の手順はすでに進行中`);
      return started;
    }
    started = run(reason).then(
      (code) => exit(code),
      (error: unknown) => {
        log(
          `[shutdown] warn: 終了の手順が想定外の例外で崩れた: ${String(error)}`,
        );
        exit(1);
      },
    );
    return started;
  };

  const run = async (reason: string): Promise<number> => {
    log(
      `[shutdown] ${reason} を受けた。新しい接続を止め、処理中のリクエストを待つ（上限 ${timeoutMs}ms）`,
    );

    // 既存の keep-alive の接続に来たリクエストは、応答の後に接続を閉じる
    server.prependListener('request', (_req, res) => {
      if (!res.headersSent) res.setHeader('Connection', 'close');
    });

    const drained = await new Promise<boolean>((resolve) => {
      const sweep = setInterval(
        () => server.closeIdleConnections(),
        IDLE_SWEEP_MS,
      );
      const deadline = setTimeout(() => {
        clearInterval(sweep);
        // 残りの接続を切ると `close` のコールバックも呼ばれるが、resolve は先にここで済ませる
        resolve(false);
        server.closeAllConnections();
      }, timeoutMs);
      server.close(() => {
        clearInterval(sweep);
        clearTimeout(deadline);
        resolve(true);
      });
      server.closeIdleConnections();
    });
    log(
      drained
        ? '[shutdown] 処理中のリクエストが終わった'
        : `[shutdown] warn: ${timeoutMs}ms を過ぎたので残りの接続を切った`,
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

  for (const signal of signals) onSignal(signal, () => void shutdown(signal));
  return { shutdown };
}

async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`${ms}ms で時間切れ`), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => 'ok',
        (error: unknown) => String(error),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
