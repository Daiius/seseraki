import { describe, expect, it } from 'vitest';
import { megabytes } from './format';

describe('megabytes', () => {
  it('10MB 未満は小数 1 桁', () => {
    expect(megabytes(8_700_000)).toBe('8.7MB');
    expect(megabytes(0)).toBe('0.0MB');
    expect(megabytes(9_949_999)).toBe('9.9MB');
  });

  it('10MB 以上は整数に丸める', () => {
    expect(megabytes(10_000_000)).toBe('10MB');
    expect(megabytes(64_600_000)).toBe('65MB');
  });
});
