import { describe, expect, it } from 'vitest';
import { kifuDrillsState } from './kifuDrills';

describe('kifuDrillsState（棋譜詳細の「問題 N」。prd/13 §7.10）', () => {
  it('問題があれば解析の状態によらず押せる（再解析の最中も）', () => {
    expect(kifuDrillsState({ drillCount: 3, analysisProfile: 'full', failed: false })).toEqual({ enabled: true });
    expect(kifuDrillsState({ drillCount: 3, analysisProfile: 'quick', failed: false })).toEqual({ enabled: true });
    expect(kifuDrillsState({ drillCount: 3, analysisProfile: null, failed: true })).toEqual({ enabled: true });
  });

  it('0 問なら、解析中・失敗・できなかった、で理由を分ける', () => {
    expect(kifuDrillsState({ drillCount: 0, analysisProfile: 'quick', failed: false })).toEqual({
      enabled: false,
      reason: '解析が終わると問題ができます',
    });
    expect(kifuDrillsState({ drillCount: 0, analysisProfile: null, failed: true })).toEqual({
      enabled: false,
      reason: '解析が終わらなかったため、問題はありません',
    });
    expect(kifuDrillsState({ drillCount: 0, analysisProfile: 'full', failed: false })).toEqual({
      enabled: false,
      reason: 'この対局から問題はできませんでした',
    });
  });
});
