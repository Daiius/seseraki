import { describe, expect, it } from 'vitest';
import { analyzeKifu } from './kifu-analysis';
import {
  createUsiSession,
  USI_DEFAULT_TIMEOUT_MS,
  type UsiTransport,
} from './session';

/**
 * 偽の transport。送られた行を記録し、テストからエンジンの行・死を流し込む。
 * `autoReply` を渡すと、送られた行に応じてエンジンの応答を返す。
 */
function createFakeTransport(autoReply?: (line: string) => string[]) {
  const sent: string[] = [];
  let lineListener: ((line: string) => void) | undefined;
  let deathListener: ((error: Error) => void) | undefined;
  const emit = (...lines: string[]) => {
    for (const line of lines) lineListener?.(line);
  };
  const transport: UsiTransport = {
    send: (line) => {
      sent.push(line);
      if (autoReply) emit(...autoReply(line));
    },
    onLine: (listener) => {
      lineListener = listener;
    },
    onDeath: (listener) => {
      deathListener = listener;
    },
  };
  return {
    transport,
    sent,
    emit,
    die: (message: string) => deathListener?.(new Error(message)),
  };
}

/** 偽のタイマー。`fire` で残っているタイマーを発火させ、掛かった時間と解除の有無を見る */
function createFakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  const scheduled: number[] = [];
  return {
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        const id = nextId++;
        pending.set(id, { callback, ms });
        scheduled.push(ms);
        return id;
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    /** これまでに掛けたタイマーの時間 */
    scheduled,
    /** まだ解除されていないタイマーの数 */
    pendingCount: () => pending.size,
    /** 残っているタイマーをすべて発火させる */
    fire: () => {
      const callbacks = [...pending.values()].map((t) => t.callback);
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function createLog() {
  const info: string[] = [];
  const error: string[] = [];
  return {
    log: {
      info: (message: string) => {
        info.push(message);
      },
      error: (message: string) => {
        error.push(message);
      },
    },
    info,
    error,
  };
}

function setup(autoReply?: (line: string) => string[], timeoutMs?: number) {
  const fake = createFakeTransport(autoReply);
  const clock = createFakeTimers();
  const logs = createLog();
  const session = createUsiSession(fake.transport, {
    timers: clock.timers,
    log: logs.log,
    timeoutMs,
  });
  return { ...fake, clock, logs, session };
}

describe('start（usi → usiok）', () => {
  it('usi を送り、usiok まで待つ。途中の id name を覚える', async () => {
    const { session, sent, emit, clock, logs } = setup();
    expect(session.getName()).toBeUndefined();

    const started = session.start();
    expect(sent).toEqual(['usi']);

    emit(
      'id name YaneuraOu NNUE 9.00 64WASM ',
      'id author by yaneurao',
      'option name Threads type spin default 4 min 1 max 1024',
      'usiok',
    );
    await started;

    expect(session.getName()).toBe('YaneuraOu NNUE 9.00 64WASM');
    expect(clock.pendingCount()).toBe(0);
    expect(logs.info).toEqual([
      '[USI >] usi',
      '[USI] Engine initialized (usiok)',
    ]);
  });

  it('usiok が来なければ時間切れで失敗する', async () => {
    const { session, clock } = setup();

    const started = session.start();
    expect(clock.scheduled).toEqual([USI_DEFAULT_TIMEOUT_MS]);
    clock.fire();

    await expect(started).rejects.toThrow('[USI] Timeout waiting for "usiok"');
  });
});

describe('ready（isready → readyok）', () => {
  it('readyok を待つ。前後の空白と、関係のない行は読み飛ばす', async () => {
    const { session, sent, emit, logs } = setup();

    let settled = false;
    const ready = session.ready().then(() => {
      settled = true;
    });
    expect(sent).toEqual(['isready']);

    emit('info string loading eval file : nn.bin', 'readyokay');
    await Promise.resolve();
    expect(settled).toBe(false);

    emit('readyok\r');
    await ready;
    expect(logs.info).toContain('[USI] Engine ready (readyok)');
  });

  it('時間は呼び出しごとの指定（timeoutMs）で変えられる', async () => {
    const { session, clock } = setup(undefined, 1234);

    const ready = session.ready();
    expect(clock.scheduled).toEqual([1234]);
    clock.fire();

    await expect(ready).rejects.toThrow('[USI] Timeout waiting for "readyok"');
  });

  it('待っている間にエンジンが死んだら、そのエラーで失敗する', async () => {
    const { session, die, clock } = setup();

    const ready = session.ready();
    die('[USI] Engine process exited (code 1)');

    await expect(ready).rejects.toThrow('[USI] Engine process exited (code 1)');
    expect(clock.pendingCount()).toBe(0);
  });
});

describe('setOption / getOption', () => {
  it('setoption を送り、送った値を覚える（未設定は undefined）', () => {
    const { session, sent } = setup();

    expect(session.getOption('MultiPV')).toBeUndefined();
    session.setOption('MultiPV', '3');
    session.setOption('USI_Hash', '64');
    session.setOption('MultiPV', '1');

    expect(sent).toEqual([
      'setoption name MultiPV value 3',
      'setoption name USI_Hash value 64',
      'setoption name MultiPV value 1',
    ]);
    expect(session.getOption('MultiPV')).toBe('1');
    expect(session.getOption('USI_Hash')).toBe('64');
  });
});

describe('analyze（position + go → bestmove）', () => {
  it('position と go を送り、bestmove までの info 行を集めて返す', async () => {
    const { session, sent, emit, clock } = setup();

    const analysis = session.analyze('position startpos', 'go movetime 300');
    expect(sent).toEqual(['position startpos', 'go movetime 300']);

    emit(
      'info depth 1 seldepth 1 multipv 1 score cp 30 nodes 10 nps 100 time 1 pv 7g7f',
      'info depth 8 seldepth 12 multipv 1 score cp 42 nodes 9000 nps 90000 hashfull 3 time 100 pv 7g7f 3c3d 2g2f',
      'bestmove 7g7f ponder 3c3d',
    );
    const result = await analysis;

    expect(result.bestmove).toEqual({ move: '7g7f', ponder: '3c3d' });
    expect(result.infoLines).toHaveLength(2);
    expect(result.lastInfo).toMatchObject({
      depth: 8,
      score: { type: 'cp', value: 42 },
      pv: ['7g7f', '3c3d', '2g2f'],
    });
    expect(clock.pendingCount()).toBe(0);
  });

  it('info 行が 1 本も無いまま bestmove が来たら、空の結果を返す（詰みの局面の resign）', async () => {
    const { session, emit } = setup();

    const analysis = session.analyze('position startpos', 'go movetime 300');
    emit('bestmove resign');

    await expect(analysis).resolves.toEqual({
      bestmove: { move: 'resign', ponder: undefined },
      infoLines: [],
      lastInfo: {},
    });
  });

  it('bestmove が来なければ時間切れで失敗し、後から届いた行は次の探索に混ざらない', async () => {
    const { session, emit, clock } = setup(undefined, 5000);

    const first = session.analyze('position startpos', 'go movetime 300');
    expect(clock.scheduled).toEqual([5000]);
    clock.fire();
    await expect(first).rejects.toThrow('[USI] Analysis timed out');

    // 時間切れの後に遅れて届いた行は、誰にも拾われない
    emit('info depth 3 multipv 1 score cp 999 pv 1g1f');

    const second = session.analyze(
      'position startpos moves 7g7f',
      'go movetime 300',
    );
    emit('info depth 5 multipv 1 score cp -20 pv 3c3d', 'bestmove 3c3d');
    const result = await second;
    expect(result.infoLines).toHaveLength(1);
    expect(result.lastInfo.score).toEqual({ type: 'cp', value: -20 });
  });

  it('探索の途中でエンジンが死んだら、そのエラーで失敗する', async () => {
    const { session, emit, die, clock } = setup();

    const analysis = session.analyze('position startpos', 'go movetime 300');
    emit('info depth 1 multipv 1 score cp 30 pv 7g7f');
    die('[USI] Engine process exited (code null)');

    await expect(analysis).rejects.toThrow(
      '[USI] Engine process exited (code null)',
    );
    expect(clock.pendingCount()).toBe(0);
  });

  it('info string Error! は、その行を文面にしたエラーで失敗する（不正な指し手）', async () => {
    const { session, emit, logs, clock } = setup();
    const line = 'info string Error! : Illegal Input Move : 9z9z';

    const analysis = session.analyze(
      'position startpos moves 9z9z',
      'go movetime 300',
    );
    emit(line);

    await expect(analysis).rejects.toThrow(line);
    expect(logs.error).toEqual([`[USI] Engine error: ${line}`]);
    expect(clock.pendingCount()).toBe(0);
  });

  it('ただの info string は失敗にしない', async () => {
    const { session, emit } = setup();

    const analysis = session.analyze('position startpos', 'go movetime 300');
    emit(
      'info string optimal_time = 300',
      'info depth 2 multipv 1 score cp 10 pv 7g7f',
      'bestmove 7g7f',
    );

    expect((await analysis).bestmove.move).toBe('7g7f');
  });
});

describe('エンジンが死んだ後', () => {
  it('送信は投げ、探索と待機は失敗する（タイマーも掛けない）', async () => {
    const { session, sent, die, clock } = setup();
    die('[USI] Engine process exited (code 137)');

    expect(() => session.setOption('MultiPV', '1')).toThrow(
      '[USI] Engine is not running',
    );
    expect(() => session.send('quit')).toThrow('[USI] Engine is not running');
    await expect(session.ready()).rejects.toThrow(
      '[USI] Engine is not running',
    );
    await expect(
      session.analyze('position startpos', 'go movetime 300'),
    ).rejects.toThrow('[USI] Engine is not running');
    await expect(session.waitFor('readyok')).rejects.toThrow(
      '[USI] Engine is not running',
    );

    expect(sent).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });

  it('transport の送信が投げたら、探索はそのエラーで失敗する', async () => {
    const clock = createFakeTimers();
    const transport: UsiTransport = {
      send: () => {
        throw new Error('write EPIPE');
      },
      onLine: () => {},
      onDeath: () => {},
    };
    const session = createUsiSession(transport, { timers: clock.timers });

    await expect(
      session.analyze('position startpos', 'go movetime 300'),
    ).rejects.toThrow('write EPIPE');
    expect(clock.pendingCount()).toBe(0);
  });

  it('Error でない値が投げられても、message を文面にした Error で失敗する（WASM の終了）', async () => {
    const clock = createFakeTimers();
    const transport: UsiTransport = {
      send: () => {
        throw {
          name: 'ExitStatus',
          message: 'Program terminated with exit(1)',
          status: 1,
        };
      },
      onLine: () => {},
      onDeath: () => {},
    };
    const session = createUsiSession(transport, { timers: clock.timers });

    const failure = session.analyze('position startpos', 'go movetime 300');
    await expect(failure).rejects.toBeInstanceOf(Error);
    await expect(failure).rejects.toThrow('Program terminated with exit(1)');
  });
});

describe('analyzeKifu との組み合わせ', () => {
  it('セッションをそのままエンジンとして渡せる（MultiPV の設定・局面ごとの position・後始末）', async () => {
    const { session, sent } = setup((line) => {
      if (line === 'usi') return ['id name Fake Engine', 'usiok'];
      if (line === 'isready') return ['readyok'];
      if (line.startsWith('go ')) {
        return [
          'info depth 4 multipv 1 score cp 12 pv 7g7f 3c3d',
          'bestmove 7g7f',
        ];
      }
      return [];
    });
    await session.start();
    await session.ready();

    const chunks: number[][] = [];
    const summary = await analyzeKifu(session, ['7g7f', '3c3d'], {
      multiPv: 1,
      movetime: 300,
      onChunk: async (analyses) => {
        chunks.push(analyses.map((a) => a.moveNumber));
      },
    });

    expect(summary).toMatchObject({
      totalMoves: 2,
      analyzed: 3,
      interrupted: false,
    });
    expect(chunks).toEqual([[0, 1, 2]]);
    expect(sent).toEqual([
      'usi',
      'isready',
      'setoption name MultiPV value 1',
      'position startpos',
      'go movetime 300',
      'position startpos moves 7g7f',
      'go movetime 300',
      'position startpos moves 7g7f 3c3d',
      'go movetime 300',
      'setoption name MultiPV value 1',
    ]);
    expect(session.getName()).toBe('Fake Engine');
  });
});
