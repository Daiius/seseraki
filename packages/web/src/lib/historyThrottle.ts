/**
 * `history.replaceState` のレート制限を避けるための throttle（prd/05 §2.6）。
 *
 * 🔴 **ブラウザは `pushState` / `replaceState` の連打を止める。**
 * - **Safari は 30 秒で 100 回**を超えると `SecurityError` を **throw する**
 *   （`Attempt to use history.replaceState() more than 100 times per 30 seconds`）。
 *   ⚠ **catch しても解決にならない**——制限に当たったブラウザは**しばらく
 *   `replaceState` 自体を無効化する**ので、例外を握っても URL は更新されなくなる。
 * - **Firefox は例外を投げずに無視する**（コンソールに
 *   `Too many calls to Location or History APIs within a short timeframe`）。
 *   閾値はバージョンで動いているので**数字を当てにしない**。
 * - **Chrome は緩い。Chrome だけで開発していると気づけない。**
 *
 * 対策は「呼ぶ回数を減らす」ことに尽きる。ここでは **leading + trailing の throttle**
 * （最初の 1 回は即座に、以後は間隔ぶん待って**最後の値だけ**）を用意する。
 * 手を 1 手進めたら URL がすぐ追いつき、連打・キー長押しの途中は書かない。
 */

/**
 * Safari の下限間隔。**30 秒 / 100 回 = 平均 300ms** なので、それを少し上回る値にする。
 * ⚠ **150ms 程度では足りない**（その間隔で押し続けると 30 秒で 200 回に達する）。
 */
export const SAFARI_MIN_INTERVAL_MS = 310;

/** Safari 以外の下限間隔。連打を潰せればよいので短くてよい */
export const DEFAULT_MIN_INTERVAL_MS = 52;

/**
 * Safari（WebKit）かを判定する。
 *
 * ⚠ **Chrome / Edge の UA にも `Safari` が入る**ので、それだけでは判定できない。
 * `vendor` が `Apple Computer, Inc.` なのは Safari だけなので、そちらを主に見る
 * （iOS の Chrome も WebKit で同じ制限を受けるため、巻き込んで構わない）。
 */
export function isSafari(nav: { vendor?: string; userAgent?: string }): boolean {
  if (nav.vendor === 'Apple Computer, Inc.') return true;
  const ua = nav.userAgent ?? '';
  return /Safari/i.test(ua) && !/Chrom(e|ium)|Edg|Android/i.test(ua);
}

/** 実行環境に合う下限間隔を返す（`navigator` が無い環境では既定値） */
export function minIntervalFor(nav?: { vendor?: string; userAgent?: string }): number {
  if (!nav) return DEFAULT_MIN_INTERVAL_MS;
  return isSafari(nav) ? SAFARI_MIN_INTERVAL_MS : DEFAULT_MIN_INTERVAL_MS;
}

export interface Throttled<T> {
  /** 値を流し込む。間隔内なら**最後の値だけ**が後で適用される */
  push: (value: T) => void;
  /** 保留中の値を今すぐ適用する（画面を離れるときなど） */
  flush: () => void;
  /** 保留中の値を捨てる（アンマウント時） */
  cancel: () => void;
}

/**
 * leading + trailing の throttle を作る。
 *
 * - 前回の適用から `intervalMs` 以上空いていれば**即座に適用**する（1 手進めたら URL もすぐ動く）
 * - 間隔内に来た値は**保留し、最後の 1 つだけ**を間隔明けに適用する（連打・キー長押しを潰す）
 * - **同じ値は適用しない**。`ply` は同じ局面へ何度も来るので、これだけでも呼び出しが減る
 *
 * `now` / `schedule` を差し替えられるのはテストのため（実時間を待たずに検証する）。
 */
export function createThrottle<T>(
  apply: (value: T) => void,
  intervalMs: number,
  clock: {
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => unknown;
    cancelScheduled?: (handle: unknown) => void;
  } = {},
): Throttled<T> {
  const now = clock.now ?? (() => Date.now());
  const schedule = clock.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelScheduled =
    clock.cancelScheduled ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let lastAppliedAt = Number.NEGATIVE_INFINITY;
  /** 直近で適用した値。同じ値の再適用を弾く */
  let lastValue: { value: T } | null = null;
  let pending: { value: T } | null = null;
  let timer: unknown = null;

  const applyNow = (value: T) => {
    lastAppliedAt = now();
    lastValue = { value };
    pending = null;
    apply(value);
  };

  const onTimer = () => {
    timer = null;
    if (pending) applyNow(pending.value);
  };

  return {
    push: (value) => {
      const isApplied = lastValue !== null && Object.is(lastValue.value, value);
      // すでに適用済みの値に戻ってきたら、保留を捨てて何もしない（連打で行って戻った場合）
      if (isApplied) {
        pending = null;
        if (timer !== null) {
          cancelScheduled(timer);
          timer = null;
        }
        return;
      }
      // 同じ値がすでに待っているなら積み直さない
      if (pending && Object.is(pending.value, value)) return;

      const elapsed = now() - lastAppliedAt;
      if (elapsed >= intervalMs) {
        if (timer !== null) {
          cancelScheduled(timer);
          timer = null;
        }
        applyNow(value);
        return;
      }
      pending = { value };
      if (timer === null) timer = schedule(onTimer, intervalMs - elapsed);
    },
    flush: () => {
      if (timer !== null) {
        cancelScheduled(timer);
        timer = null;
      }
      if (pending) applyNow(pending.value);
    },
    cancel: () => {
      if (timer !== null) {
        cancelScheduled(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
