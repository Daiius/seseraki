import { describe, expect, it } from 'vitest';
import type {
  BrowserAnalysisChunk,
  BrowserAnalysisRun,
  UsiSearchResult,
} from 'shared';
import {
  classifyFailureStatus,
  createKifuRunner,
  errorReportResultOf,
  MAX_STALE_RESTARTS,
  PAUSE_CHECK_WHILE_HIDDEN_MS,
  RETRY_DELAYS_MS,
  YIELD_CHECK_INTERVAL_MS,
  type AnalysisEngine,
  type AnalysisStage,
  type AnalyzeHooks,
  type ChunkResult,
  type EngineChoice,
  type ErrorReportResult,
  type LocalProgress,
  type RunnerDeps,
  type StartResult,
} from './runner';
import type { AnalysisLoad } from './settings';

// 4 手の棋譜（局面は 0..4 の 5 つ）。チャンクは 2 局面ごとに切る
const USI_MOVES = ['7g7f', '3c3d', '2g2f', '8c8d'];
const SETTINGS = {
  movetimeMs: 300,
  multiPv: 1,
  hashMb: 64,
  maxThreads: 8,
  // 時間では切らせない（テストを時計に依存させない）
  chunkIntervalMs: 3_600_000,
  chunkMaxPositions: 2,
  pvMaxPlies: 128,
};
const ENGINE_INFO = {
  engineBuild: 'c1b80eaa-a2b7ca71a963',
  evalHash: 'a'.repeat(64),
  fvScale: 16,
};

const runOf = (
  overrides: Partial<BrowserAnalysisRun> = {},
  profile: AnalysisStage = 'full',
): StartResult => ({
  kind: 'run',
  profile,
  run: {
    revision: 7,
    startMoveNumber: 0,
    usiMoves: USI_MOVES,
    settings: SETTINGS,
    ...overrides,
  },
});

const searchResult = (): UsiSearchResult => {
  const info = {
    depth: 12,
    multipv: 1,
    score: { type: 'cp' as const, value: 42 },
    pv: ['7g7f', '3c3d'],
  };
  return { bestmove: { move: '7g7f' }, infoLines: [info], lastInfo: info };
};

/** `position startpos moves a b c` → 3（解析している局面の番号） */
const positionIndex = (position: string) => {
  const at = position.indexOf(' moves ');
  return at === -1 ? 0 : position.slice(at + 7).split(' ').length;
};

interface Harness {
  deps: RunnerDeps;
  starts: number;
  chunks: BrowserAnalysisChunk[];
  errors: { revision: number; error: string }[];
  engines: (AnalysisEngine & { disposed: boolean })[];
  sleeps: number[];
  progress: (LocalProgress | null)[];
  waitedVisible: number;
  hidden: boolean;
  /** 負荷の設定（`currentLoad` が返す） */
  load: AnalysisLoad;
  /** エンジンを作ったときの負荷 */
  engineLoads: AnalysisLoad[];
  /** 選んでいる評価関数（`currentEngine` が返す。null は未同意） */
  choice: EngineChoice | null;
  /** エンジンを作ったときの評価関数の id */
  engineChoices: string[];
  stageCompleted: { kifuNo: number; profile: AnalysisStage }[];
  /** 時計（`now` が返す） */
  time: number;
}

/** チャンクの応答（既定は、段が揃ったら全体も揃う＝ full の段の応答） */
const okChunk = (
  applied: boolean,
  completed: boolean,
  stageCompleted = completed,
): ChunkResult => ({ kind: 'ok', applied, completed, stageCompleted });

function harness(script: {
  start?: (call: number) => StartResult;
  chunk?: (chunk: BrowserAnalysisChunk, call: number) => ChunkResult;
  /** エンジン（通し番号）が局面を解析するときに呼ぶ。投げればエンジンの失敗 */
  analyze?: (engineNo: number, position: number, h: Harness) => void;
  createEngine?: (engineNo: number) => void;
  reportError?: () => ErrorReportResult;
}): Harness {
  const h: Harness = {
    starts: 0,
    chunks: [],
    errors: [],
    engines: [],
    sleeps: [],
    progress: [],
    waitedVisible: 0,
    hidden: false,
    load: 'max',
    engineLoads: [],
    choice: { id: 'tsuyo11mini', info: ENGINE_INFO },
    engineChoices: [],
    stageCompleted: [],
    time: 1_000,
    deps: undefined as unknown as RunnerDeps,
  };
  h.deps = {
    currentEngine: () => h.choice,
    api: {
      start: async () => (script.start ?? (() => runOf()))(h.starts++),
      submitChunk: async (_no, chunk) => {
        h.chunks.push(chunk);
        const last = chunk.analyses.at(-1)!.moveNumber;
        return script.chunk
          ? script.chunk(chunk, h.chunks.length - 1)
          : okChunk(true, last === USI_MOVES.length);
      },
      reportError: async (_no, body) => {
        h.errors.push(body);
        return script.reportError ? script.reportError() : 'recorded';
      },
    },
    createEngine: async (_settings, load, choice) => {
      const engineNo = h.engines.length;
      h.engineLoads.push(load);
      h.engineChoices.push(choice.id);
      script.createEngine?.(engineNo);
      const engine: AnalysisEngine & { disposed: boolean } = {
        disposed: false,
        name: 'FakeEngine',
        threads: 4,
        hashMb: 64,
        session: {
          setOption: () => {},
          analyze: async (position) => {
            script.analyze?.(engineNo, positionIndex(position), h);
            return searchResult();
          },
        },
        dispose() {
          engine.disposed = true;
        },
      };
      h.engines.push(engine);
      return engine;
    },
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
    now: () => h.time,
    currentLoad: () => h.load,
    onStageCompleted: (kifuNo, profile) => h.stageCompleted.push({ kifuNo, profile }),
    visibility: {
      isHidden: () => h.hidden,
      lastChangedAt: () => null,
      waitVisible: async () => {
        h.waitedVisible++;
        h.hidden = false;
      },
    },
    onProgress: (progress) => h.progress.push(progress),
    log: { info: () => {}, warn: () => {} },
  };
  return h;
}

const neverAborted = new AbortController().signal;

describe('classifyFailureStatus', () => {
  it('401 はログイン切れ・403 は続けても直らない拒否', () => {
    expect(classifyFailureStatus(401)).toBe('unauthorized');
    expect(classifyFailureStatus(403)).toBe('fatal');
  });
  it('入力の誤り（4xx）は拒否、5xx と混雑は再試行', () => {
    expect(classifyFailureStatus(400)).toBe('rejected');
    expect(classifyFailureStatus(413)).toBe('rejected');
    expect(classifyFailureStatus(408)).toBe('retry');
    expect(classifyFailureStatus(429)).toBe('retry');
    expect(classifyFailureStatus(500)).toBe('retry');
    expect(classifyFailureStatus(503)).toBe('retry');
  });
});

describe('errorReportResultOf（失敗の報告の 201 の本文）', () => {
  it('applied: true だけが記録済み。破棄（applied: false）は記録済みにしない', () => {
    expect(errorReportResultOf({ ok: true, applied: true })).toBe('recorded');
    expect(errorReportResultOf({ ok: true, applied: false })).toBe('discarded');
    expect(errorReportResultOf({ ok: true })).toBe('discarded');
    expect(errorReportResultOf(null)).toBe('discarded');
  });
});

describe('createKifuRunner', () => {
  it('開始 → 解析 → チャンクの報告 → 完了', async () => {
    const h = harness({});
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);

    expect(outcome).toEqual({ kind: 'complete' });
    expect(h.starts).toBe(1);
    // 2 局面ごと + 残り
    expect(h.chunks.map((c) => c.analyses.map((a) => a.moveNumber))).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
    // 世代と来歴は、開始の口・manifest・エンジンの値
    expect(h.chunks[0]).toMatchObject({
      revision: 7,
      engineBuild: ENGINE_INFO.engineBuild,
      evalHash: ENGINE_INFO.evalHash,
      fvScale: 16,
      engineName: 'FakeEngine',
      threads: 4,
      hashMb: 64,
      movetimeMs: 300,
      // 開始の口が返した段をそのまま申告する
      profile: 'full',
    });
    expect(h.chunks[0].analyses[0].candidates).toEqual([
      { rank: 1, move: '7g7f', scoreType: 'cp', scoreValue: 42, depth: 12, pv: ['7g7f', '3c3d'] },
    ]);
    // 進捗は局面ごとに出て、最後に消える
    expect(h.progress.at(-1)).toBeNull();
    expect(h.progress.filter((p) => p !== null).map((p) => p.analyzed)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(h.progress[0]).toMatchObject({ kifuNo: 3, revision: 7, total: 5 });
    expect(h.errors).toEqual([]);
  });

  it('再開位置から解析する', async () => {
    const h = harness({ start: () => runOf({ startMoveNumber: 3 }) });
    await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(h.chunks.flatMap((c) => c.analyses.map((a) => a.moveNumber))).toEqual([3, 4]);
  });

  it('解析しない棋譜（解析済み・失敗の記録あり・指し手列なし・無い）は、エンジンを読み込まずに終える', async () => {
    for (const [reason, expected] of [
      ['complete', { kind: 'complete' }],
      ['failed', { kind: 'skipped', reason: 'failed' }],
      ['unanalyzable', { kind: 'skipped', reason: 'unanalyzable' }],
      ['not-found', { kind: 'skipped', reason: 'not-found' }],
    ] as const) {
      const h = harness({ start: () => ({ kind: 'skip', reason }) });
      expect(await createKifuRunner(h.deps).analyze(3, neverAborted)).toEqual(expected);
      expect(h.engines).toHaveLength(0);
    }
  });

  it('担当がブラウザでない（409）なら止める。エンジンは読み込まない', async () => {
    const h = harness({ start: () => ({ kind: 'wrong-assignee' }) });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(outcome).toMatchObject({ kind: 'halt', reason: 'wrong-assignee' });
    expect(h.engines).toHaveLength(0);
  });

  it('報告が破棄された（applied: false）ら、中断して開始からやり直す', async () => {
    const h = harness({
      start: (call) => (call === 0 ? runOf() : runOf({ revision: 8 })),
      chunk: (chunk, call) =>
        call === 0
          ? okChunk(false, false)
          : okChunk(true, chunk.analyses.at(-1)!.moveNumber === USI_MOVES.length),
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);

    expect(outcome).toEqual({ kind: 'complete' });
    expect(h.starts).toBe(2);
    // 破棄された後は、新しい世代で先頭から送り直す
    expect(h.chunks.map((c) => [c.revision, c.analyses[0].moveNumber])).toEqual([
      [7, 0],
      [8, 0],
      [8, 2],
      [8, 4],
    ]);
    // エンジンは作り直さない（エンジンの失敗ではない）
    expect(h.engines).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it('破棄が続いたら、失敗にはせず後回しにする', async () => {
    const h = harness({
      chunk: () => (okChunk(false, false)),
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(outcome.kind).toBe('deferred');
    expect(h.starts).toBe(MAX_STALE_RESTARTS + 1);
    expect(h.errors).toEqual([]);
  });

  it('5xx・通信の失敗は、後退して同じチャンクを送り直す', async () => {
    let failures = 0;
    const h = harness({
      chunk: (chunk) => {
        if (chunk.analyses[0].moveNumber === 2 && failures < 2) {
          failures++;
          if (failures === 1) throw new Error('network down');
          return { kind: 'retry', detail: 'status 503' };
        }
        return okChunk(true, chunk.analyses.at(-1)!.moveNumber === USI_MOVES.length);
      },
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);

    expect(outcome).toEqual({ kind: 'complete' });
    expect(h.sleeps).toEqual([RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1]]);
    expect(h.chunks.map((c) => c.analyses[0].moveNumber)).toEqual([0, 2, 2, 2, 4]);
    expect(h.starts).toBe(1);
  });

  it('通信の失敗が続いたら後回しにする（棋譜の失敗としては報告しない）', async () => {
    const h = harness({ chunk: () => ({ kind: 'retry', detail: 'status 500' }) });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(outcome.kind).toBe('deferred');
    expect(h.sleeps).toEqual(RETRY_DELAYS_MS);
    expect(h.errors).toEqual([]);
    expect(h.progress.at(-1)).toBeNull();
  });

  it('開始の口の 5xx も後退して再試行する', async () => {
    const h = harness({
      start: (call) => (call === 0 ? { kind: 'retry', detail: 'status 502' } : runOf()),
    });
    expect(await createKifuRunner(h.deps).analyze(3, neverAborted)).toEqual({
      kind: 'complete',
    });
    expect(h.starts).toBe(2);
  });

  it('入力の誤りとして拒否された（4xx）ら、失敗として記録して止める', async () => {
    const h = harness({ chunk: () => ({ kind: 'rejected', status: 400 }) });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(outcome.kind).toBe('failed');
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ revision: 7 });
    expect(h.errors[0].error).toContain('400');
  });

  it('エンジンが 1 度失敗しただけなら、作り直して続ける（失敗を報告しない）', async () => {
    const h = harness({
      analyze: (engineNo, position) => {
        if (engineNo === 0 && position === 2) throw { name: 'ExitStatus', message: 'exit(1)' };
      },
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);

    expect(outcome).toEqual({ kind: 'complete' });
    expect(h.engines).toHaveLength(2);
    expect(h.engines[0].disposed).toBe(true);
    expect(h.errors).toEqual([]);
    // 作り直した後は、開始の口が返す再開位置からやり直す
    expect(h.starts).toBe(2);
  });

  it('エンジンを作り直した後に同じ局面でもう一度失敗したら、棋譜の失敗として報告する', async () => {
    const h = harness({
      analyze: (_engineNo, position) => {
        if (position === 2) throw new Error('info string Error! : Illegal Input Move');
      },
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);

    expect(outcome.kind).toBe('failed');
    expect(h.engines).toHaveLength(2);
    expect(h.engines.every((e) => e.disposed)).toBe(true);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].revision).toBe(7);
    expect(h.errors[0].error).toContain('2 手目');
    expect(h.errors[0].error).toContain('Illegal Input Move');
  });

  it('別の局面での失敗は「同じ局面でもう一度」に数えない', async () => {
    const h = harness({
      // 1 回目は局面 1、作り直した後は局面 3 で失敗。3 つ目のエンジンは通る
      analyze: (engineNo, position) => {
        if (engineNo === 0 && position === 1) throw new Error('boom');
        if (engineNo === 1 && position === 3) throw new Error('boom');
      },
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(outcome).toEqual({ kind: 'complete' });
    expect(h.engines).toHaveLength(3);
    expect(h.errors).toEqual([]);
  });

  it('ページが隠れている間の失敗は、何度あっても報告しない（見えるまで待ってやり直す）', async () => {
    let failures = 0;
    const h = harness({
      analyze: (_engineNo, position, harnessState) => {
        if (position === 2 && failures < 3) {
          failures++;
          // スマホの凍結: 隠れている間に応答が時間切れになる
          harnessState.hidden = true;
          throw new Error('[USI] Analysis timed out');
        }
      },
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);

    expect(outcome).toEqual({ kind: 'complete' });
    expect(h.waitedVisible).toBe(3);
    expect(h.errors).toEqual([]);
  });

  it('失敗の報告を送れなければ、後回しにする', async () => {
    const h = harness({
      analyze: (_engineNo, position) => {
        if (position === 0) throw new Error('boom');
      },
      reportError: () => 'unsent',
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(outcome.kind).toBe('deferred');
  });

  it('失敗の報告が破棄された（applied: false）ら、失敗済みにせず開始から聞き直す', async () => {
    // 同じ局面で 2 回失敗して報告したが、その間に別のタブが完了させていた
    const h = harness({
      start: (call) => (call < 2 ? runOf() : { kind: 'skip', reason: 'complete' }),
      analyze: (_engineNo, position) => {
        if (position === 0) throw new Error('boom');
      },
      reportError: () => 'discarded',
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(h.errors).toHaveLength(1);
    expect(outcome).toEqual({ kind: 'complete' });
    expect(h.starts).toBe(3);
  });

  it('拒否（4xx）の後の失敗の報告が破棄されたときも、開始から聞き直す', async () => {
    const h = harness({
      start: (call) => (call === 0 ? runOf() : runOf({ revision: 8 })),
      chunk: (chunk) =>
        chunk.revision === 7
          ? { kind: 'rejected', status: 400 }
          : okChunk(true, chunk.analyses.at(-1)!.moveNumber === USI_MOVES.length),
      reportError: () => 'discarded',
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(outcome).toEqual({ kind: 'complete' });
    expect(h.errors).toEqual([expect.objectContaining({ revision: 7 })]);
  });

  it('失敗の報告の破棄が続いたら、後回しにする（失敗済みにはしない）', async () => {
    const h = harness({
      chunk: () => ({ kind: 'rejected', status: 400 }),
      reportError: () => 'discarded',
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(outcome.kind).toBe('deferred');
    expect(h.errors).toHaveLength(MAX_STALE_RESTARTS + 1);
  });

  it('エンジンを読み込めないときは、棋譜の失敗にせず止める', async () => {
    const h = harness({
      createEngine: () => {
        throw new Error('評価関数を取得できません (404)');
      },
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(outcome).toMatchObject({ kind: 'halt', reason: 'engine-load' });
    expect(h.errors).toEqual([]);
    expect(h.chunks).toEqual([]);
  });

  it('中断されたら、局面の境目で未送信のチャンクを送ってから戻る', async () => {
    const controller = new AbortController();
    const h = harness({
      analyze: (_engineNo, position) => {
        // 局面 2 を解析している最中に中断が届く
        if (position === 2) controller.abort();
      },
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, controller.signal);

    expect(outcome).toEqual({ kind: 'aborted' });
    // 局面 2 まで解析し、未送信ぶん（[2]）を送ってから止まる
    expect(h.chunks.map((c) => c.analyses.map((a) => a.moveNumber))).toEqual([[0, 1], [2]]);
    expect(h.errors).toEqual([]);
    expect(h.progress.at(-1)).toBeNull();
    // エンジンは捨てない（次の棋譜で使い回す）
    expect(h.engines[0].disposed).toBe(false);
  });

  it('エンジンの読み込み中に棋譜が中断されても、読み込みは捨てず次の棋譜で使う', async () => {
    const controller = new AbortController();
    const h = harness({
      // 読み込み（評価関数のダウンロード）の最中に、詳細ページを離れる
      createEngine: () => controller.abort(),
    });
    const runner = createKifuRunner(h.deps);
    expect(await runner.analyze(1, controller.signal)).toEqual({ kind: 'aborted' });
    expect(h.engines[0].disposed).toBe(false);
    expect(h.chunks).toEqual([]);

    expect(await runner.analyze(2, neverAborted)).toEqual({ kind: 'complete' });
    expect(h.engines).toHaveLength(1);
  });

  it('読み込み中に止められたエンジンは、使わずに捨てる', async () => {
    const controller = new AbortController();
    let runner: ReturnType<typeof createKifuRunner> | null = null;
    const h = harness({
      createEngine: () => {
        controller.abort();
        runner!.dispose();
      },
    });
    runner = createKifuRunner(h.deps);
    expect(await runner.analyze(1, controller.signal)).toEqual({ kind: 'aborted' });
    expect(h.engines[0].disposed).toBe(true);
  });

  it('エンジンは棋譜をまたいで使い回し、dispose で止める', async () => {
    const h = harness({});
    const runner = createKifuRunner(h.deps);
    await runner.analyze(1, neverAborted);
    await runner.analyze(2, neverAborted);
    expect(h.engines).toHaveLength(1);
    runner.dispose();
    expect(h.engines[0].disposed).toBe(true);
  });

  it('セッション切れ（401）・続けても直らない拒否（403）は止める', async () => {
    const unauthorized = harness({ chunk: () => ({ kind: 'unauthorized' }) });
    expect(
      await createKifuRunner(unauthorized.deps).analyze(3, neverAborted),
    ).toMatchObject({ kind: 'halt', reason: 'unauthorized' });

    const fatal = harness({ start: () => ({ kind: 'fatal', detail: '送れません (403)' }) });
    expect(await createKifuRunner(fatal.deps).analyze(3, neverAborted)).toMatchObject({
      kind: 'halt',
      reason: 'fatal',
      detail: '送れません (403)',
    });
    expect(unauthorized.errors).toEqual([]);
  });
});

describe('createKifuRunner（2 段。prd/14 §5.8・§5.10）', () => {
  const QUICK = { ...SETTINGS, movetimeMs: 100 };
  const FULL = { ...SETTINGS, movetimeMs: 600 };
  /** server の役: 1 回目の開始は quick、quick が揃った後は full を返す。full が揃ったら完了 */
  function twoStage(
    extra: {
      analyze?: (engineNo: number, position: number, h: Harness) => void;
      fullFrom?: number;
    } = {},
  ) {
    let quickDone = false;
    let fullDone = false;
    return harness({
      start: () =>
        fullDone
          ? { kind: 'skip', reason: 'complete' }
          : quickDone
            ? runOf({ settings: FULL, startMoveNumber: extra.fullFrom ?? 0 }, 'full')
            : runOf({ settings: QUICK }, 'quick'),
      chunk: (chunk) => {
        const last = chunk.analyses.at(-1)!.moveNumber === USI_MOVES.length;
        if (chunk.profile === 'quick') {
          if (last) quickDone = true;
          // quick が揃っても、解析全体（full まで）はまだ
          return okChunk(true, false, last);
        }
        if (last) fullDone = true;
        return okChunk(true, last, last);
      },
      analyze: extra.analyze,
    });
  }

  it('quick が揃ったら、同じ棋譜を続けて full へ（開始の口を叩き直す）', async () => {
    const h = twoStage();
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);

    expect(outcome).toEqual({ kind: 'complete' });
    expect(h.starts).toBe(2);
    // 段ごとに、開始の口が返した段と思考時間で回して申告する
    expect(h.chunks.map((c) => [c.profile, c.movetimeMs, c.analyses[0].moveNumber])).toEqual([
      ['quick', 100, 0],
      ['quick', 100, 2],
      ['quick', 100, 4],
      ['full', 600, 0],
      ['full', 600, 2],
      ['full', 600, 4],
    ]);
    // quick が揃ったことを知らせる（画面に quick の結果を出す）。full の完了は結果で返す
    expect(h.stageCompleted).toEqual([{ kifuNo: 3, profile: 'quick' }]);
    // エンジンは段をまたいで使い回す
    expect(h.engines).toHaveLength(1);
  });

  it('進捗は段ごとに 0 から数え直し、段を載せる（quick → full）', async () => {
    const h = twoStage();
    await createKifuRunner(h.deps).analyze(3, neverAborted);
    const shown = h.progress.filter((p) => p !== null);
    expect(shown.map((p) => `${p.profile}:${p.analyzed}`)).toEqual([
      'quick:0', 'quick:1', 'quick:2', 'quick:3', 'quick:4', 'quick:5',
      'full:0', 'full:1', 'full:2', 'full:3', 'full:4', 'full:5',
    ]);
    expect(h.progress.at(-1)).toBeNull();
  });

  it('full の途中から再開する（開始の口が返す再開位置）', async () => {
    const h = twoStage({ fullFrom: 3 });
    await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(
      h.chunks.filter((c) => c.profile === 'full').flatMap((c) => c.analyses.map((a) => a.moveNumber)),
    ).toEqual([3, 4]);
  });

  it('quick の間は譲るかを聞かない', async () => {
    /** 聞かれたときに、送り済みだった quick のチャンクの数 */
    const askedAfterQuickChunks: number[] = [];
    const h = twoStage({
      analyze: (_engineNo, _position, state) => {
        state.time += YIELD_CHECK_INTERVAL_MS;
      },
    });
    const hooks: AnalyzeHooks = {
      shouldYield: async () => {
        askedAfterQuickChunks.push(h.chunks.filter((c) => c.profile === 'quick').length);
        return false;
      },
    };
    expect(await createKifuRunner(h.deps).analyze(3, neverAborted, hooks)).toEqual({
      kind: 'complete',
    });
    // 聞くのは full の開始の前と、full の途中（時計を間隔ぶん進めているので局面の境目ごと）だけ。
    // quick の 3 チャンクを送り終えるまでは 1 度も聞かない
    expect(askedAfterQuickChunks.length).toBeGreaterThan(1);
    expect(askedAfterQuickChunks.every((n) => n === 3)).toBe(true);
  });

  it('full を始める前に譲れと言われたら、エンジンを読み込まずに譲る', async () => {
    const h = harness({ start: () => runOf({}, 'full') });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted, {
      shouldYield: async () => true,
    });
    expect(outcome).toEqual({ kind: 'yielded' });
    expect(h.engines).toHaveLength(0);
    expect(h.chunks).toEqual([]);
  });

  it('full の途中で譲れと言われたら、局面の境目で未送信のチャンクを送って譲る', async () => {
    let yieldNow = false;
    const h = harness({
      start: () => runOf({}, 'full'),
      analyze: (_engineNo, position, state) => {
        state.time += YIELD_CHECK_INTERVAL_MS;
        // 局面 2 を解析している間に、quick 待ちの棋譜が現れる
        if (position === 2) yieldNow = true;
      },
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted, {
      shouldYield: async () => yieldNow,
    });
    expect(outcome).toEqual({ kind: 'yielded' });
    expect(h.chunks.map((c) => c.analyses.map((a) => a.moveNumber))).toEqual([[0, 1], [2]]);
    expect(h.errors).toEqual([]);
    // エンジンは捨てない
    expect(h.engines[0].disposed).toBe(false);
  });

  it('譲るかは間隔を空けて聞く（局面ごとに未解析の一覧を叩かない）', async () => {
    let asked = 0;
    const h = harness({ start: () => runOf({}, 'full') });
    await createKifuRunner(h.deps).analyze(3, neverAborted, {
      shouldYield: async () => {
        asked++;
        return false;
      },
    });
    // 時計が進まないので、full の開始の前の 1 回だけ
    expect(asked).toBe(1);
  });

  it('譲るかを聞けなかった（投げた）ら、譲らずに続ける', async () => {
    const h = harness({
      start: () => runOf({}, 'full'),
      analyze: (_engineNo, _position, state) => {
        state.time += YIELD_CHECK_INTERVAL_MS;
      },
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted, {
      shouldYield: async () => {
        throw new Error('network down');
      },
    });
    expect(outcome).toEqual({ kind: 'complete' });
  });

  it('負荷の設定が変わったら、次の解析の開始でエンジンを作り直す', async () => {
    const h = harness({});
    const runner = createKifuRunner(h.deps);
    await runner.analyze(1, neverAborted);
    expect(h.engineLoads).toEqual(['max']);

    // 設定ページで「控えめ」に変えた。解析中のエンジンはそのまま、次の開始で作り直す
    h.load = 'gentle';
    await runner.analyze(2, neverAborted);
    expect(h.engineLoads).toEqual(['max', 'gentle']);
    expect(h.engines[0].disposed).toBe(true);
  });

  it('評価関数の選択が変わったら、次の段の開始でエンジンを作り直し、開始の口と来歴も新しい評価関数にする', async () => {
    const MICRO_INFO = {
      engineBuild: 'c1b80eaa-0123456789ab',
      evalHash: 'b'.repeat(64),
      fvScale: 16,
    };
    const starts: { engineBuild: string; evalHash: string }[] = [];
    const h = harness({
      // quick → full の 2 段。quick の途中で評価関数を切り替える
      start: (call) => runOf({}, call === 0 ? 'quick' : 'full'),
      chunk: (chunk) => {
        const last = chunk.analyses.at(-1)!.moveNumber;
        const done = last === USI_MOVES.length;
        return okChunk(true, done && chunk.profile === 'full', done);
      },
      analyze: (_engineNo, position, harnessRef) => {
        if (position === 1 && harnessRef.choice?.id === 'tsuyo11mini') {
          harnessRef.choice = { id: 'tsuyo11micro', info: MICRO_INFO };
        }
      },
    });
    const start = h.deps.api.start;
    h.deps.api.start = async (no, engine) => {
      starts.push(engine);
      return start(no, engine);
    };

    const outcome = await createKifuRunner(h.deps).analyze(1, neverAborted);
    expect(outcome).toEqual({ kind: 'complete' });
    // 解析中の段（quick）は区切りまで前の評価関数のまま、次の段（full）で作り直す
    expect(h.engineChoices).toEqual(['tsuyo11mini', 'tsuyo11micro']);
    expect(h.engines[0].disposed).toBe(true);
    expect(starts).toEqual([
      { engineBuild: ENGINE_INFO.engineBuild, evalHash: ENGINE_INFO.evalHash },
      { engineBuild: MICRO_INFO.engineBuild, evalHash: MICRO_INFO.evalHash },
    ]);
    const quick = h.chunks.filter((c) => c.profile === 'quick');
    const full = h.chunks.filter((c) => c.profile === 'full');
    expect(quick.every((c) => c.evalHash === ENGINE_INFO.evalHash)).toBe(true);
    expect(full.every((c) => c.evalHash === MICRO_INFO.evalHash)).toBe(true);
    expect(full.every((c) => c.engineBuild === MICRO_INFO.engineBuild)).toBe(true);
  });

  it('🔒 選んだ評価関数に同意していなければ（null）、開始の口も叩かずに止める', async () => {
    const h = harness({});
    h.choice = null;
    const outcome = await createKifuRunner(h.deps).analyze(1, neverAborted);
    expect(outcome).toMatchObject({ kind: 'halt', reason: 'needs-consent' });
    expect(h.starts).toBe(0);
    expect(h.engines).toHaveLength(0);
  });
});

describe('createKifuRunner — 採点の読み（出題の名指し評価。prd/13 §5.3）', () => {
  const SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
  const request = { sfen: SFEN, move: '2g2f', settings: { ...SETTINGS, movetimeMs: 600 } };

  /** 送られた USI を記録し、`reply` で応答するエンジン（作るたびに通し番号） */
  function namedHarness(reply: (engineNo: number, go: string) => UsiSearchResult) {
    const h = harness({});
    const sent: { position: string; go: string }[] = [];
    h.deps.createEngine = async (_settings, load, choice) => {
      const engineNo = h.engines.length;
      h.engineLoads.push(load);
      h.engineChoices.push(choice.id);
      const engine: AnalysisEngine & { disposed: boolean } = {
        disposed: false,
        name: 'FakeEngine',
        threads: 4,
        hashMb: 64,
        session: {
          setOption: () => {},
          analyze: async (position, go) => {
            sent.push({ position, go });
            return reply(engineNo, go);
          },
        },
        dispose() {
          engine.disposed = true;
        },
      };
      h.engines.push(engine);
      return engine;
    };
    return { h, sent };
  }

  const named = (move: string, score: { type: 'cp' | 'mate'; value: number }, pv: string[]): UsiSearchResult => {
    const info = { depth: 14, multipv: 1, score, pv };
    return { bestmove: { move }, infoLines: [info], lastInfo: info };
  };

  it('局面と手を名指しで読み、解答に付ける形（来歴つき）にする', async () => {
    const { h, sent } = namedHarness(() => named('2g2f', { type: 'cp', value: -120 }, ['2g2f', '8c8d']));
    const outcome = await createKifuRunner(h.deps).evaluateNamed(request);
    expect(sent).toEqual([
      { position: `position sfen ${SFEN}`, go: 'go movetime 600 searchmoves 2g2f' },
    ]);
    expect(outcome).toEqual({
      kind: 'ok',
      evaluation: {
        move: '2g2f',
        candidate: { scoreType: 'cp', scoreValue: -120, depth: 14, pv: ['2g2f', '8c8d'] },
        engineBuild: ENGINE_INFO.engineBuild,
        evalHash: ENGINE_INFO.evalHash,
        engineName: 'FakeEngine',
        fvScale: 16,
        threads: 4,
        hashMb: 64,
        movetimeMs: 600,
      },
    });
  });

  it('🔴 不成の手も読めるよう、読みの間だけ GenerateAllLegalMoves を有効にする', async () => {
    const { h } = namedHarness(() => named('9d9c', { type: 'cp', value: -300 }, ['9d9c', '9b9c']));
    const options: string[] = [];
    const created = h.deps.createEngine;
    h.deps.createEngine = async (settings, load, choice) => {
      const engine = await created(settings, load, choice);
      const analyze = engine.session.analyze.bind(engine.session);
      engine.session = {
        setOption: (name, value) => options.push(`${name}=${value}`),
        analyze: async (position, go) => {
          options.push('(go)');
          return analyze(position, go);
        },
      };
      return engine;
    };
    const outcome = await createKifuRunner(h.deps).evaluateNamed({ ...request, move: '9d9c' });
    expect(outcome).toMatchObject({ kind: 'ok', evaluation: { move: '9d9c' } });
    expect(options).toEqual(['GenerateAllLegalMoves=true', '(go)', 'GenerateAllLegalMoves=false']);
  });

  it('負荷の設定が効く（全局面解析と同じく、エンジンを作るときに読む）', async () => {
    const { h } = namedHarness(() => named('2g2f', { type: 'cp', value: 0 }, ['2g2f']));
    h.load = 'gentle';
    await createKifuRunner(h.deps).evaluateNamed(request);
    expect(h.engineLoads).toEqual(['gentle']);
  });

  it('選んでいる評価関数で読み、来歴もその評価関数にする（切り替えたらエンジンを作り直す）', async () => {
    const { h } = namedHarness(() => named('2g2f', { type: 'cp', value: 0 }, ['2g2f']));
    const runner = createKifuRunner(h.deps);
    await runner.evaluateNamed(request);
    const microInfo = { engineBuild: 'c1b80eaa-0123456789ab', evalHash: 'b'.repeat(64), fvScale: 16 };
    h.choice = { id: 'tsuyo11micro', info: microInfo };
    const outcome = await runner.evaluateNamed(request);
    expect(h.engineChoices).toEqual(['tsuyo11mini', 'tsuyo11micro']);
    expect(outcome).toMatchObject({
      kind: 'ok',
      evaluation: { engineBuild: microInfo.engineBuild, evalHash: microInfo.evalHash },
    });
  });

  it('🔒 選んだ評価関数に同意していなければ読まない（failed）', async () => {
    const { h } = namedHarness(() => named('2g2f', { type: 'cp', value: 0 }, ['2g2f']));
    h.choice = null;
    expect(await createKifuRunner(h.deps).evaluateNamed(request)).toMatchObject({ kind: 'failed' });
    expect(h.engines).toHaveLength(0);
  });

  it('全局面解析のエンジンを使い回す（読み込み直さない）', async () => {
    const { h } = namedHarness(() => named('2g2f', { type: 'cp', value: 0 }, ['2g2f']));
    const runner = createKifuRunner(h.deps);
    await runner.evaluateNamed(request);
    await runner.evaluateNamed(request);
    expect(h.engines).toHaveLength(1);
  });

  it('🔒 名指しが効かずに別の手が返ったら mismatch（数字を作らない）', async () => {
    const { h } = namedHarness(() => named('7g7f', { type: 'cp', value: 50 }, ['7g7f']));
    expect(await createKifuRunner(h.deps).evaluateNamed(request)).toEqual({ kind: 'mismatch', returned: '7g7f' });
  });

  it('エンジンが失敗したら作り直して 1 度だけ読み直す', async () => {
    const { h } = namedHarness((engineNo) => {
      if (engineNo === 0) throw new Error('dead');
      return named('2g2f', { type: 'mate', value: 3 }, ['2g2f', '8c8d', '2f2e']);
    });
    const outcome = await createKifuRunner(h.deps).evaluateNamed(request);
    expect(outcome).toMatchObject({ kind: 'ok', evaluation: { candidate: { scoreType: 'mate', scoreValue: 3 } } });
    expect(h.engines.map((e) => e.disposed)).toEqual([true, false]);
  });

  it('🔒 詰将棋の判定（stopOnMate）は打ち切りの判定を渡し、打ち切った行の評価で返す（prd/13 §5.5）', async () => {
    const { h } = namedHarness(() => named('2g2f', { type: 'cp', value: 0 }, ['2g2f']));
    const stopWhens: unknown[] = [];
    const created = h.deps.createEngine;
    h.deps.createEngine = async (settings, load, choice, threads) => {
      const engine = await created(settings, load, choice, threads);
      engine.session = {
        setOption: () => {},
        analyze: async (_position, _go, options) => {
          stopWhens.push(options?.stopWhen);
          const mate = { depth: 7, multipv: 1, score: { type: 'mate' as const, value: 9 }, pv: ['2g2f', '8c8d', '2f2e'] };
          const after = { depth: 8, multipv: 1, score: { type: 'cp' as const, value: 900 }, pv: ['2g2f', '3c3d'] };
          // 偽のエンジン: 打ち切りの判定が mate の行で true を返すことを確かめ、打ち切った行を残す
          if (!options?.stopWhen?.(mate)) throw new Error('should stop at the mate');
          return { bestmove: { move: '2g2f' }, infoLines: [mate, after], lastInfo: after, stoppedBy: mate };
        },
      };
      return engine;
    };
    const runner = createKifuRunner(h.deps);
    const outcome = await runner.evaluateNamed({
      ...request,
      settings: { ...request.settings, movetimeMs: 1000, threads: 2, stopOnMate: true },
    });
    expect(outcome).toMatchObject({
      kind: 'ok',
      stopped: true,
      evaluation: { candidate: { scoreType: 'mate', scoreValue: 9, pv: ['2g2f', '8c8d', '2f2e'] }, movetimeMs: 1000 },
    });
    // 次の一手（stopOnMate なし）では打ち切らない
    await runner.evaluateNamed(request).catch(() => {});
    expect(stopWhens[1]).toBeUndefined();
  });

  it('🔒 固定のスレッド数: 作るときはその数で作り、使い回すエンジンは作り直さずに切り替え、全局面解析では負荷の設定の数に戻す', async () => {
    const { h } = namedHarness(() => named('2g2f', { type: 'cp', value: 0 }, ['2g2f']));
    const createdWith: (number | undefined)[] = [];
    const switched: (number | null)[] = [];
    const created = h.deps.createEngine;
    h.deps.createEngine = async (settings, load, choice, threads) => {
      createdWith.push(threads);
      const engine = await created(settings, load, choice, threads);
      let current = threads ?? 4;
      return {
        ...engine,
        get threads() {
          return current;
        },
        setThreads: async (next: number | null) => {
          switched.push(next);
          current = next ?? 4;
        },
      };
    };
    const runner = createKifuRunner(h.deps);
    const mateRequest = { ...request, settings: { ...request.settings, threads: 2 } };

    // 担当がサーバーの端末: 判定のためだけに作るエンジンは、最初から 2 スレッドで作る
    expect(await runner.evaluateNamed(mateRequest)).toMatchObject({ kind: 'ok', evaluation: { threads: 2 } });
    expect(createdWith).toEqual([2]);
    // 次の一手（固定なし）は同じエンジンを負荷の設定の数に戻して読む
    expect(await runner.evaluateNamed(request)).toMatchObject({ kind: 'ok', evaluation: { threads: 4 } });
    // 全局面解析の後に判定が割り込んでも、作り直さずに切り替える
    expect(await runner.analyze(1, neverAborted)).toEqual({ kind: 'complete' });
    expect(await runner.evaluateNamed(mateRequest)).toMatchObject({ kind: 'ok', evaluation: { threads: 2 } });
    expect(await runner.analyze(1, neverAborted)).toEqual({ kind: 'complete' });
    expect(createdWith).toEqual([2]);
    expect(switched).toEqual([2, null, null, 2, null]);
    // 全局面解析の来歴は負荷の設定の数
    expect(h.chunks.every((c) => c.threads === 4)).toBe(true);
  });

  it('スレッド数の切り替えに失敗したら、エンジンを作り直して求める数で作る', async () => {
    const { h } = namedHarness(() => named('2g2f', { type: 'cp', value: 0 }, ['2g2f']));
    const createdWith: (number | undefined)[] = [];
    const created = h.deps.createEngine;
    h.deps.createEngine = async (settings, load, choice, threads) => {
      createdWith.push(threads);
      const engine = await created(settings, load, choice, threads);
      return {
        ...engine,
        threads: threads ?? 4,
        dispose: engine.dispose,
        setThreads: async (next: number | null) => {
          if ((next ?? 4) !== (threads ?? 4)) throw new Error('resize failed');
        },
      };
    };
    const runner = createKifuRunner(h.deps);
    await runner.evaluateNamed(request);
    const outcome = await runner.evaluateNamed({ ...request, settings: { ...request.settings, threads: 2 } });
    expect(outcome).toMatchObject({ kind: 'ok', evaluation: { threads: 2 } });
    expect(createdWith).toEqual([undefined, 2]);
  });

  it('2 度続けて失敗したら failed', async () => {
    const { h } = namedHarness(() => {
      throw new Error('dead');
    });
    expect(await createKifuRunner(h.deps).evaluateNamed(request)).toEqual({ kind: 'failed', detail: 'dead' });
  });
});

describe('createKifuRunner — ほかのタブの採点の読みに譲る（prd/14 §5.10）', () => {
  it('局面の境目で聞き、待っていれば未送信のチャンクを送って paused で止める', async () => {
    const h = harness({});
    let boundaries = 0;
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted, {
      // 3 局面を解析した後の境目で、ほかのタブの採点の読みが現れる
      shouldPause: async () => ++boundaries > 3,
    });
    expect(outcome).toEqual({ kind: 'paused' });
    // 解析した 3 局面は送ってある（続きは次の開始の口から）
    expect(h.chunks.flatMap((c) => c.analyses.map((a) => a.moveNumber))).toEqual([0, 1, 2]);
    expect(h.errors).toEqual([]);
  });
});

describe('createKifuRunner — 見えるのを待つ間も採点の読みに譲る（レビュー OCL-62435AC8）', () => {
  /** 隠れたまま見えるようにならないページ（待ちは中断でだけ終わる） */
  function stuckHidden(h: Harness) {
    h.deps.visibility.waitVisible = (signal) =>
      new Promise<void>((resolve) => {
        h.waitedVisible++;
        signal.addEventListener('abort', () => resolve());
      });
  }

  it('隠れている間のエンジンの失敗で見えるのを待っていても、採点の読みが待てば paused でロックを手放す', async () => {
    const h = harness({
      analyze: (_engineNo, position, harnessState) => {
        if (position === 2) {
          harnessState.hidden = true;
          throw new Error('[USI] Analysis timed out');
        }
      },
    });
    stuckHidden(h);
    let asked = 0;
    // 局面の境目（0..2 の 3 回）の後、見えるのを待つ間の 2 回目で採点の読みが現れる
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted, {
      shouldPause: async () => ++asked > 4,
    });
    expect(outcome).toEqual({ kind: 'paused' });
    expect(h.sleeps).toContain(PAUSE_CHECK_WHILE_HIDDEN_MS);
    expect(h.errors).toEqual([]);
  });

  it('隠れている間のエンジンの読み込みの失敗で待っていても譲る', async () => {
    const h = harness({
      createEngine: () => {
        h.hidden = true;
        throw new Error('fetch failed');
      },
    });
    stuckHidden(h);
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted, {
      shouldPause: async () => true,
    });
    expect(outcome).toEqual({ kind: 'paused' });
  });

  it('採点の読みが待っていなければ、見えるようになるまで待ってから続ける（今までどおり）', async () => {
    let failures = 0;
    const h = harness({
      analyze: (_engineNo, position, harnessState) => {
        if (position === 2 && failures < 1) {
          failures++;
          harnessState.hidden = true;
          throw new Error('[USI] Analysis timed out');
        }
      },
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted, {
      shouldPause: async () => false,
    });
    expect(outcome).toEqual({ kind: 'complete' });
    expect(h.waitedVisible).toBe(1);
  });
});
