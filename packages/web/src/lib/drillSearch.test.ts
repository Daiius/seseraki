import { describe, expect, it } from 'vitest';
import { nextDrillSearch, pinnedSearch, validateDrillsSearch } from './drillSearch';

describe('validateDrillsSearch', () => {
  it('drill は正の整数だけを受ける', () => {
    expect(validateDrillsSearch({ drill: '12' }).drill).toBe(12);
    expect(validateDrillsSearch({ drill: 12 }).drill).toBe(12);
    expect(validateDrillsSearch({ drill: '0' }).drill).toBeUndefined();
    expect(validateDrillsSearch({ drill: '-3' }).drill).toBeUndefined();
    expect(validateDrillsSearch({ drill: '1.5' }).drill).toBeUndefined();
    expect(validateDrillsSearch({ drill: 'abc' }).drill).toBeUndefined();
  });

  it('未知の値は既定に戻す', () => {
    expect(validateDrillsSearch({ tab: 'solve', kind: 'tsume', page: '1' })).toEqual({
      tab: undefined,
      kind: undefined,
      drill: undefined,
      page: undefined,
      solved: undefined,
      excluded: undefined,
      sortBy: undefined,
      verdict: undefined,
    });
  });

  it('許可値はそのまま通す', () => {
    const search = validateDrillsSearch({ tab: 'list', kind: 'mate', page: '3', solved: 'wrong' });
    expect(search).toMatchObject({ tab: 'list', kind: 'mate', page: 3, solved: 'wrong' });
  });
});

describe('pinnedSearch', () => {
  it('解くタブで drill が無ければ、選んだ問題を載せる（種類は保つ）', () => {
    expect(pinnedSearch({ kind: 'best' }, 7)).toEqual({ kind: 'best', drill: 7 });
    expect(pinnedSearch({}, 7)).toEqual({ drill: 7 });
  });

  it('既に drill があれば置き換えない（読み直しのたびに書き換えるとループする）', () => {
    expect(pinnedSearch({ drill: 7 }, 7)).toBeNull();
    expect(pinnedSearch({ drill: 7 }, 9)).toBeNull();
  });

  it('置き換え先を読み直しても、もう置き換えない', () => {
    const pinned = pinnedSearch({ kind: 'mate' }, 5)!;
    expect(pinnedSearch(pinned, 5)).toBeNull();
  });

  it('一覧・履歴のタブでは置き換えない', () => {
    expect(pinnedSearch({ tab: 'list' }, 7)).toBeNull();
    expect(pinnedSearch({ tab: 'history' }, 7)).toBeNull();
  });
});

describe('nextDrillSearch', () => {
  it('drill だけを落とし、種類は保つ', () => {
    expect(nextDrillSearch({ kind: 'mate', drill: 7 })).toEqual({ kind: 'mate', drill: undefined });
  });
});
