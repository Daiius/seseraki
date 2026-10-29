import { afterEach, describe, expect, it, vi } from 'vitest';
import { gradingFailureMessage, requestBrowserGrading } from './drillGrading';
import type { NamedEvalOutcome, NamedEvalRequest } from './engineReads';
import { fakeReaderDeps as deps } from './readerTestDeps';
import { setBrowserReader, type BrowserReader } from './readerRegistry';
import { PriorityAbortedError, SchedulerStoppedError } from './scheduler';

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

/** 名指しの読みだけを受け持つ常駐（局面評価は使わない） */
const setBrowserGrader = (named: BrowserReader['named']) =>
  setBrowserReader({ named, position: async () => ({ kind: 'aborted' }) });

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
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
      throw new SchedulerStoppedError();
    });
    expect(await requestBrowserGrading(REQUEST, deps('idle').d)).toEqual(OK);
    expect(calls).toBe(1);
  });

  it('常駐の停止でない失敗は頼み直さず、警告を出して failed にする', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    offs.push(
      setBrowserGrader(async () => {
        calls++;
        throw new Error('unexpected');
      }),
    );
    expect(await requestBrowserGrading(REQUEST, deps('idle').d)).toEqual({
      kind: 'failed',
      detail: 'unexpected',
    });
    expect(calls).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('requestBrowserGrading の取り下げ（解いている画面を離れた）', () => {
  it('受け持ち手に取り下げの合図を渡す', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    offs.push(
      setBrowserGrader(async (_request, signal) => {
        seen = signal;
        return OK;
      }),
    );
    expect(await requestBrowserGrading(REQUEST, deps('idle').d, controller.signal)).toEqual(OK);
    expect(seen).toBe(controller.signal);
  });

  it('取り下げ済みなら頼まない', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    offs.push(setBrowserGrader(async () => (calls++, OK)));
    expect(await requestBrowserGrading(REQUEST, deps('idle').d, controller.signal)).toEqual({ kind: 'aborted' });
    expect(calls).toBe(0);
  });

  it('受け持ち手を待つ間に取り下げられたら、待つのをやめて aborted', async () => {
    const controller = new AbortController();
    const pending = requestBrowserGrading(REQUEST, deps('off').d, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
  });

  it('順番を待つ間に取り下げられて断られたら aborted（失敗として警告しない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    offs.push(
      setBrowserGrader(
        (_request, signal) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(new PriorityAbortedError())),
          ),
      ),
    );
    const pending = requestBrowserGrading(REQUEST, deps('idle').d, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('同意を待つ間に取り下げられたら、同意を求める手立てにも合図が届き aborted', async () => {
    const controller = new AbortController();
    let consentSignal: AbortSignal | undefined;
    const pending = requestBrowserGrading(
      REQUEST,
      {
        ...deps('needs-consent').d,
        askConsent: (signal) => {
          consentSignal = signal;
          return new Promise(() => {});
        },
      },
      controller.signal,
    );
    await Promise.resolve();
    expect(consentSignal).toBe(controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
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
