import http, { type Server, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGracefulShutdown,
  type GracefulShutdownOptions,
  SETTLE_MS,
} from './graceful-shutdown.js';

// 固定の待ち時間に頼らない: 「ハンドラが始まった」を Promise で待ってから手順を起動し、解放はテストから行う。
// 例外は「まだ進んでいない」ことを見る箇所だけ（落ち着きの時間を越えるまで待つ。`sleep`）

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const BIG = 8 * 1024 * 1024;

/**
 * 本物の serve() をランダムなポートで起こし、終了の手順を組み立てる（合図・exit・ログは差し替え）。
 * `/held` は始まったことを `started` で知らせ、`release()` されるまで返さない。
 * `/save` は接続が切れても保存を続けるハンドラの代わり（`saving` で始まりを知らせ、`finishSave()` まで終わらない）
 */
async function setup(extra: Partial<GracefulShutdownOptions> = {}) {
  const started = deferred();
  const gate = deferred();
  const saving = deferred();
  const saveGate = deferred();
  const app = new Hono()
    .get('/held', async (c) => {
      started.resolve();
      await gate.promise;
      return c.text('held done');
    })
    .get('/big', (c) => c.body(new Uint8Array(BIG).fill(97)))
    .get('/save', async (c) => {
      saving.resolve();
      await saveGate.promise;
      return c.text('saved');
    })
    .get('/fast', (c) => c.text('fast'));

  const handlers = new Map<string, () => void>();
  const exit = vi.fn<(code: number) => void>();
  const logs: string[] = [];
  const graceful = createGracefulShutdown({
    ...extra,
    onSignal: (signal, handler) => handlers.set(signal, handler),
    exit,
    log: (m) => logs.push(m),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: graceful.track(app.fetch), port: 0 }, () =>
      resolve(s as Server),
    );
  });
  current = {
    server,
    release: () => {
      gate.resolve();
      saveGate.resolve();
    },
  };
  const { shutdown } = graceful.install(server);
  return {
    server,
    port: (server.address() as AddressInfo).port,
    started: started.promise,
    release: () => gate.resolve(),
    saving: saving.promise,
    finishSave: () => saveGate.resolve(),
    handlers,
    /** 登録された合図のハンドラを呼ぶ（登録されていなければ失敗させる） */
    signal: (name: NodeJS.Signals) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`${name} のハンドラが登録されていない`);
      handler();
    },
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

describe('createGracefulShutdown', () => {
  it('処理中のリクエストを返し終えるまで新しい接続も受け付け、そのあと受け付けを止めて closer を順に閉じ、exit(0) する', async () => {
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
    t.signal('SIGTERM');
    // 待っているあいだに届いた新しい接続のリクエストも処理される（合図の時点で受け付けを止めると ECONNREFUSED になり、
    // 前段のプロキシでは 502 になる。infra-supra#206 のレビュー）
    expect(await get(t.port, '/fast')).toEqual({ status: 200, body: 'fast' });
    expect(order).toEqual([]);

    t.release();
    expect(await held).toEqual({ status: 200, body: 'held done' });
    await t.shutdown('test');
    expect(order).toEqual(['a', 'b']);
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
    // 手順が終わったあとは拒まれる
    expect(await get(t.port, '/fast')).toEqual({ error: 'ECONNREFUSED' });
  });

  it('大きな応答は、読むのが遅い相手にも書き終えてから exit する', async () => {
    const closed = vi.fn();
    const t = await setup({ closers: [{ name: 'db', close: closed }] });
    const ended = deferred<ServerResponse>();
    // 同期で返す応答はアプリのハンドラの中で end まで進むので、それより前に耳を付ける
    t.server.prependListener('request', (_req, res) =>
      res.once('prefinish', () => ended.resolve(res)),
    );
    let finishedAtExit: boolean | undefined;
    t.exit.mockImplementation(() => {
      finishedAtExit = res.writableFinished;
    });

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
    // 落ち着きの時間を越えても、書き出しが終わっていない間は先へ進まない（`end()` で数から外すと、ここで進む）
    await sleep(SETTLE_MS * 3);
    expect(res.writableFinished).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
    socket.resume();
    await all.promise;
    await done;
    expect(finishedAtExit).toBe(true);
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
    socket.destroy();
  });

  it('応答の前に接続が切れても、ハンドラが終わるまで closer と exit に進まない', async () => {
    const closed = vi.fn();
    const t = await setup({ closers: [{ name: 'db', close: closed }] });
    const responseClosed = deferred();
    t.server.on('request', (_req, res) =>
      res.once('close', () => responseClosed.resolve()),
    );

    const req = http.get({ port: t.port, path: '/save', agent: false });
    req.on('error', () => {});
    await t.saving;
    const done = t.shutdown('test');
    req.destroy(); // 利用者が応答を待たずに離れた（前段のプロキシが上流の接続を閉じた）
    await responseClosed.promise;
    // 応答の書き出しは数から外れたが、ハンドラ（保存）はまだ動いている
    await sleep(SETTLE_MS * 3);
    expect(closed).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();

    t.finishSave();
    await done;
    expect(closed).toHaveBeenCalledOnce();
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(t.logs.some((m) => m.includes('warn'))).toBe(false);
  });

  it('落ち着きの時間の中で新しい接続から始まったリクエストも返す', async () => {
    const t = await setup({ settleMs: 2_000 });

    const done = t.shutdown('test');
    // 処理中は 0。落ち着きの時間のうちに、新しい接続で次のリクエストが始まる（受け付けはまだ止めていない）
    const held = get(t.port, '/held');
    await t.started;
    // 処理中が 0 になった瞬間に先へ進んでいない（受け付けも止めていない）
    expect(t.logs.some((m) => m.includes('受け付けを止めた'))).toBe(false);
    expect(t.exit).not.toHaveBeenCalled();
    t.release();
    expect(await held).toEqual({ status: 200, body: 'held done' });
    await done;
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
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
    // 時間切れのあとで受け付けを止める
    const warn = t.logs.findIndex(
      (m) => m.includes('warn') && m.includes('100ms'),
    );
    expect(warn).toBeGreaterThanOrEqual(0);
    expect(t.logs.findIndex((m) => m.includes('受け付けを止めた'))).toBe(
      warn + 1,
    );
    expect(await get(t.port, '/fast')).toEqual({ error: 'ECONNREFUSED' });
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

  it('closer を始めた後に既存の接続から届いたリクエストは、アプリに渡さず 503 で断る', async () => {
    const closing = deferred();
    const finish = deferred();
    const t = await setup({
      closerTimeoutMs: 5_000,
      closers: [
        {
          name: 'db',
          close: () => {
            closing.resolve();
            return finish.promise;
          },
        },
      ],
    });
    let appCalled = false;
    void t.started.then(() => (appCalled = true));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    expect(await get(t.port, '/fast', agent)).toMatchObject({ status: 200 });

    const done = t.shutdown('test');
    await closing.promise;
    // closer を始めた時点で、新しい接続は拒まれ、既存の接続のリクエストは 503 で断られる
    expect(await get(t.port, '/fast')).toEqual({ error: 'ECONNREFUSED' });
    expect(await get(t.port, '/held', agent)).toEqual({
      status: 503,
      body: 'shutting down',
    });
    expect(appCalled).toBe(false);
    finish.resolve();
    await done;
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
    agent.destroy();
  });

  it('合図が 2 回来ても、手順は 1 回だけ動く', async () => {
    const closer = vi.fn();
    const t = await setup({ closers: [{ name: 'db', close: closer }] });

    t.signal('SIGTERM');
    t.signal('SIGINT');
    t.signal('SIGTERM');
    await t.shutdown('test');
    expect(closer).toHaveBeenCalledOnce();
    expect(t.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
