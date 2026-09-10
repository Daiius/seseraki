import { describe, expect, it } from 'vitest';
import {
  createThrottle,
  isSafari,
  minIntervalFor,
  DEFAULT_MIN_INTERVAL_MS,
  SAFARI_MIN_INTERVAL_MS,
} from './historyThrottle';

/** 実時間を待たずに throttle を検証するための時計。`schedule` は手で進める */
function fakeClock() {
  let current = 1000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    clock: {
      now: () => current,
      schedule: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.push({ at: current + ms, fn, id });
        return id;
      },
      cancelScheduled: (handle: unknown) => {
        const i = timers.findIndex((t) => t.id === handle);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    /** ms 進め、期限の来たタイマーを発火する */
    advance: (ms: number) => {
      current += ms;
      const due = timers.filter((t) => t.at <= current).sort((a, b) => a.at - b.at);
      for (const t of due) {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
        t.fn();
      }
    },
    pendingTimers: () => timers.length,
  };
}

describe('isSafari', () => {
  it('vendor が Apple なら Safari', () => {
    expect(isSafari({ vendor: 'Apple Computer, Inc.', userAgent: 'whatever' })).toBe(true);
  });

  it('Chrome の UA には Safari が入るが Safari ではない', () => {
    expect(
      isSafari({
        vendor: 'Google Inc.',
        userAgent:
          'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      }),
    ).toBe(false);
  });

  it('Android の Chrome も Safari ではない', () => {
    expect(
      isSafari({
        vendor: 'Google Inc.',
        userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      }),
    ).toBe(false);
  });

  it('vendor が取れなくても UA だけで iOS Safari を拾える', () => {
    expect(
      isSafari({
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      }),
    ).toBe(true);
  });
});

describe('minIntervalFor', () => {
  it('Safari は 310ms（30 秒 100 回 = 平均 300ms を上回る値）', () => {
    expect(minIntervalFor({ vendor: 'Apple Computer, Inc.' })).toBe(SAFARI_MIN_INTERVAL_MS);
  });

  it('それ以外は既定値', () => {
    expect(minIntervalFor({ vendor: 'Google Inc.', userAgent: 'Chrome/140.0' })).toBe(
      DEFAULT_MIN_INTERVAL_MS,
    );
  });

  it('navigator が無い環境（SSR・テスト）でも既定値を返す', () => {
    expect(minIntervalFor(undefined)).toBe(DEFAULT_MIN_INTERVAL_MS);
  });
});

describe('createThrottle', () => {
  it('最初の 1 回は即座に適用する（1 手進めたら URL もすぐ動く）', () => {
    const applied: number[] = [];
    const { clock } = fakeClock();
    const t = createThrottle<number>((v) => applied.push(v), 100, clock);

    t.push(1);
    expect(applied).toEqual([1]);
  });

  it('間隔内の連打は最後の値だけを適用する', () => {
    const applied: number[] = [];
    const { clock, advance } = fakeClock();
    const t = createThrottle<number>((v) => applied.push(v), 100, clock);

    t.push(1); // leading
    advance(10);
    t.push(2);
    advance(10);
    t.push(3);
    advance(10);
    t.push(4);
    expect(applied).toEqual([1]);

    advance(100);
    expect(applied).toEqual([1, 4]);
  });

  it('間隔を空けた操作はその都度適用する', () => {
    const applied: number[] = [];
    const { clock, advance } = fakeClock();
    const t = createThrottle<number>((v) => applied.push(v), 100, clock);

    t.push(1);
    advance(150);
    t.push(2);
    advance(150);
    t.push(3);
    expect(applied).toEqual([1, 2, 3]);
  });

  it('同じ値は適用しない（同じ局面へ何度も来ても書かない）', () => {
    const applied: number[] = [];
    const { clock, advance } = fakeClock();
    const t = createThrottle<number>((v) => applied.push(v), 100, clock);

    t.push(1);
    advance(150);
    t.push(1);
    advance(150);
    t.push(1);
    expect(applied).toEqual([1]);
  });

  it('行って戻ったら保留を捨てる（進めてすぐ戻すと書き込みが起きない）', () => {
    const applied: number[] = [];
    const { clock, advance, pendingTimers } = fakeClock();
    const t = createThrottle<number>((v) => applied.push(v), 100, clock);

    t.push(1); // leading で適用
    advance(10);
    t.push(2); // 保留
    advance(10);
    t.push(1); // 適用済みの値に戻った → 保留は不要
    expect(pendingTimers()).toBe(0);

    advance(200);
    expect(applied).toEqual([1]);
  });

  it('flush は保留中の値を今すぐ適用する（画面を離れるとき）', () => {
    const applied: number[] = [];
    const { clock, advance } = fakeClock();
    const t = createThrottle<number>((v) => applied.push(v), 100, clock);

    t.push(1);
    advance(10);
    t.push(2);
    t.flush();
    expect(applied).toEqual([1, 2]);

    // flush 後にタイマーが残っていて二重適用しないこと
    advance(200);
    expect(applied).toEqual([1, 2]);
  });

  it('cancel は保留中の値を捨てる（アンマウント時）', () => {
    const applied: number[] = [];
    const { clock, advance } = fakeClock();
    const t = createThrottle<number>((v) => applied.push(v), 100, clock);

    t.push(1);
    advance(10);
    t.push(2);
    t.cancel();
    advance(200);
    expect(applied).toEqual([1]);
  });

  it('Safari の下限で 30 秒間押し続けても 100 回に届かない', () => {
    const applied: number[] = [];
    const { clock, advance } = fakeClock();
    const t = createThrottle<number>((v) => applied.push(v), SAFARI_MIN_INTERVAL_MS, clock);

    // 16ms ごと（60fps 相当）に値を変えながら 30 秒押し続ける
    for (let i = 0; i < 30_000 / 16; i++) {
      t.push(i);
      advance(16);
    }
    expect(applied.length).toBeLessThan(100);
  });
});
