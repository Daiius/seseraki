import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
  解答の往復（`requestAnswer` / `requestGiveUp`）の取り下げ。通信は honoClient を差し替えて、
  ステータスと本文だけを返す（実際の fetch はしない）。
*/

type FakeResponse = { status: number; ok: boolean; json: () => Promise<unknown> };
type Call = { init?: RequestInit };

const calls = vi.hoisted(() => ({
  answer: [] as Call[],
  poll: [] as Call[],
  giveUp: [] as Call[],
  answerReplies: [] as (() => Promise<FakeResponse>)[],
  pollReplies: [] as (() => Promise<FakeResponse>)[],
  giveUpReplies: [] as (() => Promise<FakeResponse>)[],
}));

vi.mock('./honoClient', () => {
  const next = (queue: (() => Promise<FakeResponse>)[]) => {
    const reply = queue.shift();
    if (!reply) throw new Error('想定外の通信');
    return reply();
  };
  return {
    baseUrl: '',
    client: {
      api: {
        drills: {
          ':kifuNo': {
            ':moveNumber': {
              ':kind': {
                answer: {
                  $post: (_args: unknown, options?: { init?: RequestInit }) => {
                    calls.answer.push({ init: options?.init });
                    return next(calls.answerReplies);
                  },
                },
                'give-up': {
                  $post: (_args: unknown, options?: { init?: RequestInit }) => {
                    calls.giveUp.push({ init: options?.init });
                    return next(calls.giveUpReplies);
                  },
                },
              },
            },
          },
        },
        positions: {
          evaluate: {
            ':jobId': {
              $get: (_args: unknown, options?: { init?: RequestInit }) => {
                calls.poll.push({ init: options?.init });
                return next(calls.pollReplies);
              },
            },
          },
        },
      },
    },
  };
});

import { pause, requestAnswer, requestGiveUp, type Drill } from './drillApi';

const DRILL = { kifuNo: 1, moveNumber: 10, kind: 'mate' } as Drill;
const BODY = { line: ['2g2f'] };

const reply = (status: number, body: unknown) => () =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body });

/** signal が中断されたら AbortError で落ちる応答（fetch と同じ振る舞い） */
const hangUntilAbort = () => () =>
  new Promise<FakeResponse>((_resolve, reject) => {
    const signal = (calls.answer.at(-1) ?? calls.giveUp.at(-1))?.init?.signal;
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const queue of Object.values(calls)) queue.length = 0;
});

describe('pause（取り下げられる待ち）', () => {
  it('時間が来たら戻る', async () => {
    let done = false;
    void pause(1000, new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('中断されたら待たずに戻り、タイマーを残さない', async () => {
    const controller = new AbortController();
    let done = false;
    void pause(60_000, controller.signal).then(() => (done = true));
    controller.abort();
    await Promise.resolve();
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('中断済みならすぐ戻る', async () => {
    const controller = new AbortController();
    controller.abort();
    await pause(60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('requestAnswer の取り下げ（画面を離れた）', () => {
  it('通信に取り下げの合図を渡す', async () => {
    const controller = new AbortController();
    calls.answerReplies.push(reply(200, { status: 'continue', reply: '3c3d' }));
    const outcome = await requestAnswer(DRILL, BODY, 'worker', controller.signal);
    expect(outcome).toEqual({ kind: 'continue', reply: '3c3d' });
    expect(calls.answer[0].init?.signal).toBe(controller.signal);
  });

  it('🔴 判定待ちのポーリング中に取り下げたら aborted を返し、それ以上叩かない', async () => {
    const controller = new AbortController();
    calls.answerReplies.push(reply(202, { jobId: 'job-1' }));
    const pending = requestAnswer(DRILL, BODY, 'worker', controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.answer).toHaveLength(1);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
    expect(calls.poll).toHaveLength(0);
    expect(calls.answer).toHaveLength(1);
  });

  it('通信の途中で取り下げたら、接続できない旨ではなく aborted', async () => {
    const controller = new AbortController();
    calls.answerReplies.push(hangUntilAbort());
    const pending = requestAnswer(DRILL, BODY, 'worker', controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
  });

  it('🔴 応答が届いたときに取り下げ済みなら、結果を返さない（古い応答で記録させない）', async () => {
    const controller = new AbortController();
    let deliver: (r: FakeResponse) => void = () => {};
    calls.answerReplies.push(() => new Promise<FakeResponse>((resolve) => (deliver = resolve)));
    const pending = requestAnswer(DRILL, BODY, 'worker', controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    deliver({ status: 200, ok: true, json: async () => ({ status: 'done', verdict: 'correct' }) });
    expect(await pending).toEqual({ kind: 'aborted' });
  });

  it('取り下げ済みなら送らない', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await requestAnswer(DRILL, BODY, 'worker', controller.signal)).toEqual({ kind: 'aborted' });
    expect(calls.answer).toHaveLength(0);
  });

  it('取り下げていない通信断は今までどおり接続できない旨', async () => {
    calls.answerReplies.push(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await requestAnswer(DRILL, BODY, 'worker', new AbortController().signal)).toEqual({
      kind: 'fail',
      text: 'サーバーに接続できません',
      waitEngineFrom: null,
    });
  });
});

describe('requestGiveUp の取り下げ', () => {
  it('🔴 応答が届いたときに取り下げ済みなら aborted（記録させない）', async () => {
    const controller = new AbortController();
    let deliver: (r: FakeResponse) => void = () => {};
    calls.giveUpReplies.push(() => new Promise<FakeResponse>((resolve) => (deliver = resolve)));
    const pending = requestGiveUp(DRILL, [], false, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.giveUp[0].init?.signal).toBe(controller.signal);
    controller.abort();
    deliver({ status: 200, ok: true, json: async () => ({ status: 'done', verdict: 'wrong' }) });
    expect(await pending).toEqual({ kind: 'aborted' });
  });

  it('通信の途中で取り下げたら aborted', async () => {
    const controller = new AbortController();
    calls.giveUpReplies.push(hangUntilAbort());
    const pending = requestGiveUp(DRILL, [], false, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
  });
});
