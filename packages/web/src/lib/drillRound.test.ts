import { describe, expect, it } from 'vitest';
import { createRoundStore, roundText, type RoundStorage } from './drillRound';

function memoryStorage(): RoundStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('この回（prd/13 §7.6）', () => {
  it('始めて・開始時刻を決めて・記録した解答を数え、ホームで終える', () => {
    const storage = memoryStorage();
    const store = createRoundStore(() => storage);
    expect(store.get()).toBeNull();
    store.ensure();
    store.startAt('2026-10-25T00:00:00.000Z');
    // 開始時刻は最初の 1 回だけ決める
    store.startAt('2026-10-25T01:00:00.000Z');
    store.record('correct');
    store.record('close');
    store.record('wrong');
    expect(store.get()).toEqual({ since: '2026-10-25T00:00:00.000Z', recorded: 3, correct: 1 });
    store.end();
    expect(store.get()).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('タブの中では読み直しても続く（棋譜詳細から戻るボタンで戻ったとき）', () => {
    const storage = memoryStorage();
    createRoundStore(() => storage).record('correct');
    expect(createRoundStore(() => storage).get()).toEqual({ since: null, recorded: 1, correct: 1 });
  });

  it('既にある回は ensure で作り直さない（入口を切り替えても同じ回）', () => {
    const store = createRoundStore(() => memoryStorage());
    store.ensure();
    store.record('correct');
    store.ensure();
    expect(store.get()?.recorded).toBe(1);
  });

  it('保存先が使えなくてもメモリで続ける', () => {
    const store = createRoundStore(() => {
      throw new Error('blocked');
    });
    store.record('wrong');
    expect(store.get()).toEqual({ since: null, recorded: 1, correct: 0 });
  });

  it('壊れた値は読まない', () => {
    const storage = memoryStorage();
    storage.setItem('seseraki.drills.round', '{"recorded":"x"}');
    expect(createRoundStore(() => storage).get()).toBeNull();
  });

  it('変わったら購読者に知らせる', () => {
    const store = createRoundStore(() => memoryStorage());
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.record('correct');
    off();
    store.record('correct');
    expect(calls).toBe(1);
  });

  it('経過の文言', () => {
    expect(roundText(null)).toBe('この回 0 問中 0 問正解');
    expect(roundText({ since: null, recorded: 5, correct: 3 })).toBe('この回 5 問中 3 問正解');
  });
});
