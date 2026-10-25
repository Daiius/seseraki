import { afterEach, describe, expect, it } from 'vitest';
import {
  GRADER_WAIT_MS,
  gradingFailureMessage,
  requestBrowserGrading,
  setBrowserGrader,
  unavailableReasonOf,
  type GradingDeps,
} from './grading';
import type { NamedEvalOutcome, NamedEvalRequest } from './runner';
import type { BrowserAnalysisPhase } from './store';

const REQUEST: NamedEvalRequest = {
  sfen: 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1',
  move: '2g2f',
  settings: {
    movetimeMs: 600,
    multiPv: 1,
    hashMb: 64,
    maxThreads: 8,
    chunkIntervalMs: 5000,
    chunkMaxPositions: 32,
    pvMaxPlies: 128,
  },
};

const OK: NamedEvalOutcome = { kind: 'mismatch', returned: '7g7f' };

/** 状態と時計を外から動かせる依存 */
function deps(initial: BrowserAnalysisPhase) {
  const state = { phase: initial, listeners: new Set<() => void>(), timers: [] as (() => void)[] };
  const d: GradingDeps = {
    getPhase: () => state.phase,
    subscribe: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    setTimeout: (callback, ms) => {
      expect(ms).toBe(GRADER_WAIT_MS);
      state.timers.push(callback);
      return state.timers.length;
    },
    clearTimeout: () => {},
  };
  const setPhase = (phase: BrowserAnalysisPhase) => {
    state.phase = phase;
    for (const listener of [...state.listeners]) listener();
  };
  return { d, state, setPhase };
}

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

describe('unavailableReasonOf', () => {
  it('同意の前・解析できない・エンジンが無い・止まっている、は頼めない', () => {
    expect(unavailableReasonOf('needs-consent')).toBe('needs-consent');
    expect(unavailableReasonOf('unsupported')).toBe('unsupported');
    expect(unavailableReasonOf('no-engine')).toBe('no-engine');
    expect(unavailableReasonOf('error')).toBe('error');
  });
  it('起動の途中・待機中・読み込み中・解析中は、待てば頼める', () => {
    for (const phase of ['off', 'idle', 'loading', 'analyzing'] as const) {
      expect(unavailableReasonOf(phase)).toBeNull();
    }
  });
});

describe('requestBrowserGrading', () => {
  it('受け持ち手がいれば頼む', async () => {
    const seen: NamedEvalRequest[] = [];
    offs.push(
      setBrowserGrader(async (request) => {
        seen.push(request);
        return OK;
      }),
    );
    expect(await requestBrowserGrading(REQUEST, deps('idle').d)).toEqual(OK);
    expect(seen).toEqual([REQUEST]);
  });

  it('🔒 同意の前は頼まない（推測で判定しない）', async () => {
    expect(await requestBrowserGrading(REQUEST, deps('needs-consent').d)).toEqual({
      kind: 'unavailable',
      reason: 'needs-consent',
    });
  });

  it('起動の途中なら受け持ち手が付くのを待つ', async () => {
    const { d } = deps('off');
    const pending = requestBrowserGrading(REQUEST, d);
    offs.push(setBrowserGrader(async () => OK));
    expect(await pending).toEqual(OK);
  });

  it('待っている間に頼めない状態になったらそう返す', async () => {
    const { d, setPhase } = deps('off');
    const pending = requestBrowserGrading(REQUEST, d);
    setPhase('unsupported');
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'unsupported' });
  });

  it('待っても受け持ち手が付かなければ off', async () => {
    const { d, state } = deps('off');
    const pending = requestBrowserGrading(REQUEST, d);
    state.timers[0]();
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'off' });
  });

  it('同意を求める手立て（askConsent）があれば、同意の前でも答えを待つ。同意したら起動を待って頼む', async () => {
    const { d, setPhase } = deps('needs-consent');
    let agree!: (agreed: boolean) => void;
    let asked = 0;
    const pending = requestBrowserGrading(REQUEST, {
      ...d,
      askConsent: () => {
        asked++;
        return new Promise((resolve) => (agree = resolve));
      },
    });
    await Promise.resolve();
    expect(asked).toBe(1);
    agree(true);
    await Promise.resolve();
    // 起動し直すまで同意の前の状態が残っても、求め直さない
    setPhase('needs-consent');
    expect(asked).toBe(1);
    setPhase('off');
    offs.push(setBrowserGrader(async () => OK));
    expect(await pending).toEqual(OK);
  });

  it('同意を断ったら declined（頼まない）', async () => {
    const { d } = deps('needs-consent');
    expect(await requestBrowserGrading(REQUEST, { ...d, askConsent: async () => false })).toEqual({
      kind: 'unavailable',
      reason: 'declined',
    });
  });

  it('同意を待つ間は時間切れを数えない', async () => {
    const { d, state } = deps('needs-consent');
    let agree!: (agreed: boolean) => void;
    const pending = requestBrowserGrading(REQUEST, {
      ...d,
      askConsent: () => new Promise((resolve) => (agree = resolve)),
    });
    await Promise.resolve();
    // 最初に掛けたタイマーは同意を求めたときに外してある（発火しても off にしない）
    state.timers[0]();
    agree(false);
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'declined' });
  });

  it('読み終える前に常駐が止まったら、起動し直すのを待って頼み直す', async () => {
    let calls = 0;
    const off = setBrowserGrader(async () => {
      calls++;
      off();
      // 止まった後に起動し直した常駐が受け持つ
      offs.push(setBrowserGrader(async () => OK));
      throw new Error('stopped');
    });
    expect(await requestBrowserGrading(REQUEST, deps('idle').d)).toEqual(OK);
    expect(calls).toBe(1);
  });
});

describe('gradingFailureMessage', () => {
  it('🔒 画面の文に内部の用語を出さない', () => {
    const messages = [
      gradingFailureMessage({ kind: 'mismatch', returned: '7g7f' }),
      gradingFailureMessage({ kind: 'failed', detail: 'x' }),
      ...(['needs-consent', 'unsupported', 'no-engine', 'error', 'off', 'declined'] as const).map((reason) =>
        gradingFailureMessage({ kind: 'unavailable', reason }),
      ),
    ];
    for (const message of messages) {
      expect(message).toMatch(/採点/);
      expect(message).not.toMatch(/担当|名指し|searchmoves|quick|full/);
    }
  });
});
