// 接続のセッションを UTC に固定していることを固定するテスト。
//
// 🔴 **これが抜けると症状が静かに戻る。** `SET time_zone` を流さない接続が 1 つでもあると、
// その接続で読んだ `createdAt` / `updatedAt` だけが +9h 未来に見える
// （プールなのでリクエストごとに当たり外れが出て、余計に気づきにくい）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

type ConnectionHandler = (connection: unknown) => void;

const handlers: ConnectionHandler[] = [];

vi.mock('mysql2/promise', () => ({
  default: {
    createPool: () => ({
      on: (event: string, handler: ConnectionHandler) => {
        if (event === 'connection') handlers.push(handler);
      },
    }),
  },
}));

vi.mock('drizzle-orm/mysql2', () => ({ drizzle: () => ({}) }));

beforeEach(() => {
  handlers.length = 0;
  vi.resetModules();
});

/** プールが新しい接続を配る直前に流すクエリを集める */
async function queriesOnNewConnection(fail = false): Promise<string[]> {
  await import('./index.js');
  expect(handlers).toHaveLength(1);

  const issued: string[] = [];
  let destroyed = false;
  handlers[0]!({
    query: (sql: string, cb: (err: unknown) => void) => {
      issued.push(sql);
      cb(fail ? new Error('boom') : null);
    },
    destroy: () => {
      destroyed = true;
    },
  });
  if (fail) expect(destroyed).toBe(true);
  return issued;
}

describe('DB 接続のセッション時刻帯', () => {
  it("新しい接続ごとに SET time_zone = '+00:00' を流す", async () => {
    expect(await queriesOnNewConnection()).toEqual(["SET time_zone = '+00:00'"]);
  });

  it('設定に失敗したら接続を壊す（JST のまま黙って使わせない）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await queriesOnNewConnection(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
