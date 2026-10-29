/**
 * URL の検索パラメータ（TanStack Router の `validateSearch` が受ける `unknown`）を読む小さな部品。
 *
 * 🔒 **読めない値は捨てる**（`undefined`。URL 直入力の未知の値で画面を壊さず、既定に戻す）。
 * 各ルートの解釈（`kifuListFilter.ts` の `validateKifuListSearch`・`drillSearch.ts` の `validateDrillsSearch` など）が組み合わせて使う。
 */

/**
 * 許可値のどれかなら返し、そうでなければ `undefined`。
 * `fallback` を渡すと、既定値と同じ値も `undefined` にする（既定値は URL に載せない）
 */
export function option<T extends string>(
  values: readonly T[],
  raw: unknown,
  fallback?: T,
): T | undefined {
  const value = values.find((v) => v === raw);
  return value === fallback ? undefined : value;
}

/** 整数で `min` 以上の値だけを受ける */
export function intParam(raw: unknown, min: number): number | undefined {
  // ⚠ 空文字・null は `Number` で 0 になるので先に落とす
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min ? value : undefined;
}

/** ページ番号。2 以上の整数だけを受ける（1 は既定なので URL に載せない） */
export function pageParam(raw: unknown): number | undefined {
  return intParam(raw, 2);
}

/** `<input type="date">` が返す `YYYY-MM-DD` だけを受ける */
export function dateParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}
