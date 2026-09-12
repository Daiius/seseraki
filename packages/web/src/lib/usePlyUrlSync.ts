import { useEffect, useRef } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { createThrottle, minIntervalFor, type Throttled } from './historyThrottle';

/**
 * 盤の手数を棋譜詳細の URL（`?ply=`）へ追随させる（prd/05 §2.6）。
 *
 * - **`replace` で書く**。1 手ごとに履歴が積まれると「戻る」が手戻しに化け、
 *   画面を離れる手段が失われるため（決定・2026-09-11）。
 * - **throttle を通す**。`replaceState` はブラウザにレート制限があり、Safari は
 *   30 秒 100 回で `SecurityError` を投げたうえ**しばらく無効化する**
 *   （`historyThrottle.ts` に詳細）。◀ ▶ の連打・キー長押しは簡単に届く。
 * - **画面を離れるときは保留を吐き出す**（下記）。throttle の待ち時間中に離れると、
 *   最後の 1 手が URL に乗らないため。
 */
export function usePlyUrlSync(): (ply: number) => void {
  const navigate = useNavigate({ from: '/kifus/$id' });
  const router = useRouter();

  // navigate / router は再レンダリングで同一とは限らないので ref 越しに呼ぶ
  // （throttle 自体は 1 度だけ作る。作り直すと保留中の値と間隔が失われる）
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const routerRef = useRef(router);
  routerRef.current = router;

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

    /**
     * 保留中の手数を**今この瞬間の履歴エントリへ**書き込む。
     *
     * 🔴 **`throttled.flush()` だけでは足りない。** TanStack の history は
     * `replaceState` を**マイクロタスクに queue** し、同じ batch に `push` が
     * 混ざると **push に吸収される**（`next.isPush` が sticky）。つまり
     * リンクを踏んだ直後に flush しても、**遷移の push に飲まれて消える**。
     * `router.history.flush()` で**同期的に**書き出してから遷移させる。
     */
    const flushNow = () => {
      throttled.flush();
      routerRef.current.history.flush();
    };

    /**
     * ⚠ **SPA 遷移では `pagehide` も `visibilitychange` も発火しない**
     * （文書は unload されない。レビュー `OCL-C6CEB03E`）。リンクを踏む瞬間を
     * **capture フェーズ**で捉えて、まだ棋譜詳細が現在の履歴エントリである間に書き出す。
     *
     * 🔒 **盤の操作子（`<button>`）では発火しない**ようアンカーに限る——
     * ここで毎回 flush すると throttle が無意味になり、レート制限に逆戻りする。
     */
    const onAnchorActivate = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('a[href]')) flushNow();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // リンクはキーボードでも辿れる（Enter で activate）
      if (event.key === 'Enter') onAnchorActivate(event);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushNow();
    };

    document.addEventListener('click', onAnchorActivate, true);
    document.addEventListener('keydown', onKeyDown, true);
    // ⚠ `beforeunload` ではなく `pagehide` を使う（iOS Safari は
    // `beforeunload` が発火しないことがあり、bfcache とも相性が悪い）
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('click', onAnchorActivate, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibility);
      // アンマウント後に navigate すると**次の画面**の URL を書き換えてしまうので捨てる
      // （この時点では履歴エントリはもう移っている。だから離脱の検知は上の capture で行う）
      throttled.cancel();
    };
  }, []);

  return (ply: number) => throttleRef.current?.push(ply);
}
