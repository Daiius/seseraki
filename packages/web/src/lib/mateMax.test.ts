import { describe, expect, it } from 'vitest';
import { DEFAULT_MATE_MAX, isValidMateMax, parseMateMax } from './mateMax';

describe('parseMateMax', () => {
  it('未保存なら既定値', () => {
    expect(parseMateMax(null)).toBe(DEFAULT_MATE_MAX);
  });

  it('範囲内の整数だけを受ける', () => {
    expect(parseMateMax('1')).toBe(1);
    expect(parseMateMax('7')).toBe(7);
    expect(parseMateMax('99')).toBe(99);
  });

  it('手で壊された値は既定値に落とす', () => {
    // 0 手詰は存在せず、負値・小数・範囲外・非数は server の zod も弾く
    for (const raw of ['0', '-3', '3.5', '100', 'ten', '', '{}']) {
      expect(parseMateMax(raw)).toBe(DEFAULT_MATE_MAX);
    }
  });
});

describe('isValidMateMax', () => {
  it('整数以外・範囲外を弾く', () => {
    expect(isValidMateMax(10)).toBe(true);
    expect(isValidMateMax(0)).toBe(false);
    expect(isValidMateMax(100)).toBe(false);
    expect(isValidMateMax(3.5)).toBe(false);
    expect(isValidMateMax('10')).toBe(false);
    expect(isValidMateMax(NaN)).toBe(false);
  });
});
