import { afterEach, describe, expect, it } from 'vitest';
import {
  answerDrillEngineConsent,
  askDrillEngineConsent,
  getDrillEngineState,
  requestDrillEngine,
  resetDrillEngineForTest,
} from './drillEngine';

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
    answerDrillEngineConsent(true, null);
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
});
