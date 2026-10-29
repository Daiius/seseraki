/**
 * `ms` だけ待つ。`signal` が中断されたら待たずに戻る（中断済みならすぐ戻る）。タイマーも聞き手も残さない。
 * 戻った後に呼び出し側が `signal.aborted` を見る（投げない）
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
