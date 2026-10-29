import { describe, expect, it } from 'vitest';
import { engineKey, type EngineChoice } from './engineCache';

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
