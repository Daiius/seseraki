import { describe, expect, it } from 'vitest';
import { isAnalysisPending } from './analysisPending';

describe('isAnalysisPending（完了の線は担当で変わる。prd/14 §5.7）', () => {
  it('サーバーで解析: full まで終わって完了。quick だけの棋譜はまだ待つ', () => {
    expect(
      isAnalysisPending({ analysisProfile: null, failed: false }, 'worker'),
    ).toBe(true);
    expect(
      isAnalysisPending({ analysisProfile: 'quick', failed: false }, 'worker'),
    ).toBe(true);
    expect(
      isAnalysisPending({ analysisProfile: 'full', failed: false }, 'worker'),
    ).toBe(false);
  });

  it('ブラウザで解析: quick の完了で完了（full を待ち続けない）', () => {
    expect(
      isAnalysisPending({ analysisProfile: null, failed: false }, 'browser'),
    ).toBe(true);
    expect(
      isAnalysisPending({ analysisProfile: 'quick', failed: false }, 'browser'),
    ).toBe(false);
    // 担当を切り替える前に手元 worker が full まで終えた棋譜
    expect(
      isAnalysisPending({ analysisProfile: 'full', failed: false }, 'browser'),
    ).toBe(false);
  });

  it('失敗の記録がある棋譜は、どちらの担当でも待たない', () => {
    expect(
      isAnalysisPending({ analysisProfile: null, failed: true }, 'worker'),
    ).toBe(false);
    expect(
      isAnalysisPending({ analysisProfile: 'quick', failed: true }, 'worker'),
    ).toBe(false);
    expect(
      isAnalysisPending({ analysisProfile: null, failed: true }, 'browser'),
    ).toBe(false);
  });
});
