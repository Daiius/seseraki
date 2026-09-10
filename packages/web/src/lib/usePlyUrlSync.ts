import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { createThrottle, minIntervalFor, type Throttled } from './historyThrottle';

/**
 * 盤の手数を棋譜詳細の URL（`?ply=`）へ追随させる（prd/05 §2.6）。
 *
 * - **`replace` で書く**。1 手ごとに履歴が積まれると「戻る」が手戻しに化け、
 *   画面を離れる手段が失われるため（決定・2026-09-11）。
 * - **throttle を通す**。`replaceState` はブラウザにレート制限があり、Safari は
 *   30 秒 100 回で `SecurityError` を投げたうえ**しばらく無効化する**
 *   （`historyThrottle.ts` に詳細）。◀ ▶ の連打・キー長押しは簡単に届く。
 * - **画面を離れるときは保留を吐き出す**（`pagehide` / 非表示化）。
 *   throttle の待ち時間中に離脱すると、最後の 1 手が URL に乗らないため。
 */
export function usePlyUrlSync(): (ply: number) => void {
  const navigate = useNavigate({ from: '/kifus/$id' });

  // navigate は再レンダリングで同一とは限らないので、throttle からは ref 越しに呼ぶ
  // （throttle 自体は 1 度だけ作る。作り直すと保留中の値と間隔が失われる）
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const throttleRef = useRef<Throttled<number> | null>(null);
  if (throttleRef.current === null) {
    throttleRef.current = createThrottle<number>(
      (ply) => {
        void navigateRef.current({
          search: (prev: Record<string, unknown>) => ({ ...prev, ply }),
          replace: true,
          // 盤はすでにその局面を描いている。URL を合わせるだけなので画面は動かさない
          resetScroll: false,
        });
      },
      minIntervalFor(typeof navigator === 'undefined' ? undefined : navigator),
    );
  }

  useEffect(() => {
    const throttled = throttleRef.current;
    if (!throttled) return;

    const flush = () => throttled.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    // ⚠ `beforeunload` ではなく `pagehide` を使う（iOS Safari は
    // `beforeunload` が発火しないことがあり、bfcache とも相性が悪い）
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      // アンマウント後に navigate すると別画面の URL を書き換えてしまうので捨てる
      throttled.cancel();
    };
  }, []);

  return (ply: number) => throttleRef.current?.push(ply);
}
