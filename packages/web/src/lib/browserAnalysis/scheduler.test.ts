import { describe, expect, it } from 'vitest';
import type { KifuOutcome } from './runner';
import {
  COOLDOWN_MS,
  createScheduler,
  type Scheduler,
  type SchedulerDeps,
} from './scheduler';
import type { AnalysisMode } from './settings';

/** 外から決着させられる Promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 待っているマイクロタスクを流す */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Running {
  kifuNo: number;
  signal: AbortSignal;
  finish(outcome: KifuOutcome): void;
}

function setup(mode: AnalysisMode, pendingList: number[] = []) {
  const state = {
    now: 0,
    pending: pendingList,
    pendingCalls: 0,
    /** analyze が呼ばれた順 */
    started: [] as number[],
    running: null as Running | null,
    settled: [] as [number, string][],
    halted: [] as string[],
    /** 待機中の sleep を起こす */
    wakeSleep: null as (() => void) | null,
    lockHeld: false,
    maxConcurrent: 0,
  };
  const deps: SchedulerDeps = {
    mode,
    analyze: (kifuNo, signal) => {
      state.started.push(kifuNo);
      const d = deferred<KifuOutcome>();
      state.running = { kifuNo, signal, finish: d.resolve };
      // 本物の runner と同じく、中断されたら aborted で戻る
      signal.addEventListener('abort', () => d.resolve({ kind: 'aborted' }));
      return d.promise.finally(() => {
        state.running = null;
      });
    },
    pending: async () => {
      state.pendingCalls++;
      return state.pending;
    },
    withLock: async (signal, fn) => {
      if (signal.aborted) throw new Error('aborted');
      expect(state.lockHeld).toBe(false);
      state.lockHeld = true;
      try {
        return await fn();
      } finally {
        state.lockHeld = false;
      }
    },
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          state.wakeSleep = null;
          resolve();
        };
        state.wakeSleep = done;
        signal.addEventListener('abort', done);
      }),
    now: () => state.now,
    log: { info: () => {}, warn: () => {} },
    onSettled: (kifuNo, outcome) => state.settled.push([kifuNo, outcome.kind]),
    onHalt: (outcome) => state.halted.push(outcome.reason),
  };
  const scheduler: Scheduler = createScheduler(deps);
  const controller = new AbortController();
  const done = scheduler.run(controller.signal);
  return { state, scheduler, stop: () => controller.abort(), done };
}

describe('createScheduler — 詳細ページだけ', () => {
  it('開いている詳細の棋譜だけを解析する（未解析の一覧は取りに行かない）', async () => {
    const { state, scheduler, stop, done } = setup('detail', [9, 8]);
    await flush();
    expect(state.started).toEqual([]);

    scheduler.setFocus(5);
    await flush();
    expect(state.started).toEqual([5]);

    state.running!.finish({ kind: 'complete' });
    await flush();
    expect(state.settled).toEqual([[5, 'complete']]);
    // 終わった後も、ほかの棋譜には手を出さない
    expect(state.started).toEqual([5]);
    expect(state.pendingCalls).toBe(0);
    stop();
    await done;
  });

  it('詳細ページを離れたら中断する', async () => {
    const { state, scheduler, stop, done } = setup('detail');
    scheduler.setFocus(5);
    await flush();
    const running = state.running!;

    scheduler.setFocus(null);
    await flush();
    expect(running.signal.aborted).toBe(true);
    expect(state.settled).toEqual([]);
    stop();
    await done;
  });

  it('別の棋譜の詳細へ移ったら、前の棋譜を中断して新しい棋譜を解析する', async () => {
    const { state, scheduler, stop, done } = setup('detail');
    scheduler.setFocus(5);
    await flush();
    const first = state.running!;

    scheduler.setFocus(null);
    scheduler.setFocus(6);
    await flush();
    expect(first.signal.aborted).toBe(true);
    expect(state.started).toEqual([5, 6]);
    stop();
    await done;
  });
});

describe('createScheduler — 使用中は常に', () => {
  it('開いている詳細の棋譜を最優先し、ほかは一覧の順に解析する', async () => {
    const { state, scheduler, stop, done } = setup('always', [9, 8, 5]);
    scheduler.setFocus(5);
    await flush();
    expect(state.started).toEqual([5]);

    // 完了した棋譜は一覧から消える（server が返さなくなる）
    state.pending = [9, 8];
    state.running!.finish({ kind: 'complete' });
    scheduler.setFocus(null);
    await flush();
    expect(state.started).toEqual([5, 9]);

    state.pending = [8];
    state.running!.finish({ kind: 'complete' });
    await flush();
    expect(state.started).toEqual([5, 9, 8]);
    stop();
    await done;
  });

  it('ほかの棋譜を解析している最中に詳細ページを開いたら、中断してそちらへ移る', async () => {
    const { state, scheduler, stop, done } = setup('always', [9, 8]);
    await flush();
    expect(state.started).toEqual([9]);
    const background = state.running!;

    scheduler.setFocus(3);
    await flush();
    expect(background.signal.aborted).toBe(true);
    expect(state.started).toEqual([9, 3]);
    stop();
    await done;
  });

  it('詳細ページを離れても、解析中の棋譜は止めない', async () => {
    const { state, scheduler, stop, done } = setup('always', []);
    scheduler.setFocus(3);
    await flush();
    const running = state.running!;

    scheduler.setFocus(null);
    await flush();
    expect(running.signal.aborted).toBe(false);
    stop();
    await done;
  });

  it('一覧が空なら待機し、poke で選び直す', async () => {
    const { state, scheduler, stop, done } = setup('always', []);
    await flush();
    expect(state.started).toEqual([]);
    expect(state.pendingCalls).toBe(1);

    state.pending = [4];
    scheduler.poke();
    await flush();
    expect(state.started).toEqual([4]);
    stop();
    await done;
  });

  it('後回しにした棋譜は空け時間の間は選ばず、次の棋譜へ進む', async () => {
    const { state, stop, done } = setup('always', [9, 8]);
    await flush();
    state.running!.finish({ kind: 'deferred', detail: 'status 500' });
    await flush();
    // 9 は一覧に残っているが、空け時間の間は 8 を先にする
    expect(state.started).toEqual([9, 8]);

    state.running!.finish({ kind: 'deferred', detail: 'status 500' });
    await flush();
    expect(state.started).toEqual([9, 8]);

    // 空け時間が明けたら、また試す
    state.now = COOLDOWN_MS.deferred + 1;
    state.wakeSleep?.();
    await flush();
    expect(state.started).toEqual([9, 8, 9]);
    stop();
    await done;
  });
});

describe('createScheduler — 共通', () => {
  it('解析は 1 本ずつ（ロックの中で 1 つだけ動かす）', async () => {
    const { state, scheduler, stop, done } = setup('always', [9, 8, 7]);
    scheduler.setFocus(7);
    await flush();
    // withLock の中の expect が、同時に 2 つ動いたら落とす
    expect(state.lockHeld).toBe(true);
    expect(state.started).toHaveLength(1);
    stop();
    await done;
    expect(state.lockHeld).toBe(false);
  });

  it('完了した棋譜を、画面のデータが古いまま指し続けても、開始を叩き続けない', async () => {
    const { state, scheduler, stop, done } = setup('detail');
    scheduler.setFocus(5);
    await flush();
    state.running!.finish({ kind: 'complete' });
    await flush();
    // 詳細ページはまだ「解析待ち」のまま（ローダーが古い）。同じ値を知らせ直しても始めない
    scheduler.setFocus(5);
    scheduler.poke();
    await flush();
    expect(state.started).toEqual([5]);
    stop();
    await done;
  });

  it('詳細ページを開き直した棋譜（再解析など）は、空け時間を待たずに試す', async () => {
    const { state, scheduler, stop, done } = setup('detail');
    scheduler.setFocus(5);
    await flush();
    state.running!.finish({ kind: 'failed', error: 'boom' });
    await flush();
    expect(state.settled).toEqual([[5, 'failed']]);

    // 失敗の表示に切り替わって解析待ちでなくなり、再解析でまた解析待ちになる
    scheduler.setFocus(null);
    scheduler.setFocus(5);
    await flush();
    expect(state.started).toEqual([5, 5]);
    stop();
    await done;
  });

  it('止める合図（担当の変更など）を受けたら、以後は何も解析しない', async () => {
    const { state, scheduler, done } = setup('always', [9, 8]);
    await flush();
    state.running!.finish({
      kind: 'halt',
      reason: 'wrong-assignee',
      detail: '解析の設定が変わりました',
    });
    await done;
    expect(state.halted).toEqual(['wrong-assignee']);

    scheduler.setFocus(3);
    scheduler.poke();
    await flush();
    expect(state.started).toEqual([9]);
  });

  it('止めたら、解析中の棋譜も中断する', async () => {
    const { state, stop, done } = setup('always', [9]);
    await flush();
    const running = state.running!;
    stop();
    await done;
    expect(running.signal.aborted).toBe(true);
  });
});
