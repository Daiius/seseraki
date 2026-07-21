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
 *
 * ⚠ **値ごとのフォールバックは `dubious > blunder` を作りうる**（片方だけ壊れた保存値で、
 * 生き残った値と既定値が組み合わさる）。この状態だと `labelOf` が悪手を先に判定するため
 * 疑問手が一切出なくなり、設定画面にも矛盾した値が並ぶ。UI の変更処理と同じく
 * **`dubious <= blunder` に正規化**して不整合な状態をロード直後にも作らせない。
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
  const blunder = toPositive(v.blunder, DEFAULT_THRESHOLDS.blunder);
  return {
    blunder,
    dubious: Math.min(toPositive(v.dubious, DEFAULT_THRESHOLDS.dubious), blunder),
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

/**
 * 入力欄の生の文字列を閾値に反映する。反映しない入力では **null** を返す。
 *
 * - **空欄は無視する。** `Number('')` は 0 になるため素直に変換すると、値を消して打ち直すだけの操作が
 *   「閾値 0 の保存」になる（決着 0 なら全局面が決着扱いでラベルが消える）。
 * - 数値でない・負値も無視する。
 * - **`dubious <= blunder` を保つ**ため、片方を動かしたらもう片方を追従させる
 *   （疑問手 > 悪手 だと `labelOf` が悪手を先に判定し、疑問手が一切出なくなる）。
 */
export function applyThresholdInput(
  thresholds: Thresholds,
  field: keyof Thresholds,
  raw: string,
): Thresholds | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;

  switch (field) {
    case 'blunder':
      return { ...thresholds, blunder: value, dubious: Math.min(thresholds.dubious, value) };
    case 'dubious':
      return { ...thresholds, dubious: value, blunder: Math.max(thresholds.blunder, value) };
    case 'decided':
      return { ...thresholds, decided: value };
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
