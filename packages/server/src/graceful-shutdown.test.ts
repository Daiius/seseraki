import http, { type Server, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type GracefulShutdownOptions,
  installGracefulShutdown,
} from './graceful-shutdown.js';

// 固定の待ち時間に頼らない: 「ハンドラが始まった」を Promise で待ってから手順を起動し、解放はテストから行う

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const BIG = 8 * 1024 * 1024;

/**
 * 本物の serve() をランダムなポートで起こし、終了の手順を組み立てる（合図・exit・ログは差し替え）。
 * `/held` は始まったことを `started` で知らせ、`release()` されるまで返さない
 */
async function setup(extra: Partial<GracefulShutdownOptions> = {}) {
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
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', (e: NodeJS.ErrnoException) =>
        resolve({ error: e.code ?? e.message }),
      );
    });
    req.on('error', (e: NodeJS.ErrnoException) =>
      resolve({ error: e.code ?? e.message }),
    );
  });
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
    expect(order).toEqual([]);

    t.release();
    expect(await held).toEqual({ status: 200, body: 'held done' });
    await t.shutdown('test');
    expect(order).toEqual(['a', 'b']);
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('大きな応答は、読むのが遅い相手にも書き終えてから exit する', async () => {
    const t = await setup();
    const ended = deferred<ServerResponse>();
    // 同期で返す応答はアプリのハンドラの中で end まで進むので、それより前に耳を付ける
    t.server.prependListener('request', (_req, res) =>
      res.once('prefinish', () => ended.resolve(res)),
    );
    let finishedAtExit: boolean | undefined;
    t.exit.mockImplementation(
      () => void (finishedAtExit = res.writableFinished),
    );

    const socket = net.connect(t.port);
    let received = 0;
    const all = deferred();
    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > BIG) all.resolve(); // ヘッダー + 本文
    });
    socket.pause(); // 読まない相手
    socket.write('GET /big HTTP/1.1\r\nHost: x\r\n\r\n');

    const res = await ended.promise;
    // end() は済んだが、本文はまだ送信のバッファに残っている
    expect(res.writableFinished).toBe(false);
    const done = t.shutdown('test');
    socket.resume();
    await all.promise;
    await done;
    expect(finishedAtExit).toBe(true);
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
    socket.destroy();
  });

  it('落ち着きの時間の中で始まったリクエストも返す', async () => {
    const t = await setup({ settleMs: 2_000 });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    expect(await get(t.port, '/fast', agent)).toMatchObject({ status: 200 });

    const done = t.shutdown('test');
    // 処理中は 0。既存の keep-alive の接続で、落ち着きの時間のうちに次のリクエストが始まる
    const held = get(t.port, '/held', agent);
    await t.started;
    expect(t.exit).not.toHaveBeenCalled(); // 処理中が 0 になった瞬間に先へ進んでいない
    t.release();
    expect(await held).toEqual({ status: 200, body: 'held done' });
    await done;
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
    agent.destroy();
  });

  it('アイドルの keep-alive の接続が残っていても、上限を待たずに終わる', async () => {
    const t = await setup(); // 上限は既定の 7.5 秒。待てばテストの上限（5 秒）で落ちる
    const agent = new http.Agent({ keepAlive: true });
    expect(await get(t.port, '/fast', agent)).toMatchObject({ status: 200 });

    await t.shutdown('test');
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(t.logs.some((m) => m.includes('warn'))).toBe(false);
    agent.destroy();
  });

  it('上限を過ぎても終わらないリクエストは待つのをやめて先へ進む', async () => {
    const closed = vi.fn();
    const t = await setup({
      timeoutMs: 100,
      closers: [{ name: 'db', close: closed }],
    });

    void get(t.port, '/held');
    await t.started;
    await t.shutdown('test');
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
