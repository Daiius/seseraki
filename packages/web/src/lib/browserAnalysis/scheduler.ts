/**
 * どの棋譜をいつ解析するか（prd/14 §5.10）。常駐して、棋譜を 1 つずつ {@link KifuRunner} に渡す。
 *
 * - **詳細ページだけ**（`detail`）: 開いている詳細ページの棋譜だけを解析する。ページを離れたら中断する
 * - **使用中は常に**（`always`）: 開いている詳細の棋譜を最優先し、ほかは server が返す未解析の一覧の順。
 *   ほかの棋譜を解析している最中に詳細ページを開いたら、局面の境目で中断してそちらへ移る
 * - 🔒 **2 段の順序**（prd/14 §5.10）: 1 つの棋譜は quick → full を続けて回す（runner）。開いている詳細の棋譜は
 *   full まで譲らない。使用中は常に: 未解析の全棋譜の quick を先に、その後 full を新しい順。
 *   **full の途中に、一覧の先頭（空け時間の中のものを除く）が今の棋譜でなくなったら、局面の境目で譲る**。
 *   一覧は server が「quick 未完了が先・それぞれ新しい順」に並べて返すので、web は段を推測せず、
 *   「今選び直したら別の棋譜を選ぶか」だけを見る（quick 待ちの棋譜が現れたとき、それが先頭に来る）
 * - 🔒 **同じブラウザの中の解析は 1 本**（Web Locks）。棋譜 1 つごとにロックを取り、ほかのタブと順番に進める。
 *   エンジンを読み込むのはロックを取ったタブだけ（読み込みは runner が最初の解析のときに行う）
 * - 🔒 **採点の読み（出題の名指し評価）は全局面解析より優先**（prd/14 §5.10）。{@link Scheduler.runPriority} で頼まれたら、
 *   このタブの解析を局面の境目で止め（既存の中断。未送信のチャンクは送ってから止まる）、採点の読みを先に済ませてから
 *   選び直す（止めた棋譜は空け時間なしでまた選ばれる＝続きから再開）。ほかのタブの解析は、局面の境目で
 *   {@link SchedulerDeps.priorityWaiting} を見て譲る（`paused`）
 *
 * 依存は注入する（unit テスト用）。DOM には触れない。
 */
import type { AnalyzeHooks, KifuOutcome, RunnerLog } from './runner';
import type { AnalysisMode } from './settings';

export type PendingResult =
  | { kind: 'ok'; kifuNos: number[] }
  /** セッションが切れた（401）。解析を止め、呼び出し側が `GET /api/me` を取り直す */
  | { kind: 'unauthorized' };

/** 未解析の一覧の HTTP ステータスの扱い */
export function pendingStatusKind(
  status: number,
): 'ok' | 'unauthorized' | 'error' {
  if (status === 401) return 'unauthorized';
  return status >= 200 && status < 300 ? 'ok' : 'error';
}

export interface SchedulerDeps {
  mode: AnalysisMode;
  /** 1 つの棋譜を解析する（{@link KifuRunner.analyze}） */
  analyze(
    kifuNo: number,
    signal: AbortSignal,
    hooks: AnalyzeHooks,
  ): Promise<KifuOutcome>;
  /**
   * 未解析の棋譜の番号（server の並び: quick 未完了が先・それぞれ新しい順）。
   * ログイン切れ（401）はそう返す。ほかの失敗は投げる
   */
  pending(): Promise<PendingResult>;
  /**
   * 同じブラウザの中で 1 つだけが `fn` を実行するようにする（Web Locks）。
   * 待っている間に `signal` が中断されたら、`fn` を呼ばずに拒否する
   */
  withLock<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T>;
  /**
   * 採点の読みを、ほかのタブより先に {@link SchedulerDeps.withLock} と同じロックの下で実行する。
   * ほかのタブに「採点の読みが待っている」と分かる印（{@link SchedulerDeps.priorityWaiting}）を立ててからロックを待つ
   */
  withPriorityLock<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T>;
  /** ほかのタブで採点の読みが待っているか（局面の境目ごとに聞く。聞けなければ false） */
  priorityWaiting(): Promise<boolean>;
  /** `ms` 待つ。中断されたら待たずに解決する */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  log: RunnerLog;
  /** 棋譜の解析が一区切りした（完了・失敗・対象外）。画面のデータを取り直す合図 */
  onSettled(kifuNo: number, outcome: KifuOutcome): void;
  /** これ以上解析しない（担当の変更・ログイン切れ・エンジンを読み込めない） */
  onHalt(outcome: Extract<KifuOutcome, { kind: 'halt' }>): void;
}

export interface Scheduler {
  /** 常駐のループ。`signal` で止める */
  run(signal: AbortSignal): Promise<void>;
  /** 開いている詳細ページの、解析待ちの棋譜（無ければ null） */
  setFocus(kifuNo: number | null): void;
  /** 待機を切り上げて、次の棋譜を選び直す（ページの移動など、状況が変わったかもしれないとき） */
  poke(): void;
  /**
   * 採点の読み（`fn`）を全局面解析より先に実行する。このタブで解析中の棋譜は局面の境目で止め、`fn` の後に選び直す。
   * 常駐が止まったら（止まっていたら）拒否する（{@link SchedulerStoppedError}）。
   * `signal` は頼んだ側の取り下げ。取り下げ済み・取り下げられたら、解析を止めずロックも取らずに拒否する
   * （{@link PriorityAbortedError}。取り下げた要求のために、このタブの解析を止めたりほかのタブを譲らせたりしない）
   */
  runPriority<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** 常駐が止まっていて、採点の読みを実行できない */
export class SchedulerStoppedError extends Error {
  constructor() {
    super('解析の常駐が止まっています');
  }
}

/** 頼んだ側が採点の読み・局面評価を取り下げた（{@link Scheduler.runPriority} の `signal`） */
export class PriorityAbortedError extends Error {
  constructor() {
    super('読みの依頼は取り下げられました');
  }
}

/**
 * どちらかが中断されたら中断される signal（`AbortSignal.any` 相当）。`release` で聞き手を外す。
 * ⚠ `AbortSignal.any` を持たないブラウザ（Safari 17.4 より前）もあるので、自前で合わせる
 */
export function anySignal(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
    return { signal: controller.signal, release: () => {} };
  }
  a.addEventListener('abort', onAbort);
  b.addEventListener('abort', onAbort);
  return {
    signal: controller.signal,
    release: () => {
      a.removeEventListener('abort', onAbort);
      b.removeEventListener('abort', onAbort);
    },
  };
}

/** 解析が一区切りした棋譜を、次に試すまで空ける時間 */
export const COOLDOWN_MS = {
  /** 完了。画面のデータが古いまま同じ棋譜を指し続けても、開始の口を叩き続けない */
  complete: 15_000,
  /** 失敗の記録あり・指し手列なし・棋譜なし。やり直すのは再解析だけ（詳細ページを開き直すと解ける） */
  settled: 5 * 60_000,
  /** 通信の失敗などで後回しにした */
  deferred: 60_000,
} as const;

/** することが無いときに見回る間隔 */
export const IDLE_POLL_MS = 60_000;

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { mode, log } = deps;
  let focus: number | null = null;
  let current: { kifuNo: number; controller: AbortController } | null = null;
  let wake: (() => void) | null = null;
  /** 状況が変わった回数（`setFocus` / `poke`）。棋譜を選んでいる最中の変化を取りこぼさないために数える */
  let changes = 0;
  const notify = () => {
    changes++;
    wake?.();
  };
  /** 棋譜の番号 → 次に試してよい時刻 */
  const cooldownUntil = new Map<number, number>();
  /** 頼まれた採点の読み（頼まれた順） */
  const priority: {
    run(): Promise<void>;
    /** 常駐が止まった */
    cancel(): void;
    /** 頼んだ側が取り下げた */
    abort(): void;
    /** 頼んだ側の取り下げの合図（無ければ取り下げられない） */
    signal?: AbortSignal;
  }[] = [];
  let running = false;

  const eligible = (kifuNo: number) =>
    (cooldownUntil.get(kifuNo) ?? 0) <= deps.now();

  /**
   * full を回している棋譜を、ほかの棋譜に譲るか（{@link AnalyzeHooks.shouldYield}）。
   * - 開いている詳細の棋譜・詳細ページだけ（`detail`）では譲らない
   * - 使用中は常に: 未解析の一覧で、選べる先頭が今の棋譜でなければ譲る（一覧が取れなければ譲らない）
   */
  const shouldYield = async (kifuNo: number): Promise<boolean> => {
    if (mode !== 'always' || focus === kifuNo) return false;
    let result: PendingResult;
    try {
      result = await deps.pending();
    } catch {
      return false;
    }
    // ログイン切れは次の選び直しで受ける（ここでは解析を続ける）
    if (result.kind !== 'ok') return false;
    const head = result.kifuNos.find(eligible);
    if (head === undefined || head === kifuNo) return false;
    log.info(`kifu #${kifuNo}: kifu #${head} comes first in the pending list`);
    return true;
  };

  const pick = async (): Promise<number | null | 'unauthorized'> => {
    if (focus !== null && eligible(focus)) return focus;
    if (mode !== 'always') return null;
    let list: number[];
    try {
      const result = await deps.pending();
      // 🔒 ログイン切れは通信の失敗と分ける。分けないと、止まらずに 1 分ごとに同じ要求を繰り返す
      if (result.kind === 'unauthorized') return 'unauthorized';
      list = result.kifuNos;
    } catch (error) {
      log.warn(
        `pending list failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    // 一覧を取っている間に詳細ページが開かれていたら、そちらを先にする
    if (focus !== null && eligible(focus)) return focus;
    return list.find(eligible) ?? null;
  };

  /** `signal` の中断を `controller` へ伝える。返り値で解除する */
  const link = (signal: AbortSignal, controller: AbortController) => {
    const onAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort);
    return () => signal.removeEventListener('abort', onAbort);
  };

  const idle = async (signal: AbortSignal): Promise<void> => {
    const controller = new AbortController();
    const unlink = link(signal, controller);
    wake = () => controller.abort();
    // 開いている棋譜が空け時間の中なら、明けたらすぐ試す
    const focusWait =
      focus === null
        ? IDLE_POLL_MS
        : Math.max(0, (cooldownUntil.get(focus) ?? 0) - deps.now());
    try {
      await deps.sleep(
        Math.min(IDLE_POLL_MS, Math.max(focusWait, 1_000)),
        controller.signal,
      );
    } finally {
      wake = null;
      unlink();
    }
  };

  /** 頼まれた採点の読みを、頼まれた順にすべて済ませる */
  const drainPriority = async (signal: AbortSignal): Promise<void> => {
    while (priority.length > 0 && !signal.aborted) {
      const task = priority.shift()!;
      // 取り出すときにも見る。待っている間に取り下げられた要求でロック（ほかのタブを譲らせる印）を取らない
      if (task.signal?.aborted) {
        task.abort();
        continue;
      }
      // ロックを待つ間の取り下げも受ける（常駐の停止と合わせる）
      const lock = task.signal ? anySignal(signal, task.signal) : { signal, release: () => {} };
      try {
        await deps.withPriorityLock(lock.signal, () => task.run());
      } catch {
        // ロックを待つ間の中断。常駐の停止なら止まったと、取り下げなら取り下げと返す
        if (!signal.aborted && task.signal?.aborted) task.abort();
        else task.cancel();
      } finally {
        lock.release();
      }
    }
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    running = true;
    try {
      await loop(signal);
    } finally {
      running = false;
      for (const task of priority.splice(0)) task.cancel();
    }
  };

  const loop = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      await drainPriority(signal);
      if (signal.aborted) return;
      const seen = changes;
      const kifuNo = await pick();
      if (signal.aborted) return;
      // 選んでいる間に採点の読みを頼まれたら、そちらを先にする
      if (priority.length > 0) continue;
      if (kifuNo === 'unauthorized') {
        log.warn('halt (unauthorized): pending list returned 401');
        deps.onHalt({
          kind: 'halt',
          reason: 'unauthorized',
          detail: 'ログインが切れました',
        });
        return;
      }
      if (kifuNo === null) {
        // 選んでいる間に状況が変わっていたら（詳細ページが開かれたなど）、待機に入らず選び直す
        if (changes === seen) await idle(signal);
        continue;
      }

      const controller = new AbortController();
      const unlink = link(signal, controller);
      current = { kifuNo, controller };
      let outcome: KifuOutcome;
      try {
        outcome = await deps.withLock(controller.signal, () =>
          deps.analyze(kifuNo, controller.signal, {
            shouldYield: () => shouldYield(kifuNo),
            shouldPause: () => deps.priorityWaiting().catch(() => false),
          }),
        );
      } catch (error) {
        // ロックを待っている間の中断は拒否で返る。それ以外は想定外なので、後回しにして続ける
        if (controller.signal.aborted) {
          outcome = { kind: 'aborted' };
        } else {
          const detail = error instanceof Error ? error.message : String(error);
          log.warn(`kifu #${kifuNo}: unexpected error: ${detail}`);
          outcome = { kind: 'deferred', detail };
        }
      } finally {
        current = null;
        unlink();
      }

      switch (outcome.kind) {
        case 'aborted':
        case 'paused':
          // 空け時間を置かない。採点の読みの後・選び直しで、続きから再開する
          break;
        case 'yielded':
          // 空け時間を置かない。一覧の先頭を解析し終えたら、また一覧の並びで選ばれる
          break;
        case 'complete':
          cooldownUntil.set(kifuNo, deps.now() + COOLDOWN_MS.complete);
          deps.onSettled(kifuNo, outcome);
          break;
        case 'skipped':
        case 'failed':
          cooldownUntil.set(kifuNo, deps.now() + COOLDOWN_MS.settled);
          deps.onSettled(kifuNo, outcome);
          break;
        case 'deferred':
          cooldownUntil.set(kifuNo, deps.now() + COOLDOWN_MS.deferred);
          break;
        case 'halt':
          log.warn(`halt (${outcome.reason}): ${outcome.detail}`);
          deps.onHalt(outcome);
          return;
      }
    }
  };

  const setFocus = (kifuNo: number | null) => {
    if (kifuNo === focus) return;
    // 詳細ページを開き直した・再解析した棋譜は、空け時間を待たずに試す
    if (kifuNo !== null) cooldownUntil.delete(kifuNo);
    focus = kifuNo;
    if (current && current.kifuNo !== kifuNo) {
      // 詳細ページだけ: 開いている棋譜でなくなったら止める
      // 使用中は常に: 開いた詳細の棋譜へ移るために止める（どの詳細も開いていないなら、そのまま続ける）
      if (mode === 'detail' || kifuNo !== null) {
        log.info(`interrupting kifu #${current.kifuNo}`);
        current.controller.abort();
      }
    }
    notify();
  };

  const runPriority = <T,>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (!running) {
        reject(new SchedulerStoppedError());
        return;
      }
      // 積むときに見る。取り下げ済みの要求のために解析を止めない
      if (signal?.aborted) {
        reject(new PriorityAbortedError());
        return;
      }
      const task = {
        run: () => {
          signal?.removeEventListener('abort', onAbort);
          return fn().then(resolve, reject);
        },
        cancel: () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new SchedulerStoppedError());
        },
        abort: () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new PriorityAbortedError());
        },
        signal,
      };
      // 待っている間に取り下げられたら、順番を待たずに外して返す
      const onAbort = () => {
        const index = priority.indexOf(task);
        if (index === -1) return; // 取り出された後（ロック待ち・実行中）。ロックの signal と fn 側が受ける
        priority.splice(index, 1);
        task.abort();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      priority.push(task);
      if (current) {
        // 局面の境目で止める（未送信のチャンクは送ってから止まる）。止めた棋譜は空け時間なしで選び直される
        log.info(`interrupting kifu #${current.kifuNo} for a drill answer`);
        current.controller.abort();
      }
      notify();
    });

  return { run, setFocus, poke: notify, runPriority };
}
