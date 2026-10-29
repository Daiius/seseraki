import { describe, expect, it } from 'vitest';
import { dateParam, intParam, option, pageParam } from './searchParams';

const COLORS = ['red', 'green', 'blue'] as const;

describe('option', () => {
  it('許可値ならそのまま、そうでなければ undefined', () => {
    expect(option(COLORS, 'green')).toBe('green');
    expect(option(COLORS, 'pink')).toBeUndefined();
    expect(option(COLORS, 1)).toBeUndefined();
    expect(option(COLORS, undefined)).toBeUndefined();
  });

  it('fallback を渡すと既定値も undefined にする（URL に載せない）', () => {
    expect(option(COLORS, 'red', 'red')).toBeUndefined();
    expect(option(COLORS, 'blue', 'red')).toBe('blue');
    expect(option(COLORS, 'pink', 'red')).toBeUndefined();
  });
});

describe('intParam', () => {
  it('min 以上の整数だけを受ける（文字列でもよい）', () => {
    expect(intParam('3', 1)).toBe(3);
    expect(intParam(0, 0)).toBe(0);
    expect(intParam('0', 1)).toBeUndefined();
    expect(intParam('1.5', 0)).toBeUndefined();
    expect(intParam('abc', 0)).toBeUndefined();
  });

  it('空文字・null・undefined は 0 にせず落とす', () => {
    expect(intParam('', 0)).toBeUndefined();
    expect(intParam(null, 0)).toBeUndefined();
    expect(intParam(undefined, 0)).toBeUndefined();
  });
});

describe('pageParam', () => {
  it('2 以上の整数だけ（1 は既定なので落とす）', () => {
    expect(pageParam('2')).toBe(2);
    expect(pageParam(1)).toBeUndefined();
    expect(pageParam('-3')).toBeUndefined();
    expect(pageParam('2.5')).toBeUndefined();
  });
});

describe('dateParam', () => {
  it('YYYY-MM-DD だけを受ける', () => {
    expect(dateParam('2026-01-31')).toBe('2026-01-31');
    expect(dateParam('2026-1-31')).toBeUndefined();
    expect(dateParam('2026-01-31T00:00')).toBeUndefined();
    expect(dateParam(20260131)).toBeUndefined();
  });
});
