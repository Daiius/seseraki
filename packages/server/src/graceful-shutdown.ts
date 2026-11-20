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
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import net from 'node:net';

/**
 * 処理中のリクエストを待つ上限。**コンテナの停止の猶予（docker の既定は 10 秒）より短くする**——
 * 超えると SIGKILL で資源を閉じる前に落ちる。後ろの closer（{@link CLOSER_TIMEOUT_MS} × 個数）と
 * ログの書き出し（{@link LOG_FLUSH_TIMEOUT_MS}）を足しても猶予に収める（7.5 + 0.5 × 2 + 0.5 = 9 秒）。
 */
export const SHUTDOWN_TIMEOUT_MS = 7_500;

/** closer 1 つを待つ上限。固まった closer が終了を止めないように */
export const CLOSER_TIMEOUT_MS = 500;

/** 終了の前に標準出力の書き出しを待つ上限（ログの収集が詰まっていても終了は止めない） */
export const LOG_FLUSH_TIMEOUT_MS = 500;

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
 * **サーバーを起こした直後に呼ぶ**（停止の前から、接続ごとに処理中の応答を数えておくため）。
 *
 * - **2 回目以降の合図は無視する（ログだけ）。** 手順は自前の上限で必ず終わり、コンテナの停止なら
 *   猶予の後に SIGKILL も来る。即終了にすると、合図を子へ重ねて送る道具（`tsx watch`・`pnpm` の Ctrl+C）の
 *   下で毎回待たずに落ちてしまう
 * - **終了コードは、手順を最後まで進めたら 0**（時間切れ・closer の失敗でも。ログに `warn` で出す）。
 *   止めてと言われて止まったのであって異常終了ではない——1 にすると、再起動の方針や監視が障害と取り違える。
 *   手順そのものが想定外の例外で崩れたときだけ 1
 * - **接続は「処理中の応答が 0 になったら」自分で閉じる。** `http.Server` の `close()` /
 *   `closeIdleConnections()` は使わない——`res.end()` を呼んだ後は送信のバッファに本文が残っていても
 *   アイドルと見なして切る（Node 24 で確かめた。遅い相手への 8MB の応答が 2.6MB で切れた）。
 *   ここでは応答の `finish`（本文を書き終えた）まで数え、受け付けの停止は `net.Server` の `close` だけを使う
 * - 停止の途中に届いたリクエスト: 新しい接続は拒まれる。既存の keep-alive の接続に来たものは処理する。
 *   処理中の応答に `Connection: close` を付け、相手がその接続を使い回さないようにする（`markClose`）。
 *   ⚠ パイプライン: 停止の後に `Connection: close` 付きでヘッダーを送り始めた応答の後ろへ、さらに
 *   リクエストが重なると、その応答で Node が接続を閉じ、後ろは失われる。前段のリバースプロキシは上流へ
 *   パイプラインせず、主要なクライアントも使わないので対象外にした
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
    exit = (code) => void flushStdout().then(() => process.exit(code)),
    log = (message) => console.log(message),
  } = options;

  // 接続ごとの、処理中（finish の前）の応答。停止の前から数える
  const pending = new Map<net.Socket, Set<ServerResponse>>();
  let stopping = false;

  // 処理中の応答が 1 つだけなら `Connection: close` を付ける。パイプラインで 2 つ以上なら、
  // まだ送っていない応答から外す（付けた応答の後で Node が接続を閉じ、後ろの応答が失われるため）。
  // そのときの接続は、処理中が 0 になった時点で下の `done` が閉じる
  const markClose = (socket: net.Socket) => {
    const set = pending.get(socket) ?? new Set();
    for (const r of set) {
      if (r.headersSent) continue;
      if (set.size === 1) r.setHeader('Connection', 'close');
      else r.removeHeader('Connection');
    }
  };

  server.on('connection', (socket: net.Socket) => {
    pending.set(socket, new Set());
    socket.once('close', () => pending.delete(socket));
  });
  // アプリのハンドラより先に動かす（同期で返す応答は、ハンドラの中でヘッダーを書き終える）
  server.prependListener(
    'request',
    (req: IncomingMessage, res: ServerResponse) => {
      const socket = req.socket;
      pending.get(socket)?.add(res);
      if (stopping) markClose(socket);
      const done = () => {
        const set = pending.get(socket);
        if (!set?.delete(res)) return;
        if (stopping && set.size === 0) socket.destroy();
      };
      res.once('finish', done);
      res.once('close', done);
    },
  );

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
    stopping = true;

    const drained = await new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => {
        resolve(false);
        for (const socket of pending.keys()) socket.destroy();
      }, timeoutMs);
      // 受け付けだけを止める（http の close は上のとおり送信中の応答を切るので通さない）。
      // コールバックは全部の接続が閉じたときに呼ばれる
      net.Server.prototype.close.call(server, () => {
        clearTimeout(deadline);
        resolve(true);
      });
      for (const [socket, set] of pending) {
        if (set.size === 0) socket.destroy();
        else markClose(socket);
      }
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

/**
 * 標準出力の書き出しを待つ（上限つき）。`process.exit` は書き出し待ちのログを待たずに捨てることがある。
 * 空の書き込みのコールバックは、それより前の書き込みが済んだ後に呼ばれる
 */
function flushStdout(): Promise<unknown> {
  return withTimeout(
    new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
    LOG_FLUSH_TIMEOUT_MS,
  );
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
