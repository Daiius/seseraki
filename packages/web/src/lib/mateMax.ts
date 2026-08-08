/**
 * 取りこぼしと見なす詰み手数の上限 `N` の永続化（prd/09 §3.1・§5）。
 *
 * 恒常的な好みなので閾値（`lib/thresholds.ts`）と同じく **localStorage** に持つ。
 * ⚠ **`/stats` では URL の `mateMax` が優先**（URL が「いま見ている条件」、これは「既定値」）。
 * URL に載せるのは、`N` を変えると server に問い直しが要る＝ページの状態そのものだから
 * （prd/09 §6.3 の「web 側で集計する案」を落とした理由と同じ）。
 */

import { useState } from 'react';

/** 既定 10（prd/09 §3.1）。深い詰みは解析 depth の範囲外で検出漏れの方向にノイズが出る */
export const DEFAULT_MATE_MAX = 10;

/** server の zod（`mateMax: 1〜99 の整数`）と揃える。上限は桁数の暴走を止めるだけの数 */
export const MIN_MATE_MAX = 1;
export const MAX_MATE_MAX = 99;

const STORAGE_KEY = 'seseraki:mateMax';

/** 範囲内の整数だけを受ける。手で書き換えられていても壊れないよう既定へ落とす */
export function parseMateMax(raw: string | null): number {
  if (raw === null) return DEFAULT_MATE_MAX;
  const value = Number(raw);
  return isValidMateMax(value) ? value : DEFAULT_MATE_MAX;
}

export function isValidMateMax(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MATE_MAX &&
    value <= MAX_MATE_MAX
  );
}

/** 保存された既定値。`/stats` の loader は URL に `mateMax` が無いときこれを使う */
export function loadMateMax(): number {
  try {
    return parseMateMax(localStorage.getItem(STORAGE_KEY));
  } catch {
    // localStorage が使えない環境（プライベートモード等）でも既定値で動かす
    return DEFAULT_MATE_MAX;
  }
}

function saveMateMax(value: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // 保存できなくてもセッション中の変更は効かせる
  }
}

export function useMateMax() {
  const [mateMax, setState] = useState<number>(loadMateMax);
  const setMateMax = (next: number) => {
    if (!isValidMateMax(next)) return;
    setState(next);
    saveMateMax(next);
  };
  return { mateMax, setMateMax };
}
