import { afterEach, describe, expect, it } from 'vitest';
import { createInitialState, parseSfen, positionSfen } from 'shared';
import type { NamedEvalOutcome, PositionEvalOutcome, PositionEvalRequest } from './engineReads';
import { setBrowserReader } from './readerRegistry';
import { fakeReaderDeps } from './readerTestDeps';
import { patchBrowserAnalysisState, resetBrowserAnalysisState } from './store';
import {
  STUDY_EVAL_SETTINGS,
  answerStudyEvalConsent,
  askStudyEvalConsent,
  isAskingStudyEvalConsent,
  requestBrowserPositionEval,
  requestBrowserStudyEval,
  resetStudyEvalConsentForTest,
  studyEvalUnavailableMessage,
} from './studyEval';

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  resetStudyEvalConsentForTest();
  resetBrowserAnalysisState();
});

const initial = createInitialState();
const TARGET = { sfen: positionSfen(initial), move: null, from: initial };
const never = new AbortController().signal;
const SHA = 'e'.repeat(64);
const UNUSED: NamedEvalOutcome = { kind: 'failed', detail: 'unused' };

/** 局面評価だけを受け持つ常駐（頼まれた内容を記録する） */
function serve(outcome: PositionEvalOutcome) {
  const seen: PositionEvalRequest[] = [];
  offs.push(
    setBrowserReader({
      named: async () => ({ kind: 'failed', detail: 'unused' }),
      position: async (request) => {
        seen.push(request);
        return outcome;
      },
    }),
  );
  return seen;
}

describe('局面評価の読み方（web の定数。prd/12 §2.4）', () => {
  it('候補 3 本・1000ms・スレッドの上限 4。エンジンが無いときに作る大きさは全局面解析と同じ', () => {
    expect(STUDY_EVAL_SETTINGS).toMatchObject({
      multiPv: 3,
      movetimeMs: 1000,
      stageMaxThreads: 4,
      maxThreads: 8,
      hashMb: 64,
    });
  });
});

describe('requestBrowserPositionEval（検討盤の局面評価。prd/12 §2.4）', () => {
  const POSITION: PositionEvalRequest = { sfen: TARGET.sfen, settings: STUDY_EVAL_SETTINGS };
  const DONE: PositionEvalOutcome = { kind: 'ok', candidates: [], threads: 4 };

  it('受け持ち手がいれば、取り下げの合図ごと頼む', async () => {
    const seen: { request: PositionEvalRequest; signal: AbortSignal }[] = [];
    offs.push(
      setBrowserReader({
        named: async () => UNUSED,
        position: async (request, signal) => {
          seen.push({ request, signal });
          return DONE;
        },
      }),
    );
    const signal = new AbortController().signal;
    expect(await requestBrowserPositionEval(POSITION, signal, fakeReaderDeps('idle').d)).toEqual(DONE);
    expect(seen).toEqual([{ request: POSITION, signal }]);
  });

  it('取り下げられていれば頼まない', async () => {
    let calls = 0;
    offs.push(setBrowserReader({ named: async () => UNUSED, position: async () => (calls++, DONE) }));
    const controller = new AbortController();
    controller.abort();
    expect(await requestBrowserPositionEval(POSITION, controller.signal, fakeReaderDeps('idle').d)).toEqual({
      kind: 'aborted',
    });
    expect(calls).toBe(0);
  });

  it('受け持ち手を待つ間に取り下げられたら、待つのをやめて aborted', async () => {
    const controller = new AbortController();
    const pending = requestBrowserPositionEval(POSITION, controller.signal, fakeReaderDeps('off').d);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
  });

  it('同意の前は、同意を求める手立てに取り下げの合図を渡して答えを待つ', async () => {
    const { d, setPhase } = fakeReaderDeps('needs-consent');
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const pending = requestBrowserPositionEval(POSITION, controller.signal, {
      ...d,
      askConsent: async (signal) => {
        signals.push(signal);
        return true;
      },
    });
    await Promise.resolve();
    expect(signals).toEqual([controller.signal]);
    setPhase('off');
    offs.push(setBrowserReader({ named: async () => UNUSED, position: async () => DONE }));
    expect(await pending).toEqual(DONE);
  });

  it('同意を断ったら declined、解析できない環境なら unsupported（読まない）', async () => {
    const signal = new AbortController().signal;
    expect(
      await requestBrowserPositionEval(POSITION, signal, {
        ...fakeReaderDeps('needs-consent').d,
        askConsent: async () => false,
      }),
    ).toEqual({ kind: 'unavailable', reason: 'declined' });
    expect(await requestBrowserPositionEval(POSITION, signal, fakeReaderDeps('unsupported').d)).toEqual({
      kind: 'unavailable',
      reason: 'unsupported',
    });
  });
});

describe('requestBrowserStudyEval（検討盤の EvalResult にする）', () => {
  it('このブラウザで読んだ候補手を、出所 engine の結果として返す（再利用はしない）', async () => {
    const candidates = [
      { rank: 1, move: '2g2f', scoreType: 'cp' as const, scoreValue: 40, depth: 15, pv: ['2g2f'] },
    ];
    const seen = serve({ kind: 'ok', candidates, threads: 4 });
    const result = await requestBrowserStudyEval(TARGET, never);
    expect(result).toMatchObject({ kind: 'done', candidates, source: 'engine', fallback: false });
    expect(seen).toEqual([{ sfen: TARGET.sfen, settings: STUDY_EVAL_SETTINGS }]);
  });

  it('🔒 エンジンに渡せない局面は読まずに invalid（server の口を通らないので、ここで検証する）', async () => {
    const seen = serve({ kind: 'ok', candidates: [], threads: 4 });
    // 後手玉の無い局面
    const noKing = parseSfen('lnsg1gsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -')!;
    const result = await requestBrowserStudyEval(
      { sfen: positionSfen(noKing), move: null, from: noKing },
      never,
    );
    expect(result.kind).toBe('invalid');
    expect(seen).toEqual([]);
  });

  it('取り下げ・読みの失敗・端末で読めない、をそれぞれ EvalResult に畳む', async () => {
    serve({ kind: 'aborted' });
    expect(await requestBrowserStudyEval(TARGET, never)).toEqual({ kind: 'aborted' });
    for (const off of offs.splice(0)) off();

    serve({ kind: 'failed', detail: 'dead' });
    expect(await requestBrowserStudyEval(TARGET, never)).toEqual({
      kind: 'failed',
      message: 'この局面を評価できませんでした（dead）',
    });
    for (const off of offs.splice(0)) off();

    patchBrowserAnalysisState({ phase: 'unsupported' });
    expect(await requestBrowserStudyEval(TARGET, never)).toEqual({
      kind: 'failed',
      message: studyEvalUnavailableMessage('unsupported'),
    });
  });

  it('🔒 同意の前なら押した時点で同意を求め、断ったら読まない', async () => {
    patchBrowserAnalysisState({ phase: 'needs-consent' });
    const pending = requestBrowserStudyEval(TARGET, never);
    await Promise.resolve();
    expect(isAskingStudyEvalConsent()).toBe(true);
    answerStudyEvalConsent(false, null);
    expect(await pending).toEqual({
      kind: 'failed',
      message: studyEvalUnavailableMessage('declined'),
    });
    expect(isAskingStudyEvalConsent()).toBe(false);
  });
});

describe('ほかの案内から同意されたとき', () => {
  it('常駐が同意の前の状態を抜けたら案内を閉じ、そのまま読む', async () => {
    patchBrowserAnalysisState({ phase: 'needs-consent' });
    const pending = requestBrowserStudyEval(TARGET, never);
    await Promise.resolve();
    expect(isAskingStudyEvalConsent()).toBe(true);
    // 棋譜の詳細の案内から同意された → 常駐が起動し直す（off → idle）
    patchBrowserAnalysisState({ phase: 'off' });
    expect(isAskingStudyEvalConsent()).toBe(false);
    serve({ kind: 'ok', candidates: [], threads: 4 });
    patchBrowserAnalysisState({ phase: 'idle' });
    expect(await pending).toMatchObject({ kind: 'done', candidates: [] });
  });
});

describe('askStudyEvalConsent（押した時点の同意）', () => {
  it('重ねて聞いても同じ答えを待ち、答えたら案内を閉じる', async () => {
    const first = askStudyEvalConsent();
    const second = askStudyEvalConsent();
    expect(isAskingStudyEvalConsent()).toBe(true);
    answerStudyEvalConsent(true, SHA);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(isAskingStudyEvalConsent()).toBe(false);
  });

  it('局面が変わったら（取り下げ）false で返し、待つ呼び出しが無くなれば案内を閉じる', async () => {
    const controller = new AbortController();
    const asked = askStudyEvalConsent(controller.signal);
    controller.abort();
    expect(await asked).toBe(false);
    expect(isAskingStudyEvalConsent()).toBe(false);
  });

  it('🔒 評価関数が分からない（null）まま同意しても、同意として扱わない', async () => {
    const asked = askStudyEvalConsent();
    answerStudyEvalConsent(true, null);
    expect(await asked).toBe(false);
    expect(isAskingStudyEvalConsent()).toBe(false);
  });

  it('断っても覚えない（次に押したらまた聞く）', async () => {
    const asked = askStudyEvalConsent();
    answerStudyEvalConsent(false, null);
    expect(await asked).toBe(false);
    void askStudyEvalConsent();
    expect(isAskingStudyEvalConsent()).toBe(true);
  });
});

describe('studyEvalUnavailableMessage', () => {
  it('🔒 画面の文に内部の用語を出さない', () => {
    for (const reason of ['needs-consent', 'declined', 'unsupported', 'no-engine', 'error', 'off'] as const) {
      const message = studyEvalUnavailableMessage(reason);
      expect(message).toMatch(/評価/);
      expect(message).not.toMatch(/担当|MultiPV|quick|full|名指し/);
    }
  });
});
