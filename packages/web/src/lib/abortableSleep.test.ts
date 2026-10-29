import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortableSleep } from './abortableSleep';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('abortableSleep（取り下げられる待ち）', () => {
  it('時間が来たら戻る', async () => {
    let done = false;
    void abortableSleep(1000, new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('中断されたら待たずに戻り、タイマーを残さない', async () => {
    const controller = new AbortController();
    let done = false;
    void abortableSleep(60_000, controller.signal).then(() => (done = true));
    controller.abort();
    await Promise.resolve();
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('中断済みならすぐ戻る', async () => {
    const controller = new AbortController();
    controller.abort();
    await abortableSleep(60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });
});
