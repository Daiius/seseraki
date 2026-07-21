import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearProgress,
  getClearToken,
  getProgress,
  resetProgress,
  setProgress,
} from './analysis-progress.js';

describe('analysis-progress', () => {
  beforeEach(() => {
    resetProgress();
  });

  it('初期状態は null', () => {
    expect(getProgress()).toBeNull();
  });

  it('setProgress で進捗が入り updatedAt が打たれる', () => {
    expect(
      setProgress(
        { kifuId: 1, revision: 0, analyzed: 3, total: 71 },
        getClearToken(),
      ),
    ).toBe(true);
    const progress = getProgress();
    expect(progress).toMatchObject({
      kifuId: 1,
      revision: 0,
      analyzed: 3,
      total: 71,
    });
    expect(Number.isNaN(Date.parse(progress!.updatedAt))).toBe(false);
  });

  it('後の報告で上書きされる（worker は 1 件ずつ処理するので高々 1 件）', () => {
    setProgress({ kifuId: 1, revision: 0, analyzed: 3, total: 71 }, getClearToken());
    setProgress({ kifuId: 2, revision: 5, analyzed: 1, total: 40 }, getClearToken());
    expect(getProgress()).toMatchObject({ kifuId: 2, revision: 5, analyzed: 1 });
  });

  it('clearProgress は同じ kifuId のときだけ消す', () => {
    setProgress({ kifuId: 1, revision: 0, analyzed: 3, total: 71 }, getClearToken());
    clearProgress(2);
    expect(getProgress()).not.toBeNull();
    clearProgress(1);
    expect(getProgress()).toBeNull();
  });

  it('エントリが無いときの clearProgress は何もしない', () => {
    clearProgress(1);
    expect(getProgress()).toBeNull();
  });

  describe('clear トークンによる compare-and-set', () => {
    it('報告の DB 検証中に submit が完了した場合、進捗は復活しない', () => {
      setProgress({ kifuId: 1, revision: 0, analyzed: 113, total: 115 }, getClearToken());
      // 最終局面の報告が DB を読み始める（この時点のトークンを持つ）
      const token = getClearToken();
      // その await の間に submit が完了して clear まで走る
      clearProgress(1);
      // 古い判定のまま書き込もうとしても弾かれる
      expect(
        setProgress({ kifuId: 1, revision: 0, analyzed: 115, total: 115 }, token),
      ).toBe(false);
      expect(getProgress()).toBeNull();
    });

    it('エントリがまだ無いうちに clear されても弾く（トークンは常に進む）', () => {
      const token = getClearToken();
      clearProgress(1);
      expect(
        setProgress({ kifuId: 1, revision: 0, analyzed: 1, total: 115 }, token),
      ).toBe(false);
      expect(getProgress()).toBeNull();
    });

    it('clear の後に取り直したトークンでは記録できる（次の局面の報告で復活する）', () => {
      clearProgress(1);
      expect(
        setProgress({ kifuId: 2, revision: 0, analyzed: 1, total: 40 }, getClearToken()),
      ).toBe(true);
      expect(getProgress()).toMatchObject({ kifuId: 2, analyzed: 1 });
    });
  });
});
