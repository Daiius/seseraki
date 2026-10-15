import { describe, expect, it } from 'vitest';
import { isAnalysisPending } from './analysisPending';

describe('isAnalysisPending（完了は担当によらず full。prd/14 §5.7）', () => {
  it('full まで終わって完了。quick だけの棋譜はまだ待つ', () => {
    expect(isAnalysisPending({ analysisProfile: null, failed: false })).toBe(true);
    // ブラウザで解析するユーザーも quick の後に full を回すので、quick だけでは完了にしない
    expect(isAnalysisPending({ analysisProfile: 'quick', failed: false })).toBe(true);
    expect(isAnalysisPending({ analysisProfile: 'full', failed: false })).toBe(false);
  });

  it('失敗の記録がある棋譜は待たない', () => {
    expect(isAnalysisPending({ analysisProfile: null, failed: true })).toBe(false);
    expect(isAnalysisPending({ analysisProfile: 'quick', failed: true })).toBe(false);
  });
});
