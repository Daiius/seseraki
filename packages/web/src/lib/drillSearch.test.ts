import { describe, expect, it } from 'vitest';
import {
  drillRefOf,
  drillScreenOf,
  listSearch,
  modeSearch,
  pinnedSearch,
  solveFromListSearch,
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

  it('🔒 一覧の kind と問題の種類（drillKind）は別のパラメータ', () => {
    const search = validateDrillsSearch({ kind: 'mate', kifu: '42', ply: '36', drillKind: 'best' });
    expect(search.kind).toBe('mate');
    expect(search.drillKind).toBe('best');
  });

  it('旧形式（drill・tab・sortBy・verdict・excluded）は読まない', () => {
    const search = validateDrillsSearch({
      drill: '12',
      tab: 'list',
      sortBy: 'status',
      verdict: 'wrong',
      excluded: 'only',
    });
    expect(search).toEqual({
      mode: undefined,
      view: undefined,
      kind: undefined,
      solved: undefined,
      page: undefined,
      kifu: undefined,
      ply: undefined,
      drillKind: undefined,
    });
    // 旧形式の tab=list はホームになる（prd/13 §7.8）
    expect(drillScreenOf(search)).toBe('home');
  });

  it('許可値はそのまま通し、未知の値は落とす', () => {
    expect(
      validateDrillsSearch({ view: 'list', kind: 'mate', page: '3', solved: 'excluded' }),
    ).toMatchObject({ view: 'list', kind: 'mate', page: 3, solved: 'excluded' });
    expect(validateDrillsSearch({ mode: 'wrong' }).mode).toBe('wrong');
    expect(validateDrillsSearch({ mode: 'all', view: 'history', page: '1' })).toMatchObject({
      mode: undefined,
      view: undefined,
      page: undefined,
    });
  });
});

describe('drillScreenOf（prd/13 §7.8）', () => {
  it('何も無ければホーム・view=list は一覧・入口は解く画面', () => {
    expect(drillScreenOf({})).toBe('home');
    expect(drillScreenOf({ view: 'list' })).toBe('list');
    expect(drillScreenOf({ mode: 'recommend' })).toBe('solve');
  });

  it('問題の指定は view より優先（一覧から名指しで開いた問題）', () => {
    expect(drillScreenOf({ view: 'list', kifu: 42, ply: 36, drillKind: 'best' })).toBe('solve');
    expect(drillScreenOf({ kifu: 42, ply: 36, drillKind: 'best' })).toBe('solve');
  });
});

describe('pinnedSearch', () => {
  it('入口で問題が無ければ、選んだ問題を載せる', () => {
    expect(pinnedSearch({ mode: 'mate' }, REF)).toEqual({
      mode: 'mate',
      kifu: 42,
      ply: 36,
      drillKind: 'best',
    });
  });

  it('既に問題があれば置き換えない（読み直しのたびに書き換えるとループする）', () => {
    const pinned = { mode: 'recommend', kifu: 42, ply: 36, drillKind: 'best' } as const;
    expect(pinnedSearch(pinned, REF)).toBeNull();
    expect(pinnedSearch(pinned, { ...REF, kifuNo: 7 })).toBeNull();
  });

  it('置き換え先を読み直しても、もう置き換えない', () => {
    const pinned = pinnedSearch({ mode: 'wrong' }, REF)!;
    expect(pinnedSearch(pinned, REF)).toBeNull();
  });

  it('入口が無い（ホーム・一覧）では置き換えない', () => {
    expect(pinnedSearch({}, REF)).toBeNull();
    expect(pinnedSearch({ view: 'list' }, REF)).toBeNull();
  });
});

describe('行き先', () => {
  it('入口の次の問題は、入口だけを持つ（問題の指定・一覧のつまみは落とす）', () => {
    expect(modeSearch('best')).toEqual({ mode: 'best' });
  });

  it('一覧から開く問題は、一覧の絞り込みとページを持ったまま開き、同じ一覧へ戻れる', () => {
    const list = { view: 'list', kind: 'mate', solved: 'wrong', page: 2 } as const;
    const solve = solveFromListSearch(list, REF);
    expect(solve).toEqual({ ...list, kifu: 42, ply: 36, drillKind: 'best' });
    expect(drillScreenOf(solve)).toBe('solve');
    expect(listSearch(solve)).toEqual(list);
  });
});
