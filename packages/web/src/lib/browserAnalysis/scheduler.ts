/**
 * どの棋譜をいつ解析するか（prd/14 §5.10）。常駐して、棋譜を 1 つずつ {@link KifuRunner} に渡す。
 *
 * - **詳細ページだけ**（`detail`）: 開いている詳細ページの棋譜だけを解析する。ページを離れたら中断する
 * - **使用中は常に**（`always`）: 開いている詳細の棋譜を最優先し、ほかは server が返す未解析の一覧の順（新しい順）。
 *   ほかの棋譜を解析している最中に詳細ページを開いたら、局面の境目で中断してそちらへ移る
 * - 🔒 **同じブラウザの中の解析は 1 本**（Web Locks）。棋譜 1 つごとにロックを取り、ほかのタブと順番に進める。
 *   エンジンを読み込むのはロックを取ったタブだけ（読み込みは runner が最初の解析のときに行う）
 *
 * 依存は注入する（unit テスト用）。DOM には触れない。
 */
import type { KifuOutcome, RunnerLog } from './runner';
import type { AnalysisMode } from './settings';

export interface SchedulerDeps {
  mode: AnalysisMode;
  /** 1 つの棋譜を解析する（{@link KifuRunner.analyze}） */
  analyze(kifuNo: number, signal: AbortSignal): Promise<KifuOutcome>;
  /** 未解析の棋譜の番号（新しい順）。失敗したら投げる */
  pending(): Promise<number[]>;
  /**
   * 同じブラウザの中で 1 つだけが `fn` を実行するようにする（Web Locks）。
   * 待っている間に `signal` が中断されたら、`fn` を呼ばずに拒否する
   */
  withLock<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T>;
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

  const eligible = (kifuNo: number) =>
    (cooldownUntil.get(kifuNo) ?? 0) <= deps.now();

  const pick = async (): Promise<number | null> => {
    if (focus !== null && eligible(focus)) return focus;
    if (mode !== 'always') return null;
    let list: number[];
    try {
      list = await deps.pending();
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

  const run = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      const seen = changes;
      const kifuNo = await pick();
      if (signal.aborted) return;
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
          deps.analyze(kifuNo, controller.signal),
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

  return { run, setFocus, poke: notify };
}
