import { describe, expect, it } from 'vitest';
import {
  formatElapsed,
  formatUpdatedAgo,
  type AnalysisProgress,
} from './analysisProgress';

describe('formatElapsed', () => {
  it('1 分未満は秒', () => {
    expect(formatElapsed(0)).toBe('0秒前');
    expect(formatElapsed(59_999)).toBe('59秒前');
  });

  it('1 時間未満は分（端数は切り捨て）', () => {
    expect(formatElapsed(60_000)).toBe('1分前');
    expect(formatElapsed(90_000)).toBe('1分前');
    expect(formatElapsed(59 * 60_000)).toBe('59分前');
  });

  it('1 時間以上は時間 + 分', () => {
    expect(formatElapsed(60 * 60_000)).toBe('1時間0分前');
    expect(formatElapsed(95 * 60_000)).toBe('1時間35分前');
  });

  it('負の経過（時計のずれ）は 0 秒に丸める', () => {
    expect(formatElapsed(-5_000)).toBe('0秒前');
  });
});

describe('formatUpdatedAgo', () => {
  const progress = (updatedAt: string): AnalysisProgress => ({
    kifuId: 1,
    revision: 0,
    analyzed: 87,
    total: 154,
    updatedAt,
  });

  it('経過を「◯前に更新」にする', () => {
    const now = Date.parse('2026-07-21T12:03:00.000Z');
    expect(formatUpdatedAgo(progress('2026-07-21T12:00:00.000Z'), now)).toBe(
      '3分前に更新',
    );
  });

  it('updatedAt が読めなければ空文字', () => {
    expect(formatUpdatedAgo(progress('not a date'), Date.now())).toBe('');
  });
});
