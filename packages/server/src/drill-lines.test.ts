import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLine, recallLine, rememberLine, resetLines } from './drill-lines';

describe('drill-lines（詰みの指し継ぎで覚える手順。prd/13 §5.2）', () => {
  beforeEach(() => {
    resetLines();
    vi.useRealTimers();
  });

  it('覚えた手順を引ける。上書きは新しい方が勝つ', () => {
    rememberLine(1, ['G*5b', '5a6a']);
    expect(recallLine(1)).toEqual(['G*5b', '5a6a']);
    rememberLine(1, ['G*5b', '5a4a']);
    expect(recallLine(1)).toEqual(['G*5b', '5a4a']);
  });

  it('覚えていない問題は null（呼び出し側は answerPv に戻る）', () => {
    expect(recallLine(999)).toBeNull();
  });

  it('解き終えたら忘れる', () => {
    rememberLine(2, ['G*5b']);
    forgetLine(2);
    expect(recallLine(2)).toBeNull();
  });

  it('時間が経てば消える（メモリだけの置き場。もう一度聞き直せばよい）', () => {
    vi.useFakeTimers();
    rememberLine(3, ['G*5b']);
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(recallLine(3)).toBeNull();
  });

  it('上限を超えたら古い順に捨てる', () => {
    for (let id = 1; id <= 60; id++) rememberLine(id, [`m${id}`]);
    expect(recallLine(1)).toBeNull();
    expect(recallLine(60)).toEqual(['m60']);
  });
});
