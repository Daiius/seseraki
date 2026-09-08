import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRILL_SCORING,
  applyMarginInput,
  parseDrillScoring,
} from './drillScoring';

describe('parseDrillScoring', () => {
  it('未設定・壊れた値は既定へフォールバックする', () => {
    expect(parseDrillScoring(null)).toEqual(DEFAULT_DRILL_SCORING);
    expect(parseDrillScoring('{')).toEqual(DEFAULT_DRILL_SCORING);
    expect(parseDrillScoring('[1,2]')).toEqual(DEFAULT_DRILL_SCORING);
  });

  it('値ごとに既定へ落とす', () => {
    expect(parseDrillScoring('{"correctMargin":50,"closeMargin":"x"}')).toEqual({
      correctMargin: 50,
      closeMargin: 300,
    });
  });

  it('correctMargin <= closeMargin に正規化する（惜しいが消えない）', () => {
    expect(parseDrillScoring('{"correctMargin":400,"closeMargin":200}')).toEqual({
      correctMargin: 400,
      closeMargin: 400,
    });
  });
});

describe('applyMarginInput', () => {
  const base = DEFAULT_DRILL_SCORING;

  it('空欄・非数値・範囲外は無視する（0 を保存しない）', () => {
    expect(applyMarginInput(base, 'correctMargin', '')).toBeNull();
    expect(applyMarginInput(base, 'correctMargin', 'abc')).toBeNull();
    expect(applyMarginInput(base, 'correctMargin', '-1')).toBeNull();
    expect(applyMarginInput(base, 'closeMargin', '99999')).toBeNull();
  });

  it('片方を動かしたらもう片方が追従する', () => {
    expect(applyMarginInput(base, 'correctMargin', '500')).toEqual({
      correctMargin: 500,
      closeMargin: 500,
    });
    expect(applyMarginInput(base, 'closeMargin', '50')).toEqual({
      correctMargin: 50,
      closeMargin: 50,
    });
  });

  it('0 は指定できる（「完全一致だけ正解」）', () => {
    expect(applyMarginInput(base, 'correctMargin', '0')).toEqual({
      correctMargin: 0,
      closeMargin: 300,
    });
  });
});
