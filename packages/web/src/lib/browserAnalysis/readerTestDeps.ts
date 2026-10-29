/** テスト用: 状態と時計を外から動かせる、読みの依頼の依存（`readerRegistry.ts` の {@link ReaderDeps}） */
import { expect } from 'vitest';
import { READER_WAIT_MS, type ReaderDeps } from './readerRegistry';
import type { BrowserAnalysisPhase } from './store';

export function fakeReaderDeps(initial: BrowserAnalysisPhase) {
  const state = { phase: initial, listeners: new Set<() => void>(), timers: [] as (() => void)[] };
  const d: ReaderDeps = {
    getPhase: () => state.phase,
    subscribe: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    setTimeout: (callback, ms) => {
      expect(ms).toBe(READER_WAIT_MS);
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
