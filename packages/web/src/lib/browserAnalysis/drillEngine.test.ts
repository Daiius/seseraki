import { afterEach, describe, expect, it } from 'vitest';
import {
  answerDrillEngineConsent,
  askDrillEngineConsent,
  getDrillEngineState,
  requestDrillEngine,
  resetDrillEngineForTest,
} from './drillEngine';
import { getBrowserAnalysisSettings } from './settings';

const SHA = 'd'.repeat(64);

afterEach(() => resetDrillEngineForTest());

describe('詰将棋の判定のためのエンジンの段取り（担当がサーバーの端末。prd/13 §5.5）', () => {
  it('最初の 1 手で起こしてほしいと伝え、タブの間は落とさない', () => {
    expect(getDrillEngineState().wanted).toBe(false);
    requestDrillEngine();
    requestDrillEngine();
    expect(getDrillEngineState().wanted).toBe(true);
  });

  it('同意を求めている間に重ねて聞いても、同じ答えを待つ', async () => {
    const first = askDrillEngineConsent();
    const second = askDrillEngineConsent();
    expect(getDrillEngineState().asking).toBe(true);
    answerDrillEngineConsent(true, SHA);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(getDrillEngineState()).toMatchObject({ asking: false, declined: false });
  });

  it('🔒 断ったらこのタブでは聞き直さない（サーバーで判定する）', async () => {
    const asked = askDrillEngineConsent();
    answerDrillEngineConsent(false, null);
    expect(await asked).toBe(false);
    expect(await askDrillEngineConsent()).toBe(false);
    expect(getDrillEngineState()).toMatchObject({ asking: false, declined: true });
  });

  it('取り下げたら待つのをやめて false。断ったことにはせず、ほかに待つ呼び出しが無ければ案内を閉じる', async () => {
    const controller = new AbortController();
    const asked = askDrillEngineConsent(controller.signal);
    expect(getDrillEngineState().asking).toBe(true);
    controller.abort();
    expect(await asked).toBe(false);
    expect(getDrillEngineState()).toMatchObject({ asking: false, declined: false });
  });

  it('取り下げても、ほかに待つ呼び出しがあれば案内は閉じない（その呼び出しは答えを受け取る）', async () => {
    const controller = new AbortController();
    const withdrawn = askDrillEngineConsent(controller.signal);
    const other = askDrillEngineConsent();
    controller.abort();
    expect(await withdrawn).toBe(false);
    expect(getDrillEngineState().asking).toBe(true);
    answerDrillEngineConsent(true, SHA);
    expect(await other).toBe(true);
  });

  it('取り下げ済みなら聞かない', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await askDrillEngineConsent(controller.signal)).toBe(false);
    expect(getDrillEngineState().asking).toBe(false);
  });

  it('同意したら評価関数の同意を端末の設定に足す', async () => {
    const asked = askDrillEngineConsent();
    answerDrillEngineConsent(true, SHA);
    expect(await asked).toBe(true);
    expect(getBrowserAnalysisSettings().consentedEvalSha256s).toContain(SHA);
  });

  it('🔒 評価関数が分からない（null）まま同意しても、同意として扱わない（断ったことになる）', async () => {
    const before = getBrowserAnalysisSettings().consentedEvalSha256s;
    const asked = askDrillEngineConsent();
    answerDrillEngineConsent(true, null);
    expect(await asked).toBe(false);
    expect(getBrowserAnalysisSettings().consentedEvalSha256s).toEqual(before);
    expect(getDrillEngineState()).toMatchObject({ asking: false, declined: true });
  });
});
