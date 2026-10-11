import { describe, expect, it } from 'vitest';
import {
  drillRefOf,
  nextDrillSearch,
  pinnedSearch,
  solveDrillSearch,
  validateDrillsSearch,
  type DrillRef,
} from './drillSearch';

const REF: DrillRef = { kifuNo: 42, moveNumber: 36, kind: 'best' };

describe('validateDrillsSearch', () => {
  it('問題は 棋譜の番号・手数・種類 の 3 つで指す（prd/14 §4.4）', () => {
    const search = validateDrillsSearch({ kifu: '42', ply: '36', drillKind: 'best' });
    expect(drillRefOf(search)).toEqual(REF);
    // 初期局面（0）も出題局面になりうる
    expect(drillRefOf(validateDrillsSearch({ kifu: 1, ply: 0, drillKind: 'mate' }))).toEqual({
      kifuNo: 1,
      moveNumber: 0,
      kind: 'mate',
    });
  });

  it('3 つのどれかが欠けている・読めないなら、どれも載せない', () => {
    for (const raw of [
      { kifu: '42', ply: '36' },
      { kifu: '42', drillKind: 'best' },
      { ply: '36', drillKind: 'best' },
      { kifu: '0', ply: '36', drillKind: 'best' },
      { kifu: '1.5', ply: '36', drillKind: 'best' },
      { kifu: 'abc', ply: '36', drillKind: 'best' },
      { kifu: '42', ply: '-1', drillKind: 'best' },
      { kifu: '42', ply: '', drillKind: 'best' },
      { kifu: '42', ply: '36', drillKind: 'tsume' },
    ]) {
      const search = validateDrillsSearch(raw);
      expect({ raw, kifu: search.kifu, ply: search.ply, drillKind: search.drillKind }).toEqual({
        raw,
        kifu: undefined,
        ply: undefined,
        drillKind: undefined,
      });
    }
  });

  it('🔒 絞り込みの kind と問題の種類（drillKind）は別のパラメータ', () => {
    const search = validateDrillsSearch({ kind: 'mate', kifu: '42', ply: '36', drillKind: 'best' });
    expect(search.kind).toBe('mate');
    expect(search.drillKind).toBe('best');
  });

  it('旧形式の drill（出題の行の ID）は読まない', () => {
    expect(validateDrillsSearch({ drill: '12' })).not.toHaveProperty('drill');
  });

  it('未知の値は既定に戻す', () => {
    expect(validateDrillsSearch({ tab: 'solve', kind: 'tsume', page: '1' })).toEqual({
      tab: undefined,
      kind: undefined,
      kifu: undefined,
      ply: undefined,
      drillKind: undefined,
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
  it('解くタブで問題が無ければ、選んだ問題を載せる（種類の絞り込みは保つ）', () => {
    expect(pinnedSearch({ kind: 'best' }, REF)).toEqual({
      kind: 'best',
      kifu: 42,
      ply: 36,
      drillKind: 'best',
    });
    expect(pinnedSearch({}, REF)).toEqual({ kifu: 42, ply: 36, drillKind: 'best' });
  });

  it('既に問題があれば置き換えない（読み直しのたびに書き換えるとループする）', () => {
    const pinned = { kifu: 42, ply: 36, drillKind: 'best' } as const;
    expect(pinnedSearch(pinned, REF)).toBeNull();
    expect(pinnedSearch(pinned, { ...REF, kifuNo: 7 })).toBeNull();
  });

  it('置き換え先を読み直しても、もう置き換えない', () => {
    const pinned = pinnedSearch({ kind: 'mate' }, { ...REF, kind: 'mate' })!;
    expect(pinnedSearch(pinned, REF)).toBeNull();
  });

  it('一覧・履歴のタブでは置き換えない', () => {
    expect(pinnedSearch({ tab: 'list' }, REF)).toBeNull();
    expect(pinnedSearch({ tab: 'history' }, REF)).toBeNull();
  });
});

describe('nextDrillSearch', () => {
  it('問題を指す組だけを落とし、種類の絞り込みは保つ', () => {
    expect(nextDrillSearch({ kind: 'mate', kifu: 42, ply: 36, drillKind: 'mate' })).toEqual({
      kind: 'mate',
      kifu: undefined,
      ply: undefined,
      drillKind: undefined,
    });
  });
});

describe('solveDrillSearch', () => {
  it('一覧から開く行き先は、種類の絞り込みと問題を指す組', () => {
    expect(solveDrillSearch(undefined, REF)).toEqual({
      kind: undefined,
      kifu: 42,
      ply: 36,
      drillKind: 'best',
    });
  });
});
