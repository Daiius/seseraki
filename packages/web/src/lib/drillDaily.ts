import { useEffect, useSyncExternalStore } from 'react';
import { client } from './honoClient';
import { callApi } from './callApi';

/*
  日ごとの正解の数（prd/13 §7.11）。解く画面の上部とホームの「今日 N 問正解」、ホームの直近 4 週間のマス。
  - 日の区切りはブラウザの時刻帯の 0 時（server に `tz` を渡す）
  - 数えるのは正解を記録した問題だけ（不正解・惜しい・諦めは数えない。server が数える）
  - 🔒 記録の正典は server の解答履歴。ここはその写しで、解答を記録したら引き直す
*/

export type DailyCount = { date: string; correct: number };

/** 引く日数。ホームのマス（4 週間）がこれで足りる */
export const DAILY_DAYS = 28;

/** ブラウザの時刻帯（IANA）。取れない環境では UTC */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 今日（並びの最後）の正解の数。未取得なら null */
export function todayCorrectOf(days: DailyCount[] | null): number | null {
  if (!days || days.length === 0) return null;
  return days[days.length - 1].correct;
}

/** その日の曜日（月 = 0 … 日 = 6）。日付は時刻帯の暦日なので UTC として読む */
export function weekdayMonFirst(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * ホームのマス: 1 行 1 週（月〜日）・最後の行が今週で、今日より後は null。
 * 今週を含めて `weeks` 週ぶん。古い日が足りない分も null で埋める
 */
export function dailyGrid(days: DailyCount[], weeks = 4): (DailyCount | null)[][] {
  if (days.length === 0) return [];
  const today = days[days.length - 1];
  const todayIndex = weekdayMonFirst(today.date);
  const cells = weeks * 7;
  // 先頭は (weeks - 1) 週前の月曜。並びの最後（今日）が cells の中の位置 (cells - 7 + todayIndex) に来る
  const lastPos = cells - 7 + todayIndex;
  const grid: (DailyCount | null)[] = Array.from({ length: cells }, () => null);
  for (let i = 0; i < days.length; i++) {
    const pos = lastPos - (days.length - 1 - i);
    if (pos >= 0) grid[pos] = days[i];
  }
  return Array.from({ length: weeks }, (_, w) => grid.slice(w * 7, w * 7 + 7));
}

/** マスの濃さ（0〜3） */
export function dailyLevel(correct: number): 0 | 1 | 2 | 3 {
  if (correct <= 0) return 0;
  if (correct <= 2) return 1;
  if (correct <= 4) return 2;
  return 3;
}

/** 「11/24（月）」 */
export function dailyLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}/${d}（${'月火水木金土日'[weekdayMonFirst(date)]}）`;
}

// --- 写しの入れ物（`useSyncExternalStore`）---

type DailyState = { days: DailyCount[] | null; error: string | null };

let state: DailyState = { days: null, error: null };
const listeners = new Set<() => void>();
/** 引き直しの通し番号（古い応答で新しい値を上書きしない） */
let seq = 0;

function set(next: DailyState) {
  state = next;
  for (const listener of listeners) listener();
}

/** 引き直す（画面を開いたとき・解答を記録したとき） */
export async function refreshDaily(): Promise<void> {
  const mine = ++seq;
  const result = await callApi(
    client.api.drills.daily.$get({ query: { tz: browserTimeZone(), days: DAILY_DAYS } }),
  );
  if (mine !== seq) return;
  if (result.ok) set({ days: result.data.days, error: null });
  // 取れなかったときは前の値を残す（数が消えるより、少し古い方がよい）
  else set({ days: state.days, error: result.error });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 日ごとの正解の数。使う画面を開いたら引き直す */
export function useDrillDaily(): DailyState {
  useEffect(() => {
    void refreshDaily();
  }, []);
  return useSyncExternalStore(subscribe, () => state);
}
