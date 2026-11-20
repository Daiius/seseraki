import http, { type Server, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Closer, installGracefulShutdown } from './graceful-shutdown.js';

// 固定の待ち時間に頼らない: 「ハンドラが始まった」「サーバーが受け取った」を Promise で待ってから手順を起動する

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const BIG = 8 * 1024 * 1024;

/**
 * 本物の serve() をランダムなポートで起こし、終了の手順を組み立てる（合図・exit・ログは差し替え。本物のプロセスを終了させない）。
 * `/held` は始まったことを `started` で知らせ、テストが `release()` するまで返さない
 */
async function setup(
  extra: {
    closers?: Closer[];
    timeoutMs?: number;
    closerTimeoutMs?: number;
  } = {},
) {
  const started = deferred();
  const gate = deferred();
  const app = new Hono()
    .get('/held', async (c) => {
      started.resolve();
      await gate.promise;
      return c.text('held done');
    })
    .get('/big', (c) => c.body(new Uint8Array(BIG).fill(97)))
    .get('/fast', (c) => c.text('fast'));
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s as Server));
  });
  current = { server, release: gate.resolve };

  const handlers = new Map<string, () => void>();
  const exit = vi.fn<(code: number) => void>();
  const logs: string[] = [];
  const { shutdown } = installGracefulShutdown({
    server,
    ...extra,
    onSignal: (signal, handler) => handlers.set(signal, handler),
    exit,
    log: (m) => logs.push(m),
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    started: started.promise,
    release: () => gate.resolve(),
    handlers,
    exit,
    logs,
    shutdown,
  };
}

interface Result {
  status?: number;
  connection?: string;
  body?: string;
  error?: string;
}

function get(
  port: number,
  path: string,
  agent: http.Agent | false = false,
): Promise<Result> {
  return new Promise((resolve) => {
    const req = http.get({ port, path, agent }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          connection: res.headers.connection,
          body,
        }),
      );
      res.on('error', (e: NodeJS.ErrnoException) =>
        resolve({ error: e.code ?? e.message }),
      );
    });
    req.on('error', (e: NodeJS.ErrnoException) =>
      resolve({ error: e.code ?? e.message }),
    );
  });
}

/** 生のソケット。受け取ったバイト列を、相手が閉じるまで貯める */
function rawSocket(port: number) {
  const socket = net.connect(port);
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  const closed = new Promise<Buffer>((resolve) =>
    socket.on('close', () => resolve(Buffer.concat(chunks))),
  );
  return { socket, closed };
}

/** サーバーがリクエストを n 件受け取ったら解決する */
function requestsReceived(
  server: Server,
  n: number,
): Promise<ServerResponse[]> {
  const seen: ServerResponse[] = [];
  const done = deferred<ServerResponse[]>();
  server.on('request', (_req, res) => {
    seen.push(res);
    if (seen.length === n) done.resolve(seen);
  });
  return done.promise;
}

let current: { server: Server; release: () => void } | undefined;
afterEach(() => {
  current?.release();
  current?.server.closeAllConnections();
  current?.server.close();
  current = undefined;
});

describe('installGracefulShutdown', () => {
  it('処理中のリクエストを 200 で返し終えてから closer を順に閉じ、exit(0) する', async () => {
    const order: string[] = [];
    const t = await setup({
      closers: [
        { name: 'a', close: async () => void order.push('a') },
        { name: 'b', close: () => void order.push('b') },
      ],
    });
    expect([...t.handlers.keys()]).toEqual(['SIGTERM', 'SIGINT']);

    const held = get(t.port, '/held');
    await t.started;
    t.handlers.get('SIGTERM')!();
    // 停止の途中の新しい接続は拒まれる
    expect(await get(t.port, '/fast')).toEqual({ error: 'ECONNREFUSED' });
    expect(t.exit).not.toHaveBeenCalled();

    t.release();
    // 処理中だった応答は最後まで返り、相手が接続を使い回さないよう Connection: close が付く
    expect(await held).toEqual({
      status: 200,
      connection: 'close',
      body: 'held done',
    });
    await t.shutdown('test');
    expect(order).toEqual(['a', 'b']);
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('アイドルの keep-alive の接続は、keepAliveTimeout を待たずに閉じる', async () => {
    const t = await setup();
    t.server.keepAliveTimeout = 60_000; // 閉じなければテストの上限（5 秒）で落ちる
    const agent = new http.Agent({ keepAlive: true });
    expect(await get(t.port, '/fast', agent)).toMatchObject({
      status: 200,
      connection: 'keep-alive',
    });

    await t.shutdown('test');
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
    agent.destroy();
  });

  it('送信のバッファに残っている大きな応答は、読むのが遅い相手にも最後まで届ける', async () => {
    const t = await setup();
    const ended = deferred<ServerResponse>();
    // 同期で返す応答はアプリのハンドラの中で end まで進むので、それより前に耳を付ける
    t.server.prependListener('request', (_req, res) =>
      res.once('prefinish', () => ended.resolve(res)),
    );
    const { socket, closed } = rawSocket(t.port);
    socket.pause(); // 読まない相手
    socket.write('GET /big HTTP/1.1\r\nHost: x\r\n\r\n');

    const res = await ended.promise;
    // res.end() は済んだが、本文はまだ書き終えていない（ここで http の closeIdleConnections() を呼ぶと切れる）
    expect(res.writableFinished).toBe(false);
    const done = t.shutdown('test');
    socket.resume();

    const raw = await closed;
    const headerEnd = raw.indexOf('\r\n\r\n') + 4;
    expect(raw.subarray(0, headerEnd).toString()).toMatch(/^HTTP\/1\.1 200/);
    expect(raw.length - headerEnd).toBe(BIG);
    await done;
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('パイプラインで重なったリクエストも、全部の応答を返してから接続を閉じる', async () => {
    const t = await setup();
    const received = requestsReceived(t.server, 3);
    const { socket, closed } = rawSocket(t.port);
    socket.write('GET /held HTTP/1.1\r\nHost: x\r\n\r\n');
    await t.started;
    const done = t.shutdown('test');
    socket.write(
      'GET /fast HTTP/1.1\r\nHost: x\r\n\r\nGET /fast HTTP/1.1\r\nHost: x\r\n\r\n',
    );
    await received;
    t.release();

    const responses = (await closed).toString().split(/(?=HTTP\/1\.1 )/);
    expect(responses).toHaveLength(3);
    expect(responses[0]).toMatch(/^HTTP\/1\.1 200[\s\S]*held done$/);
    expect(responses[1]).toMatch(/^HTTP\/1\.1 200[\s\S]*fast$/);
    expect(responses[2]).toMatch(/^HTTP\/1\.1 200[\s\S]*fast$/);
    await done;
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('上限を過ぎても終わらないリクエストは打ち切って先へ進む', async () => {
    const closed = vi.fn();
    const t = await setup({
      timeoutMs: 100,
      closers: [{ name: 'db', close: closed }],
    });

    const held = get(t.port, '/held');
    await t.started;
    await t.shutdown('test');
    expect((await held).error).toBeDefined();
    expect(closed).toHaveBeenCalledOnce();
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(t.logs.some((m) => m.includes('warn') && m.includes('100ms'))).toBe(
      true,
    );
  });

  it('closer が失敗・固まっても、残りの closer と exit は動く', async () => {
    const last = vi.fn();
    const t = await setup({
      closerTimeoutMs: 50,
      closers: [
        {
          name: 'throws',
          close: () => {
            throw new Error('boom');
          },
        },
        { name: 'rejects', close: () => Promise.reject(new Error('nope')) },
        { name: 'hangs', close: () => new Promise<void>(() => {}) },
        { name: 'last', close: last },
      ],
    });

    await t.shutdown('test');
    expect(last).toHaveBeenCalledOnce();
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
    const warns = t.logs.filter((m) => m.includes('warn'));
    expect(warns).toHaveLength(3);
    expect(warns.join('\n')).toMatch(
      /throws.*boom[\s\S]*rejects.*nope[\s\S]*hangs.*時間切れ/,
    );
  });

  it('合図が 2 回来ても、手順は 1 回だけ動く', async () => {
    const closer = vi.fn();
    const t = await setup({ closers: [{ name: 'db', close: closer }] });

    t.handlers.get('SIGTERM')!();
    t.handlers.get('SIGINT')!();
    t.handlers.get('SIGTERM')!();
    await t.shutdown('test');
    expect(closer).toHaveBeenCalledOnce();
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
