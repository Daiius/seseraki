import { describe, expect, it } from 'vitest';
import type { AnalyzeHooks, KifuOutcome } from './kifuAnalysis';
import {
  anySignal,
  COOLDOWN_MS,
  createScheduler,
  pendingStatusKind,
  PriorityAbortedError,
  SchedulerStoppedError,
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
  hooks: AnalyzeHooks;
  finish(outcome: KifuOutcome): void;
}

function setup(mode: AnalysisMode, pendingList: number[] = []) {
  const state = {
    now: 0,
    pending: pendingList,
    pendingCalls: 0,
    /** 未解析の一覧が 401 を返す（セッション切れ） */
    pendingUnauthorized: false,
    /** analyze が呼ばれた順 */
    started: [] as number[],
    running: null as Running | null,
    settled: [] as [number, string][],
    halted: [] as string[],
    /** 待機中の sleep を起こす */
    wakeSleep: null as (() => void) | null,
    lockHeld: false,
    maxConcurrent: 0,
    /** ほかのタブで採点の読みが待っている */
    othersWaiting: false,
    /** 採点の読みの印のロックを取った回数 */
    priorityLocks: 0,
  };
  const deps: SchedulerDeps = {
    mode,
    analyze: (kifuNo, signal, hooks) => {
      state.started.push(kifuNo);
      const d = deferred<KifuOutcome>();
      state.running = { kifuNo, signal, hooks, finish: d.resolve };
      // 本物の runner と同じく、中断されたら aborted で戻る
      signal.addEventListener('abort', () => d.resolve({ kind: 'aborted' }));
      return d.promise.finally(() => {
        state.running = null;
      });
    },
    pending: async () => {
      state.pendingCalls++;
      if (state.pendingUnauthorized) return { kind: 'unauthorized' };
      return { kind: 'ok', kifuNos: state.pending };
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
    withPriorityLock: async (signal, fn) => {
      state.priorityLocks++;
      return deps.withLock(signal, fn);
    },
    priorityWaiting: async () => state.othersWaiting,
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
  return { state, deps, scheduler, stop: () => controller.abort(), done };
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

  it('未解析の一覧が 401 を返したら、ログイン切れとして止める（1 分ごとに叩き続けない）', async () => {
    const { state, scheduler, done } = setup('always', []);
    await flush();
    expect(state.pendingCalls).toBe(1);

    // 一覧ページにいる間にセッションが切れた
    state.pendingUnauthorized = true;
    scheduler.poke();
    await done;
    expect(state.halted).toEqual(['unauthorized']);
    expect(state.pendingCalls).toBe(2);
    expect(state.started).toEqual([]);
  });

  it('未解析の一覧の HTTP ステータスの扱い', () => {
    expect(pendingStatusKind(200)).toBe('ok');
    expect(pendingStatusKind(401)).toBe('unauthorized');
    expect(pendingStatusKind(403)).toBe('error');
    expect(pendingStatusKind(500)).toBe('error');
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

describe('createScheduler — 2 段の順序（prd/14 §5.10）', () => {
  it('使用中は常に: full の途中に、一覧の先頭が別の棋譜になったら譲る（quick 待ちの棋譜を先にする）', async () => {
    // server の並び: quick 未完了が先・それぞれ新しい順。今は 9 の full だけが残っている
    const { state, stop, done } = setup('always', [9]);
    await flush();
    expect(state.started).toEqual([9]);
    const running = state.running!;
    expect(await running.hooks.shouldYield!()).toBe(false);

    // 新しく取り込んだ 12 が quick 待ちとして先頭に来た
    state.pending = [12, 9];
    expect(await running.hooks.shouldYield!()).toBe(true);
    running.finish({ kind: 'yielded' });
    await flush();
    // 譲った棋譜は空け時間なしで、一覧の並びのとおり 12 を先に解析する
    expect(state.started).toEqual([9, 12]);
    expect(state.settled).toEqual([]);

    // 12 が終わったら（quick → full まで）、また一覧の並びで 9 に戻る
    state.pending = [9];
    state.running!.finish({ kind: 'complete' });
    await flush();
    expect(state.started).toEqual([9, 12, 9]);
    stop();
    await done;
  });

  it('空け時間の中の棋譜は、先頭にあっても譲る理由にしない', async () => {
    const { state, stop, done } = setup('always', [12, 9]);
    await flush();
    expect(state.started).toEqual([12]);
    // 12 は後回しになった（通信の失敗が続いた）
    state.running!.finish({ kind: 'deferred', detail: 'network' });
    await flush();
    expect(state.started).toEqual([12, 9]);
    expect(await state.running!.hooks.shouldYield!()).toBe(false);
    stop();
    await done;
  });

  it('開いている詳細の棋譜は譲らない（quick → full を最後まで）', async () => {
    const { state, scheduler, stop, done } = setup('always', []);
    scheduler.setFocus(5);
    await flush();
    expect(state.started).toEqual([5]);
    state.pending = [12, 5];
    const callsBefore = state.pendingCalls;
    expect(await state.running!.hooks.shouldYield!()).toBe(false);
    // 一覧も取りに行かない
    expect(state.pendingCalls).toBe(callsBefore);
    stop();
    await done;
  });

  it('詳細ページだけでは譲らない', async () => {
    const { state, scheduler, stop, done } = setup('detail', [12]);
    scheduler.setFocus(5);
    await flush();
    expect(await state.running!.hooks.shouldYield!()).toBe(false);
    expect(state.pendingCalls).toBe(0);
    stop();
    await done;
  });

  it('一覧を取れない（ログイン切れ・通信の失敗）ときは譲らない', async () => {
    const { state, stop, done } = setup('always', [9]);
    await flush();
    state.pendingUnauthorized = true;
    expect(await state.running!.hooks.shouldYield!()).toBe(false);
    stop();
    await done;
  });
});

describe('createScheduler — 採点の読み（prd/14 §5.10）', () => {
  it('解析中の棋譜を局面の境目で止めて先に読み、終わったら同じ棋譜を空け時間なしで再開する', async () => {
    const { state, scheduler, stop, done } = setup('always', [7]);
    await flush();
    const first = state.running!;
    expect(first.kifuNo).toBe(7);

    const order: string[] = [];
    const graded = scheduler.runPriority(async () => {
      // 🔒 全局面解析は止まっていて、同じロックの下で読む
      expect(state.running).toBeNull();
      expect(state.lockHeld).toBe(true);
      order.push('grade');
      return 'read';
    });
    await flush();
    expect(first.signal.aborted).toBe(true);
    await expect(graded).resolves.toBe('read');
    expect(order).toEqual(['grade']);
    expect(state.priorityLocks).toBe(1);
    // 止めた棋譜は失敗にも完了にもせず、続きから選び直される
    expect(state.settled).toEqual([]);
    expect(state.started).toEqual([7, 7]);
    stop();
    await done;
  });

  it('待機中（詳細ページだけ・何も開いていない）でもすぐ読む', async () => {
    const { state, scheduler, stop, done } = setup('detail');
    await flush();
    await expect(scheduler.runPriority(async () => 1)).resolves.toBe(1);
    expect(state.started).toEqual([]);
    stop();
    await done;
  });

  it('ほかのタブの採点の読みが待っているかを、解析に聞かせる（局面の境目で譲る）', async () => {
    const { state, stop, done } = setup('always', [7]);
    await flush();
    const hooks = state.running!.hooks;
    expect(await hooks.shouldPause?.()).toBe(false);
    state.othersWaiting = true;
    expect(await hooks.shouldPause?.()).toBe(true);
    // 譲った棋譜は空け時間なしで選び直される
    state.running!.finish({ kind: 'paused' });
    await flush();
    expect(state.started).toEqual([7, 7]);
    expect(state.settled).toEqual([]);
    stop();
    await done;
  });

  it('常駐が止まったら、待っている採点の読みは拒否する（止まった後に頼んでも拒否する）', async () => {
    const { scheduler, stop, done } = setup('detail');
    await flush();
    stop();
    await done;
    await expect(scheduler.runPriority(async () => 1)).rejects.toThrow();
  });
});

describe('createScheduler — 取り下げた読みの依頼（runPriority の signal）', () => {
  it('取り下げ済みの依頼は積まない（解析を止めず、ロックも取らない）', async () => {
    const { state, scheduler, stop, done } = setup('always', [7]);
    await flush();
    const first = state.running!;
    const request = new AbortController();
    request.abort();
    let called = false;
    await expect(
      scheduler.runPriority(async () => {
        called = true;
      }, request.signal),
    ).rejects.toBeInstanceOf(PriorityAbortedError);
    await flush();
    expect(called).toBe(false);
    expect(first.signal.aborted).toBe(false);
    expect(state.priorityLocks).toBe(0);
    stop();
    await done;
  });

  it('待っている間に取り下げられたら、順番を待たずに拒否し、ロックを取らない', async () => {
    const { state, scheduler, stop, done } = setup('always', [7]);
    await flush();
    const request = new AbortController();
    let called = false;
    const graded = scheduler.runPriority(async () => {
      called = true;
    }, request.signal);
    // 積んだ直後（解析が局面の境目で止まる前）に取り下げる
    request.abort();
    await expect(graded).rejects.toBeInstanceOf(PriorityAbortedError);
    await flush();
    expect(called).toBe(false);
    expect(state.priorityLocks).toBe(0);
    stop();
    await done;
  });

  it('ロックを待っている間に取り下げられたら、読まずに拒否する（常駐の停止とは分ける）', async () => {
    const { state, deps, scheduler, stop, done } = setup('detail');
    await flush();
    let lockSignal: AbortSignal | null = null;
    // ほかのタブがロックを持っている: 中断されるまで待つ
    deps.withPriorityLock = (signal) => {
      state.priorityLocks++;
      lockSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const request = new AbortController();
    let called = false;
    const graded = scheduler.runPriority(async () => {
      called = true;
    }, request.signal);
    await flush();
    expect(state.priorityLocks).toBe(1);
    expect(lockSignal!.aborted).toBe(false);
    request.abort();
    await expect(graded).rejects.toBeInstanceOf(PriorityAbortedError);
    expect(lockSignal!.aborted).toBe(true);
    expect(called).toBe(false);
    stop();
    await done;
  });

  it('取り下げの無い依頼は今までどおり（常駐が止まったら SchedulerStoppedError）', async () => {
    const { scheduler, stop, done } = setup('detail');
    await flush();
    const request = new AbortController();
    await expect(scheduler.runPriority(async () => 2, request.signal)).resolves.toBe(2);
    stop();
    await done;
    await expect(scheduler.runPriority(async () => 1)).rejects.toBeInstanceOf(SchedulerStoppedError);
  });
});

describe('anySignal', () => {
  it('どちらかが中断されたら中断される・release の後は伝えない', () => {
    const a = new AbortController();
    const b = new AbortController();
    const first = anySignal(a.signal, b.signal);
    b.abort();
    expect(first.signal.aborted).toBe(true);

    const c = new AbortController();
    a.abort();
    // 中断済みの signal を合わせたら、はじめから中断されている
    expect(anySignal(a.signal, c.signal).signal.aborted).toBe(true);

    const d = new AbortController();
    const e = new AbortController();
    const third = anySignal(d.signal, e.signal);
    third.release();
    d.abort();
    expect(third.signal.aborted).toBe(false);
  });
});
