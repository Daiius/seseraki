import { describe, expect, it } from 'vitest';
import { createConsentPrompt } from './consentPrompt';
import { getBrowserAnalysisSettings } from './settings';

const SHA = 'f'.repeat(64);

/** 外から「ほかの経路で同意された」を起こせる見張り */
function elsewhere() {
  const listeners = new Set<() => void>();
  const state = { agreed: false };
  return {
    state,
    listeners,
    option: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      agreed: () => state.agreed,
    },
    fire() {
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('createConsentPrompt（押した時点の同意）', () => {
  it('重ねて聞いても案内は 1 つで、答えは全員に届く。同意は端末の設定に足す', async () => {
    const prompt = createConsentPrompt({ rememberDecline: false });
    const first = prompt.ask();
    const second = prompt.ask();
    expect(prompt.getState().asking).toBe(true);
    prompt.answer(true, SHA);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(prompt.getState()).toEqual({ asking: false, declined: false });
    expect(getBrowserAnalysisSettings().consentedEvalSha256s).toContain(SHA);
  });

  it.each([true, false])(
    '🔒 取り下げたら false。断ったことにはせず、ほかに待つ呼び出しが無ければ案内を閉じる（rememberDecline: %s）',
    async (rememberDecline) => {
      const prompt = createConsentPrompt({ rememberDecline });
      const controller = new AbortController();
      const withdrawn = prompt.ask(controller.signal);
      const other = prompt.ask();
      controller.abort();
      expect(await withdrawn).toBe(false);
      // ほかに待つ呼び出しがあるうちは閉じない
      expect(prompt.getState().asking).toBe(true);
      prompt.answer(true, SHA);
      expect(await other).toBe(true);

      const again = new AbortController();
      const alone = prompt.ask(again.signal);
      again.abort();
      expect(await alone).toBe(false);
      expect(prompt.getState()).toEqual({ asking: false, declined: false });
    },
  );

  it('取り下げ済みなら聞かない', async () => {
    const prompt = createConsentPrompt({ rememberDecline: false });
    const controller = new AbortController();
    controller.abort();
    expect(await prompt.ask(controller.signal)).toBe(false);
    expect(prompt.getState().asking).toBe(false);
  });

  it('rememberDecline: 断ったら以後は聞かずに false（reset まで）', async () => {
    const prompt = createConsentPrompt({ rememberDecline: true });
    const asked = prompt.ask();
    prompt.answer(false, null);
    expect(await asked).toBe(false);
    expect(prompt.getState()).toEqual({ asking: false, declined: true });
    expect(await prompt.ask()).toBe(false);
    expect(prompt.getState().asking).toBe(false);
    prompt.reset();
    void prompt.ask();
    expect(prompt.getState().asking).toBe(true);
  });

  it('rememberDecline なし: 断っても覚えない', async () => {
    const prompt = createConsentPrompt({ rememberDecline: false });
    const asked = prompt.ask();
    prompt.answer(false, null);
    expect(await asked).toBe(false);
    expect(prompt.getState().declined).toBe(false);
    void prompt.ask();
    expect(prompt.getState().asking).toBe(true);
  });

  it('🔒 評価関数が分からない（null）まま同意しても、何も保存せず false（断ったものとして扱う）', async () => {
    const before = getBrowserAnalysisSettings().consentedEvalSha256s;
    const prompt = createConsentPrompt({ rememberDecline: true });
    const asked = prompt.ask();
    prompt.answer(true, null);
    expect(await asked).toBe(false);
    expect(getBrowserAnalysisSettings().consentedEvalSha256s).toEqual(before);
    expect(prompt.getState()).toEqual({ asking: false, declined: true });
  });

  it('案内を出している間にほかの経路で同意されたら、同意したものとして答えて閉じる。閉じたら聞くのをやめる', async () => {
    const watch = elsewhere();
    const prompt = createConsentPrompt({ rememberDecline: false, settledElsewhere: watch.option });
    expect(watch.listeners.size).toBe(0);
    const asked = prompt.ask();
    expect(watch.listeners.size).toBe(1);
    // 同意の前の状態のまま変わっただけでは答えない
    watch.fire();
    expect(prompt.getState().asking).toBe(true);
    watch.state.agreed = true;
    watch.fire();
    expect(await asked).toBe(true);
    expect(prompt.getState().asking).toBe(false);
    expect(watch.listeners.size).toBe(0);
  });
});
