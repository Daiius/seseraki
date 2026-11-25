import { describe, expect, it } from 'vitest';
import { dailyGrid, dailyLabel, dailyLevel, todayCorrectOf, weekdayMonFirst, type DailyCount } from './drillDaily';

/** `end`（今日）までの `n` 日。正解の数は日の通し番号 */
function daysUntil(end: string, n: number): DailyCount[] {
  const last = new Date(`${end}T00:00:00Z`).getTime();
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(last - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    correct: i,
  }));
}

describe('日ごとの正解の数（prd/13 §7.11）', () => {
  it('今日は並びの最後・未取得は null', () => {
    expect(todayCorrectOf(null)).toBeNull();
    expect(todayCorrectOf([])).toBeNull();
    expect(todayCorrectOf(daysUntil('2026-11-25', 3))).toBe(2);
  });

  it('曜日は暦日で読む（月 = 0）', () => {
    expect(weekdayMonFirst('2026-11-23')).toBe(0); // 月
    expect(weekdayMonFirst('2026-11-25')).toBe(2); // 水
    expect(weekdayMonFirst('2026-11-29')).toBe(6); // 日
  });

  it('マスは 1 行 1 週（月〜日）で、最後の行が今週・今日より後は空', () => {
    // 2026-11-25 は水曜
    const grid = dailyGrid(daysUntil('2026-11-25', 28));
    expect(grid).toHaveLength(4);
    expect(grid.every((row) => row.length === 7)).toBe(true);
    expect(grid[0][0]?.date).toBe('2026-11-02'); // 3 週前の月曜
    expect(grid[3][2]?.date).toBe('2026-11-25');
    expect(grid[3].slice(3)).toEqual([null, null, null, null]);
  });

  it('日曜が今日なら最後の行が埋まり、足りない古い日は空', () => {
    const grid = dailyGrid(daysUntil('2026-11-29', 3));
    expect(grid[3].map((c) => c?.date ?? null)).toEqual([null, null, null, null, '2026-11-27', '2026-11-28', '2026-11-29']);
    expect(grid[0].every((c) => c === null)).toBe(true);
  });

  it('濃さと日付の表記', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(dailyLevel)).toEqual([0, 1, 1, 2, 2, 3, 3]);
    expect(dailyLabel('2026-11-25')).toBe('11/25（水）');
  });
});
