import http, { type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Closer, installGracefulShutdown } from './graceful-shutdown.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 本物の serve() をランダムなポートで起こす。`/slow` は 300ms、`/hang` は応答しない */
async function startServer(): Promise<{ server: Server; port: number }> {
  const app = new Hono()
    .get('/slow', async (c) => {
      await sleep(300);
      return c.text('slow done');
    })
    .get('/hang', () => new Promise<Response>(() => {}))
    .get('/fast', (c) => c.text('fast'));
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s as Server));
  });
  return { server, port: (server.address() as AddressInfo).port };
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

/** 合図・exit・ログを差し替えて組み立てる（本物のプロセスを終了させない） */
function install(
  server: Server,
  extra: {
    closers?: Closer[];
    timeoutMs?: number;
    closerTimeoutMs?: number;
  } = {},
) {
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
  return { handlers, exit, logs, shutdown };
}

let current: Server | undefined;
afterEach(() => {
  current?.closeAllConnections();
  current?.close();
  current = undefined;
});

describe('installGracefulShutdown', () => {
  it('処理中のリクエストを 200 で返し終えてから closer を順に閉じ、exit(0) する', async () => {
    const { server, port } = await startServer();
    current = server;
    const order: string[] = [];
    const { handlers, exit, shutdown } = install(server, {
      closers: [
        { name: 'a', close: async () => void order.push('a') },
        { name: 'b', close: () => void order.push('b') },
      ],
    });
    expect([...handlers.keys()]).toEqual(['SIGTERM', 'SIGINT']);

    const slow = get(port, '/slow');
    await sleep(50);
    handlers.get('SIGTERM')!();
    // 停止の途中の新しい接続は拒まれる
    expect(await get(port, '/fast')).toEqual({ error: 'ECONNREFUSED' });

    expect(await slow).toMatchObject({ status: 200, body: 'slow done' });
    await shutdown('test');
    expect(order).toEqual(['a', 'b']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('keep-alive の接続が残っていても、keepAliveTimeout を待たずに終わる', async () => {
    const { server, port } = await startServer();
    current = server;
    const agent = new http.Agent({ keepAlive: true });
    const { exit, shutdown } = install(server);

    // 止めた時点で処理中だった keep-alive の接続は、応答の後にアイドルで残る（server.close() は閉じない）
    const slow = get(port, '/slow', agent);
    await sleep(50);
    const t0 = Date.now();
    const done = shutdown('test');

    expect(await slow).toMatchObject({ status: 200, connection: 'keep-alive' });
    await done;
    expect(Date.now() - t0).toBeLessThan(2_000); // keepAliveTimeout は 5 秒
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    agent.destroy();
  });

  it('停止の途中に既存の keep-alive の接続へ来たリクエストは、Connection: close で返す', async () => {
    const { server, port } = await startServer();
    current = server;
    const { shutdown } = install(server);

    // 生のソケットで /slow を送り、処理中（アイドルでない）のうちに止めてから、同じ接続へ /fast を重ねる
    const socket = net.connect(port);
    let raw = '';
    socket.on('data', (chunk) => (raw += chunk));
    const ended = new Promise((resolve) => socket.on('close', resolve));
    socket.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n');
    await sleep(50);
    const done = shutdown('test');
    socket.write('GET /fast HTTP/1.1\r\nHost: x\r\n\r\n');
    await ended;
    await done;

    const responses = raw.split(/(?=HTTP\/1\.1 )/);
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatch(/^HTTP\/1\.1 200[\s\S]*slow done$/);
    expect(responses[1]).toMatch(/^HTTP\/1\.1 200/);
    expect(responses[1]).toMatch(/\r\nConnection: close\r\n/i);
    expect(responses[1]).toMatch(/fast$/);
  });

  it('上限を過ぎても終わらないリクエストは打ち切って先へ進む', async () => {
    const { server, port } = await startServer();
    current = server;
    const closed = vi.fn();
    const { exit, logs, shutdown } = install(server, {
      timeoutMs: 200,
      closers: [{ name: 'db', close: closed }],
    });

    const hang = get(port, '/hang');
    await sleep(50);
    const t0 = Date.now();
    await shutdown('test');
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect((await hang).error).toBeDefined();
    expect(closed).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logs.some((m) => m.includes('warn') && m.includes('200ms'))).toBe(
      true,
    );
  });

  it('closer が失敗・固まっても、残りの closer と exit は動く', async () => {
    const { server } = await startServer();
    current = server;
    const last = vi.fn();
    const { exit, logs, shutdown } = install(server, {
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

    await shutdown('test');
    expect(last).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    const warns = logs.filter((m) => m.includes('warn'));
    expect(warns).toHaveLength(3);
    expect(warns.join('\n')).toMatch(
      /throws.*boom[\s\S]*rejects.*nope[\s\S]*hangs.*時間切れ/,
    );
  });

  it('合図が 2 回来ても、手順は 1 回だけ動く', async () => {
    const { server } = await startServer();
    current = server;
    const closer = vi.fn();
    const { handlers, exit, shutdown } = install(server, {
      closers: [{ name: 'db', close: closer }],
    });

    handlers.get('SIGTERM')!();
    handlers.get('SIGINT')!();
    handlers.get('SIGTERM')!();
    await shutdown('test');
    expect(closer).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
