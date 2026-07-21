/**
 * 悪手判定の閾値の永続化（prd/05-analysis.md §2.5）。
 *
 * 閾値は棋譜ごとではなく恒常的な好みなので **localStorage** に持つ（URL クエリにも server にも
 * 置かない）。CPL 自体は閾値に依存しないため、変更しても解析のやり直しは要らない。
 */

import { useState } from 'react';
import { DEFAULT_THRESHOLDS, type Thresholds } from './cpl';

const STORAGE_KEY = 'seseraki:thresholds';

function toPositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/**
 * localStorage の生の文字列を閾値に変換する。
 * 手で書き換えられていても壊れないよう、値ごとに既定へフォールバックする。
 */
export function parseThresholds(raw: string | null): Thresholds {
  if (!raw) return DEFAULT_THRESHOLDS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_THRESHOLDS;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_THRESHOLDS;
  const v = parsed as Partial<Record<keyof Thresholds, unknown>>;
  return {
    blunder: toPositive(v.blunder, DEFAULT_THRESHOLDS.blunder),
    dubious: toPositive(v.dubious, DEFAULT_THRESHOLDS.dubious),
    decided: toPositive(v.decided, DEFAULT_THRESHOLDS.decided),
  };
}

function loadThresholds(): Thresholds {
  try {
    return parseThresholds(localStorage.getItem(STORAGE_KEY));
  } catch {
    // localStorage が使えない環境（プライベートモード等）でも判定は既定値で動かす
    return DEFAULT_THRESHOLDS;
  }
}

function saveThresholds(thresholds: Thresholds): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(thresholds));
  } catch {
    // 保存できなくてもセッション中の変更は効かせる
  }
}

export function useThresholds() {
  const [thresholds, setState] = useState<Thresholds>(loadThresholds);
  const setThresholds = (next: Thresholds) => {
    setState(next);
    saveThresholds(next);
  };
  return { thresholds, setThresholds };
}
