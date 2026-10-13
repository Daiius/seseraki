import { describe, expect, it } from 'vitest';
import type {
  BrowserAnalysisChunk,
  BrowserAnalysisRun,
  UsiSearchResult,
} from 'shared';
import {
  classifyFailureStatus,
  createKifuRunner,
  MAX_STALE_RESTARTS,
  RETRY_DELAYS_MS,
  type AnalysisEngine,
  type ChunkResult,
  type LocalProgress,
  type RunnerDeps,
  type StartResult,
} from './runner';

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

const runOf = (overrides: Partial<BrowserAnalysisRun> = {}): StartResult => ({
  kind: 'run',
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
}

function harness(script: {
  start?: (call: number) => StartResult;
  chunk?: (chunk: BrowserAnalysisChunk, call: number) => ChunkResult;
  /** エンジン（通し番号）が局面を解析するときに呼ぶ。投げればエンジンの失敗 */
  analyze?: (engineNo: number, position: number, h: Harness) => void;
  createEngine?: (engineNo: number) => void;
  reportError?: () => boolean;
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
    deps: undefined as unknown as RunnerDeps,
  };
  h.deps = {
    engineInfo: ENGINE_INFO,
    api: {
      start: async () => (script.start ?? (() => runOf()))(h.starts++),
      submitChunk: async (_no, chunk) => {
        h.chunks.push(chunk);
        const last = chunk.analyses.at(-1)!.moveNumber;
        return script.chunk
          ? script.chunk(chunk, h.chunks.length - 1)
          : { kind: 'ok', applied: true, completed: last === USI_MOVES.length };
      },
      reportError: async (_no, body) => {
        h.errors.push(body);
        return script.reportError ? script.reportError() : true;
      },
    },
    createEngine: async () => {
      const engineNo = h.engines.length;
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
    now: () => 1_000,
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
          ? { kind: 'ok', applied: false, completed: false }
          : {
              kind: 'ok',
              applied: true,
              completed: chunk.analyses.at(-1)!.moveNumber === USI_MOVES.length,
            },
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
      chunk: () => ({ kind: 'ok', applied: false, completed: false }),
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
        return {
          kind: 'ok',
          applied: true,
          completed: chunk.analyses.at(-1)!.moveNumber === USI_MOVES.length,
        };
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
      reportError: () => false,
    });
    const outcome = await createKifuRunner(h.deps).analyze(3, neverAborted);
    expect(outcome.kind).toBe('deferred');
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
