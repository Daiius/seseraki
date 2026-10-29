import { describe, expect, it } from 'vitest';
import {
  createEngineCache,
  engineKey,
  STOPPED_DETAIL,
  type AnalysisEngine,
  type EngineChoice,
  type EngineSettings,
} from './engineCache';
import type { AnalysisLoad } from './settings';

const MINI: EngineChoice = {
  id: 'tsuyo11mini',
  info: { engineBuild: 'c1b80eaa-mini', evalHash: 'a'.repeat(64), fvScale: 16 },
};
const MICRO: EngineChoice = {
  id: 'tsuyo11micro',
  info: { engineBuild: 'c1b80eaa-micro', evalHash: 'b'.repeat(64), fvScale: 16 },
};
const SIZING = { maxThreads: 8, hashMb: 64 };

describe('engineKey（エンジンを作り直すかのキー）', () => {
  it('評価関数・エンジンの上限・置換表・負荷が同じなら同じキー', () => {
    expect(engineKey(MINI, SIZING, 'max')).toBe(engineKey({ ...MINI }, { ...SIZING }, 'max'));
  });

  it('評価関数の選択・エンジンの上限・置換表・負荷のどれかが変われば別のキー', () => {
    const base = engineKey(MINI, SIZING, 'max');
    expect(engineKey(MICRO, SIZING, 'max')).not.toBe(base);
    expect(engineKey(MINI, { ...SIZING, maxThreads: 4 }, 'max')).not.toBe(base);
    expect(engineKey(MINI, { ...SIZING, hashMb: 128 }, 'max')).not.toBe(base);
    expect(engineKey(MINI, SIZING, 'gentle')).not.toBe(base);
    // 同じ id でもビルド・評価関数のハッシュが違えば別のエンジン（配信物を入れ替えた）
    expect(engineKey({ ...MINI, info: { ...MINI.info, evalHash: 'c'.repeat(64) } }, SIZING, 'max')).not.toBe(base);
    expect(engineKey({ ...MINI, info: { ...MINI.info, engineBuild: 'other' } }, SIZING, 'max')).not.toBe(base);
  });

  it('🔒 段ごとの上限（stageMaxThreads）はキーに入れない（段が変わるたびに作り直さない）', () => {
    expect(engineKey(MINI, { ...SIZING, stageMaxThreads: 4 } as typeof SIZING, 'max')).toBe(
      engineKey(MINI, { ...SIZING, stageMaxThreads: 8 } as typeof SIZING, 'max'),
    );
  });
});

describe('createEngineCache', () => {
  /** 作ったエンジンと、作ったときの設定・合わせたスレッド数を記録する */
  function cacheHarness() {
    const h = {
      load: 'max' as AnalysisLoad,
      created: [] as { settings: EngineSettings; threads?: number; disposed: boolean }[],
      setThreads: [] as { threads: number | null; cap?: number }[],
    };
    const cache = createEngineCache({
      createEngine: async (settings, _load, _choice, threads) => {
        const record = { settings, threads, disposed: false };
        h.created.push(record);
        const engine: AnalysisEngine = {
          session: {
            setOption: () => {},
            analyze: async () => {
              throw new Error('unused');
            },
          },
          name: 'FakeEngine',
          threads: 4,
          hashMb: settings.hashMb,
          setThreads: async (next, cap) => {
            h.setThreads.push({ threads: next, cap });
          },
          dispose: () => {
            record.disposed = true;
          },
        };
        return engine;
      },
      currentLoad: () => h.load,
      log: { info: () => {}, warn: () => {} },
    });
    return { h, cache };
  }
  const FULL: EngineSettings = { maxThreads: 8, stageMaxThreads: 4, hashMb: 64 };

  it('キーが同じなら使い回し、段の上限・固定のスレッド数は作り直さずに合わせる', async () => {
    const { h, cache } = cacheHarness();
    const first = await cache.acquire(FULL, MINI);
    expect(await cache.acquire({ ...FULL, stageMaxThreads: 8 }, MINI, 2)).toBe(first);
    expect(h.created).toHaveLength(1);
    expect(h.setThreads).toEqual([
      { threads: null, cap: 4 },
      { threads: 2, cap: 8 },
    ]);
  });

  it('負荷・評価関数・大きさが変われば、前のエンジンを捨てて作り直す', async () => {
    const { h, cache } = cacheHarness();
    await cache.acquire(FULL, MINI);
    h.load = 'gentle';
    await cache.acquire(FULL, MINI);
    await cache.acquire(FULL, MICRO);
    await cache.acquire({ ...FULL, hashMb: 128 }, MICRO);
    expect(h.created).toHaveLength(4);
    expect(h.created.slice(0, 3).every((c) => c.disposed)).toBe(true);
  });

  it('🔒 followCurrentSizing: 今あるエンジンの大きさが違っても作り直さない（無ければ求めた大きさで作る）', async () => {
    const { h, cache } = cacheHarness();
    const study = { maxThreads: 4, stageMaxThreads: 4, hashMb: 16 };
    // まだ無ければ、求めた大きさで作る
    const first = await cache.acquire(study, MINI, undefined, { followCurrentSizing: true });
    expect(h.created.map((c) => c.settings)).toEqual([study]);
    // 全局面解析（大きさを合わせる側）は、大きさが違えば作り直す
    const full = await cache.acquire(FULL, MINI);
    expect(full).not.toBe(first);
    // 局面評価は今のエンジン（全局面解析の大きさ）をそのまま使う
    expect(await cache.acquire(study, MINI, undefined, { followCurrentSizing: true })).toBe(full);
    expect(h.created).toHaveLength(2);
    // 評価関数・負荷が違えば作り直す（大きさだけを見ない）
    await cache.acquire(study, MICRO, undefined, { followCurrentSizing: true });
    expect(h.created).toHaveLength(3);
  });

  it('止めた後は作らずに投げ、読み込み中に止められたエンジンは捨てる', async () => {
    const { h, cache } = cacheHarness();
    const loading = cache.acquire(FULL, MINI);
    cache.dispose();
    await expect(loading).rejects.toThrow(STOPPED_DETAIL);
    expect(h.created[0].disposed).toBe(true);
    await expect(cache.acquire(FULL, MINI)).rejects.toThrow(STOPPED_DETAIL);
    expect(h.created).toHaveLength(1);
    expect(cache.isDisposed()).toBe(true);
  });
});
