/**
 * 出題の採点の線引きの永続化（prd/13 §5.1）。
 *
 * 恒常的な好みなので、閾値（`lib/thresholds.ts`）や詰み手数（`lib/mateMax.ts`）と同じく
 * **localStorage** に持ち、解答のたびに server へ渡す。
 *
 * 🔴 **`cpl.ts` の閾値を流用しない。** 疑問手閾値（既定 300）を正解の線にすると
 * **正解がいくつもある局面ができる**。出題は「実質的に正解が 1 つ」に寄せたい（prd/13 §5.1）。
 * ⚠ **抽出の閾値（server の `DRILL_BLUNDER_CP`）とも別**——あちらは「どの局面を問題にするか」。
 */

import { useState } from 'react';

/** 既定 100cp。「実質的に正解が 1 つ」に寄せる値（prd/13 §5.1） */
export const DEFAULT_CORRECT_MARGIN = 100;
/** 「惜しい」の上限。既定は疑問手閾値と同じ 300cp */
export const DEFAULT_CLOSE_MARGIN = 300;

export const MIN_MARGIN = 0;
/** server の zod（0〜10000）と揃える */
export const MAX_MARGIN = 10000;

const STORAGE_KEY = 'seseraki:drillScoring';

export interface DrillScoring {
  correctMargin: number;
  closeMargin: number;
}

export const DEFAULT_DRILL_SCORING: DrillScoring = {
  correctMargin: DEFAULT_CORRECT_MARGIN,
  closeMargin: DEFAULT_CLOSE_MARGIN,
};

export function isValidMargin(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MARGIN &&
    value <= MAX_MARGIN
  );
}

/**
 * 保存値を読む。手で書き換えられていても壊れないよう、値ごとに既定へ落とす。
 *
 * ⚠ **`correctMargin <= closeMargin` に正規化する**（`thresholds.ts` と同じ流儀）。
 * 逆転していると「正解」の範囲が「惜しい」を飲み込み、惜しいが一切出なくなる。
 */
export function parseDrillScoring(raw: string | null): DrillScoring {
  if (!raw) return DEFAULT_DRILL_SCORING;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_DRILL_SCORING;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_DRILL_SCORING;
  const v = parsed as Partial<Record<keyof DrillScoring, unknown>>;
  const correctMargin = isValidMargin(v.correctMargin)
    ? v.correctMargin
    : DEFAULT_CORRECT_MARGIN;
  const closeMargin = isValidMargin(v.closeMargin) ? v.closeMargin : DEFAULT_CLOSE_MARGIN;
  return { correctMargin, closeMargin: Math.max(correctMargin, closeMargin) };
}

/** 入力欄の生の文字列を反映する。反映しない入力では **null**（`thresholds.ts` と同じ規則） */
export function applyMarginInput(
  scoring: DrillScoring,
  field: keyof DrillScoring,
  raw: string,
): DrillScoring | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!isValidMargin(value)) return null;
  return field === 'correctMargin'
    ? { correctMargin: value, closeMargin: Math.max(scoring.closeMargin, value) }
    : { correctMargin: Math.min(scoring.correctMargin, value), closeMargin: value };
}

function load(): DrillScoring {
  try {
    return parseDrillScoring(localStorage.getItem(STORAGE_KEY));
  } catch {
    // localStorage が使えない環境（プライベートモード等）でも既定値で動かす
    return DEFAULT_DRILL_SCORING;
  }
}

function save(scoring: DrillScoring): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scoring));
  } catch {
    // 保存できなくてもセッション中の変更は効かせる
  }
}

export function useDrillScoring() {
  const [scoring, setState] = useState<DrillScoring>(load);
  const setScoring = (next: DrillScoring) => {
    setState(next);
    save(next);
  };
  return { scoring, setScoring };
}
