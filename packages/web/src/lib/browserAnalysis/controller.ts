/**
 * ブラウザ解析の常駐（prd/14 §5.10）。実物の依存（Worker・fetch・Web Locks・document）を
 * runner と scheduler に配線する。画面からは `__root.tsx` の `BrowserAnalysisHost` が起動・停止する。
 *
 * 判断はここに書かない（`kifuAnalysis.ts` / `engineCache.ts` / `scheduler.ts` / `support.ts` / `engineHost.ts` の、
 * テストのある側に置く）。ブラウザの実物の依存は `browserDeps.ts`、エンジンの起動は `engineFactory.ts`。
 */
import {
  engineEntryDownloadBytes,
  engineEntryOf,
  type EngineManifest,
  type EngineManifestEntry,
} from 'shared';
import { abortableSleep as sleep } from '../abortableSleep';
import { fetchPendingKifuNos, runnerApi } from './api';
import {
  createVisibility,
  log,
  priorityWaiting,
  withAnalysisLock,
  withPriorityLock,
} from './browserDeps';
import type { EngineChoice, EngineSettings } from './engineCache';
import { createEngine } from './engineFactory';
import { engineOriginOf, fetchEngineManifest } from './enginePaths';
import type {
  NamedEvalOutcome,
  NamedEvalRequest,
  PositionEvalOutcome,
  PositionEvalRequest,
} from './engineReads';
import {
  createBrowserEngineRunner,
  type BrowserEngineRunner,
  type RunnerDeps,
} from './runner';
import { createScheduler, PriorityAbortedError } from './scheduler';
import { setBrowserReader, type BrowserReader } from './readerRegistry';
import {
  getBrowserAnalysisSettings,
  hasConsented,
  type AnalysisLoad,
  type AnalysisMode,
} from './settings';
import {
  getAnalysisFocus,
  onAnalysisFocusChange,
  onBrowserAnalysisPoke,
  patchBrowserAnalysisState,
  resetBrowserAnalysisState,
} from './store';
import { detectSupport, readBrowserEnv } from './support';

type Patch = typeof patchBrowserAnalysisState;

/**
 * いま選んでいる評価関数（端末の設定と manifest から。prd/14 §5.5）。
 * 🔒 選んだ評価関数のダウンロードに同意していなければ null（前の評価関数でも解析しない）
 */
function currentChoice(manifest: EngineManifest): EngineChoice | null {
  const settings = getBrowserAnalysisSettings();
  const entry = engineEntryOf(manifest, settings.evalId);
  if (!hasConsented(settings, entry.nn.sha256)) return null;
  return {
    id: entry.id,
    info: {
      engineBuild: entry.engine.buildId,
      evalHash: entry.nn.sha256,
      fvScale: entry.fvScale,
    },
  };
}

export interface BrowserAnalysisOptions {
  mode: AnalysisMode;
  /** 棋譜の解析が一区切りした（段が 1 つ揃ったときも）。画面のデータを取り直す */
  onSettled(): void;
  /** 担当が変わった・ログインが切れた。`GET /api/me` を取り直す */
  onAccountChanged(): void;
}

/** 止めた後に遅れて届く更新（ダウンロードの進捗など）で、止めた後の状態を書き換えない */
function patcherFor(signal: AbortSignal): typeof patchBrowserAnalysisState {
  return (next) => {
    if (!signal.aborted) patchBrowserAnalysisState(next);
  };
}

/**
 * 解析できる環境か・エンジンが配信されているか・同意済みかを確かめる（常駐の解析と、詰将棋の判定だけの常駐で共通）。
 * 進めないなら状態を書いて null。🔒 **同意の前は、エンジンの Worker を作らない**（manifest を読むだけ。prd/14 §5.10）
 */
async function prepare(
  signal: AbortSignal,
  patch: typeof patchBrowserAnalysisState,
): Promise<{ origin: string; manifest: EngineManifest; selected: EngineManifestEntry } | null> {
  const support = detectSupport(readBrowserEnv());
  if (!support.supported) {
    log.warn(`unsupported: ${support.reasons.join(', ')}`);
    patch({ phase: 'unsupported', unsupported: support.reasons });
    return null;
  }

  const origin = engineOriginOf(window.location.origin, import.meta.env.BASE_URL);
  const manifest = await fetchEngineManifest(origin, (url, init) => fetch(url, init));
  if (signal.aborted) return null;
  if (manifest === null) {
    log.warn('engine manifest not found (the engine is not deployed)');
    patch({ phase: 'no-engine', manifest: null });
    return null;
  }
  patch({ manifest });
  // 🔒 同意の前に評価関数を落とし始めない（prd/14 §5.10）。同意は評価関数ごと（選んだエントリの nn.bin の sha256）。
  // エンジンの Worker もここより先でしか作らない
  const selected = engineEntryOf(manifest, getBrowserAnalysisSettings().evalId);
  if (currentChoice(manifest) === null) {
    log.info(
      `waiting for consent (eval ${selected.id} ${engineEntryDownloadBytes(selected)} bytes)`,
    );
    patch({ phase: 'needs-consent' });
    return null;
  }
  return { origin, manifest, selected };
}

/** runner の依存のうち、常駐の解析と詰将棋の判定だけの常駐で共通のもの */
function runnerBaseDeps(
  origin: string,
  manifest: EngineManifest,
  signal: AbortSignal,
  patch: Patch,
): Omit<RunnerDeps, 'onProgress' | 'onStageCompleted'> {
  return {
    api: runnerApi,
    // 評価関数の選択は常駐を作り直さずに読む（変えたら次の解析の開始で、エンジンを作り直して効かせる）。
    // 同意していない評価関数に切り替えたら null（解析を止めて同意を求める）
    currentEngine: () => currentChoice(manifest),
    // エンジンの読み込みは、棋譜の中断ではなく常駐の停止（`signal`）で止める
    createEngine: (
      settings: EngineSettings,
      load: AnalysisLoad,
      choice: EngineChoice,
      threads?: number,
    ) =>
      createEngine({
        origin,
        entry: engineEntryOf(manifest, choice.id),
        settings,
        load,
        signal,
        patch,
        fixedThreads: threads,
      }),
    // 負荷の設定は常駐を作り直さずに読む（変えたら次の解析の開始で、エンジンを作り直して効かせる）
    currentLoad: () => getBrowserAnalysisSettings().load,
    sleep,
    now: () => Date.now(),
    visibility: createVisibility(signal),
    log,
  };
}

/** 採点の読みを 1 つ読み、経過をコンソールに出す（`[browser-analysis] drill: …`） */
async function gradeWithLog(
  runner: BrowserEngineRunner,
  request: NamedEvalRequest,
): Promise<NamedEvalOutcome> {
  const { threads, stopOnMate, movetimeMs } = request.settings;
  log.info(
    `drill: reading ${request.move} for ${movetimeMs}ms${threads !== undefined ? ` threads=${threads}` : ''}${stopOnMate ? ' (stop at the first mate)' : ''}`,
  );
  const started = Date.now();
  const outcome = await runner.evaluateNamed(request);
  const elapsed = Date.now() - started;
  switch (outcome.kind) {
    case 'ok': {
      const { candidate } = outcome.evaluation;
      log.info(
        candidate
          ? `drill: ${request.move} score ${candidate.scoreType} ${candidate.scoreValue} depth ${candidate.depth}${outcome.stopped ? ' stopped' : ''} in ${elapsed}ms`
          : `drill: ${request.move} no candidate in ${elapsed}ms`,
      );
      break;
    }
    case 'mismatch':
      log.warn(`drill: the engine did not read ${request.move} (returned ${outcome.returned})`);
      break;
    case 'failed':
      log.warn(`drill: failed: ${outcome.detail}`);
      break;
  }
  return outcome;
}

/** 検討盤の局面評価を 1 つ読み、経過をコンソールに出す（`[browser-analysis] position: …`） */
async function evaluatePositionWithLog(
  runner: BrowserEngineRunner,
  request: PositionEvalRequest,
  signal: AbortSignal,
): Promise<PositionEvalOutcome> {
  // 待っている間に取り下げられた（局面が変わった）。エンジンを使わない
  if (signal.aborted) return { kind: 'aborted' };
  const { multiPv, movetimeMs } = request.settings;
  log.info(`position: reading ${request.sfen} multipv=${multiPv} for ${movetimeMs}ms`);
  const started = Date.now();
  const outcome = await runner.evaluatePosition(request, signal);
  const elapsed = Date.now() - started;
  switch (outcome.kind) {
    case 'ok': {
      const [best] = outcome.candidates;
      log.info(
        best
          ? `position: ${outcome.candidates.length} candidates, best ${best.move} score ${best.scoreType} ${best.scoreValue} depth ${best.depth} threads=${outcome.threads} in ${elapsed}ms`
          : `position: no candidate in ${elapsed}ms`,
      );
      break;
    }
    case 'aborted':
      log.info(`position: withdrawn after ${elapsed}ms`);
      break;
    case 'failed':
      log.warn(`position: failed: ${outcome.detail}`);
      break;
  }
  return outcome;
}

/** 常駐の中身（全局面解析を回す常駐と、詰将棋の判定だけの常駐で違うところ） */
interface ResidentBody {
  /** 起動したときのログ（選んだ評価関数を添える） */
  startedLog(selected: EngineManifestEntry): string;
  /** 止まったときのログ */
  stoppedLog: string;
  /** 止まった原因が例外だったときのログの接頭辞 */
  errorLog: string;
  /** runner の進捗の受け手 */
  progress(patch: Patch): Pick<RunnerDeps, 'onProgress' | 'onStageCompleted'>;
  /**
   * 読みの受け持ち（{@link setBrowserReader} に登録する）と、常駐の本体（`signal` が止まるまで返らない）を作る。
   * 本体の後片付け（聞き手を外すなど）は `run` の中で済ませる
   */
  attach(
    runner: BrowserEngineRunner,
    signal: AbortSignal,
    patch: Patch,
  ): { reader: BrowserReader; run(): Promise<void> };
}

/**
 * 常駐を起動する。返り値の関数で止める（エンジンも止まる）。
 * 解析できる環境か・エンジンが配信されているか・同意済みかを確かめ（{@link prepare}）、runner を作って
 * 読みの受け持ちを登録し、`body` の本体を回す。止まったら受け持ちを外し、runner を止める
 */
function startResident(body: ResidentBody): () => void {
  const controller = new AbortController();
  const main = async (signal: AbortSignal) => {
    const patch = patcherFor(signal);
    const prepared = await prepare(signal, patch);
    if (!prepared) return;
    const { origin, manifest, selected } = prepared;
    log.info(body.startedLog(selected));
    patch({ phase: 'idle' });

    const runner = createBrowserEngineRunner({
      ...runnerBaseDeps(origin, manifest, signal, patch),
      ...body.progress(patch),
    });
    const { reader, run } = body.attach(runner, signal, patch);
    const offReader = setBrowserReader(reader);
    try {
      await run();
    } finally {
      offReader();
      runner.dispose();
      log.info(body.stoppedLog);
    }
  };
  main(controller.signal).catch((error: unknown) => {
    if (controller.signal.aborted) return;
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`${body.errorLog}: ${detail}`);
    patchBrowserAnalysisState({ phase: 'error', error: detail, progress: null });
  });
  return () => {
    controller.abort();
    resetBrowserAnalysisState();
  };
}

/**
 * 常駐の解析を起動する。返り値の関数で止める（エンジンも止まる）。
 * 設定（範囲・同意）が変わったら、止めて起動し直す。
 */
export function startBrowserAnalysis(options: BrowserAnalysisOptions): () => void {
  return startResident({
    startedLog: (selected) =>
      `started mode=${options.mode} eval=${selected.id} build=${selected.engine.buildId} isolated=${String(globalThis.crossOriginIsolated)}`,
    stoppedLog: 'stopped',
    errorLog: 'stopped by error',
    progress: (patch) => ({
      onProgress: (progress) => {
        patch(
          progress
            ? { phase: 'analyzing', progress }
            : { phase: 'idle', progress: null },
        );
      },
      // quick が揃ったら、full の完了を待たずに画面のデータを取り直す（quick の結果を出す）
      onStageCompleted: () => options.onSettled(),
    }),
    attach: (runner, signal, patch) => {
      const scheduler = createScheduler({
        mode: options.mode,
        analyze: (kifuNo, kifuSignal, hooks) => runner.analyze(kifuNo, kifuSignal, hooks),
        pending: fetchPendingKifuNos,
        withLock: withAnalysisLock,
        withPriorityLock,
        priorityWaiting,
        sleep,
        now: () => Date.now(),
        log,
        onSettled: (kifuNo, outcome) => {
          log.info(`kifu #${kifuNo}: ${outcome.kind}`);
          options.onSettled();
        },
        onHalt: (outcome) => {
          if (outcome.reason === 'wrong-assignee' || outcome.reason === 'unauthorized') {
            options.onAccountChanged();
            return;
          }
          if (outcome.reason === 'needs-consent') {
            // 同意していない評価関数に切り替えた。同意されたら常駐が起動し直す（`BrowserAnalysisHost`）
            patch({ phase: 'needs-consent', progress: null });
            return;
          }
          patch({
            phase: 'error',
            error:
              outcome.reason === 'engine-load'
                ? `解析エンジンを読み込めませんでした（${outcome.detail}）`
                : outcome.detail,
          });
        },
      });
      return {
        // 出題の採点の読み（prd/13 §5.3・§5.5）と検討盤の局面評価（prd/12 §2.4）。全局面解析より先に、同じエンジンで読む。
        // 詰将棋の判定は固定のスレッド数に切り替えて読み、全局面解析に戻るときに負荷の設定の数へ戻す（engineCache の acquire）
        reader: {
          // 名指しの読み（出題の採点）も頼んだ側の取り下げ（解いている画面を離れた）を渡す。順番を待っている間に取り下げられたら読まない
          named: (request, readSignal) =>
            scheduler.runPriority(() => gradeWithLog(runner, request), readSignal),
          // 局面評価は頼んだ側の取り下げを渡す。取り下げた要求で全局面解析を止めたり、ほかのタブを譲らせたりしない
          position: (request, readSignal) =>
            scheduler.runPriority(
              () => evaluatePositionWithLog(runner, request, readSignal),
              readSignal,
            ),
        },
        run: async () => {
          const offFocus = onAnalysisFocusChange(scheduler.setFocus);
          const offPoke = onBrowserAnalysisPoke(scheduler.poke);
          scheduler.setFocus(getAnalysisFocus());
          try {
            await scheduler.run(signal);
          } finally {
            offFocus();
            offPoke();
          }
        },
      };
    },
  });
}

/**
 * 詰将棋の判定だけの常駐を起動する（担当 `worker` の利用者。prd/13 §5.5）。返り値の関数で止める（エンジンも止まる）。
 * 同意が増えたら止めて起動し直す（`DrillGradingHost`）。
 *
 * 🔒 **全局面解析は回さない**——棋譜の一覧も開始の口も叩かず、採点の読みを受け持つだけ。
 * エンジンは最初の判定で読み込み、止めるまで使い回す。
 * 同意の前・解析できない環境・エンジンが無いときは状態を書いて何もしない（判定は手元 worker に回る）。
 * ⚠ ほかのタブとロックを取り合わない（担当 `worker` の端末には全局面解析のタブが無い）
 */
export function startDrillGrading(): () => void {
  return startResident({
    startedLog: (selected) =>
      `drill grading only: eval=${selected.id} build=${selected.engine.buildId}`,
    stoppedLog: 'drill grading stopped',
    errorLog: 'drill grading stopped by error',
    progress: () => ({ onProgress: () => {}, onStageCompleted: () => {} }),
    attach: (runner, signal) => {
      // エンジンは 1 本なので、判定は 1 つずつ読む
      let queue: Promise<unknown> = Promise.resolve();
      const enqueue = <T,>(read: () => Promise<T>): Promise<T> => {
        const run = queue.then(read);
        queue = run.catch(() => {});
        return run;
      };
      return {
        // 局面評価も受けるが、担当 `worker` の検討盤は server の口を使うので、ここに頼まれることは無い
        reader: {
          // 順番が来たときに取り下げられていれば読まない（runPriority と同じ扱い）
          named: (request, readSignal) =>
            enqueue(() => {
              if (readSignal?.aborted) return Promise.reject(new PriorityAbortedError());
              return gradeWithLog(runner, request);
            }),
          position: (request, readSignal) =>
            enqueue(() => evaluatePositionWithLog(runner, request, readSignal)),
        },
        // 止めるまで受け持つだけ
        run: () =>
          new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          }),
      };
    },
  });
}
