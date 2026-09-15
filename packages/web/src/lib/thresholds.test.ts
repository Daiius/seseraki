import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, labelOf } from 'shared';
import { applyThresholdInput, parseThresholds } from './thresholds';

describe('parseThresholds', () => {
  it('未設定・壊れた値は既定へフォールバックする', () => {
    expect(parseThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds('{')).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds('[1,2]')).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds('"300"')).toEqual(DEFAULT_THRESHOLDS);
  });

  it('値ごとにフォールバックする', () => {
    expect(parseThresholds('{"blunder":500,"dubious":"x"}')).toEqual({
      blunder: 500,
      dubious: DEFAULT_THRESHOLDS.dubious,
    });
  });

  it('旧版が保存した決着閾値（decided）は読み捨てる', () => {
    // 2026-09-16 に判定ごと削除した。残った値で壊れず、結果にも持ち込まない
    expect(parseThresholds('{"blunder":500,"dubious":200,"decided":3000}')).toEqual({
      blunder: 500,
      dubious: 200,
    });
    expect(parseThresholds('{"blunder":500,"dubious":200,"decided":"x"}')).toEqual({
      blunder: 500,
      dubious: 200,
    });
  });

  it('値ごとのフォールバックで疑問手 > 悪手 になっても正規化する', () => {
    // blunder だけ壊れると既定に戻り、生き残った dubious 900 が上回ってしまう
    expect(parseThresholds('{"blunder":"broken","dubious":900}')).toEqual({
      blunder: DEFAULT_THRESHOLDS.blunder,
      dubious: DEFAULT_THRESHOLDS.blunder,
    });
    // 保存値そのものが不整合な場合も同じ
    expect(parseThresholds('{"blunder":200,"dubious":400}')).toEqual({
      blunder: 200,
      dubious: 200,
    });
  });

  it('正規化した閾値では悪手が先に判定される', () => {
    const t = parseThresholds('{"blunder":"broken","dubious":900}');
    const loss = { moveNumber: 0, loss: 700, approximate: false, mate: null };

    expect(labelOf(loss, t)).toBe('blunder');
    expect(t.dubious).toBeLessThanOrEqual(t.blunder);
  });
});

describe('applyThresholdInput', () => {
  const base = DEFAULT_THRESHOLDS;

  it('空欄は無視する（Number("") の 0 を保存しない）', () => {
    // 値を消して打ち直す操作で「悪手 0 ＝全ての手が悪手」になってしまうため
    expect(applyThresholdInput(base, 'blunder', '')).toBeNull();
    expect(applyThresholdInput(base, 'blunder', '   ')).toBeNull();
    expect(applyThresholdInput(base, 'dubious', '')).toBeNull();
  });

  it('数値でない・負の入力は無視する', () => {
    expect(applyThresholdInput(base, 'blunder', 'abc')).toBeNull();
    expect(applyThresholdInput(base, 'blunder', '-1')).toBeNull();
  });

  it('悪手を下げると疑問手が追従する', () => {
    expect(applyThresholdInput(base, 'blunder', '100')).toEqual({
      blunder: 100,
      dubious: 100,
    });
    // 疑問手を上回ったままなら動かさない
    expect(applyThresholdInput(base, 'blunder', '400')).toEqual({
      blunder: 400,
      dubious: 300,
    });
  });

  it('疑問手を上げると悪手が追従する', () => {
    expect(applyThresholdInput(base, 'dubious', '900')).toEqual({
      blunder: 900,
      dubious: 900,
    });
  });
});
