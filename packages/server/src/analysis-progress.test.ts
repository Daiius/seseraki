import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearProgress,
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
    setProgress({ kifuId: 1, revision: 0, analyzed: 3, total: 71 });
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
    setProgress({ kifuId: 1, revision: 0, analyzed: 3, total: 71 });
    setProgress({ kifuId: 2, revision: 5, analyzed: 1, total: 40 });
    expect(getProgress()).toMatchObject({ kifuId: 2, revision: 5, analyzed: 1 });
  });

  it('clearProgress は同じ kifuId のときだけ消す', () => {
    setProgress({ kifuId: 1, revision: 0, analyzed: 3, total: 71 });
    clearProgress(2);
    expect(getProgress()).not.toBeNull();
    clearProgress(1);
    expect(getProgress()).toBeNull();
  });

  it('エントリが無いときの clearProgress は何もしない', () => {
    clearProgress(1);
    expect(getProgress()).toBeNull();
  });
});
