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
    expect(parseThresholds('{"blunder":500,"dubious":"x","decided":-1}')).toEqual({
      blunder: 500,
      dubious: DEFAULT_THRESHOLDS.dubious,
      decided: DEFAULT_THRESHOLDS.decided,
    });
  });

  it('値ごとのフォールバックで疑問手 > 悪手 になっても正規化する', () => {
    // blunder だけ壊れると既定に戻り、生き残った dubious 900 が上回ってしまう
    expect(parseThresholds('{"blunder":"broken","dubious":900,"decided":1000}')).toEqual({
      blunder: DEFAULT_THRESHOLDS.blunder,
      dubious: DEFAULT_THRESHOLDS.blunder,
      decided: 1000,
    });
    // 保存値そのものが不整合な場合も同じ
    expect(parseThresholds('{"blunder":200,"dubious":400,"decided":1000}')).toEqual({
      blunder: 200,
      dubious: 200,
      decided: 1000,
    });
  });

  it('正規化した閾値では悪手が先に判定される', () => {
    const t = parseThresholds('{"blunder":"broken","dubious":900,"decided":1000}');
    const loss = { moveNumber: 0, bestCp: 0, loss: 700, approximate: false, mate: null };

    expect(labelOf(loss, t)).toBe('blunder');
    expect(t.dubious).toBeLessThanOrEqual(t.blunder);
  });
});

describe('applyThresholdInput', () => {
  const base = DEFAULT_THRESHOLDS;

  it('空欄は無視する（Number("") の 0 を保存しない）', () => {
    // 値を消して打ち直す操作で「決着 0 ＝全局面が決着扱い」になってしまうため
    expect(applyThresholdInput(base, 'decided', '')).toBeNull();
    expect(applyThresholdInput(base, 'decided', '   ')).toBeNull();
    expect(applyThresholdInput(base, 'blunder', '')).toBeNull();
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
      decided: 3000,
    });
    // 疑問手を上回ったままなら動かさない
    expect(applyThresholdInput(base, 'blunder', '400')).toEqual({
      blunder: 400,
      dubious: 300,
      decided: 3000,
    });
  });

  it('疑問手を上げると悪手が追従する', () => {
    expect(applyThresholdInput(base, 'dubious', '900')).toEqual({
      blunder: 900,
      dubious: 900,
      decided: 3000,
    });
  });

  it('決着は他の閾値に影響しない', () => {
    expect(applyThresholdInput(base, 'decided', '2000')).toEqual({
      blunder: 600,
      dubious: 300,
      decided: 2000,
    });
  });
});
