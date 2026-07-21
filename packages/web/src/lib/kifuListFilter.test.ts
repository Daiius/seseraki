import { describe, expect, it } from 'vitest';
import { describeFilters, isFiltered } from './kifuListFilter';

describe('isFiltered', () => {
  it('条件が無ければ false', () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ status: 'all', outcome: 'all' })).toBe(false);
  });

  it('並べ替えだけ変えても false（件数が変わらないため）', () => {
    expect(isFiltered({ sort: 'title', order: 'asc' })).toBe(false);
  });

  it('絞り込みが 1 つでもあれば true', () => {
    expect(isFiltered({ q: '藤井' })).toBe(true);
    expect(isFiltered({ status: 'analyzed' })).toBe(true);
    expect(isFiltered({ outcome: 'loss' })).toBe(true);
    expect(isFiltered({ from: '2026-01-01' })).toBe(true);
    expect(isFiltered({ to: '2026-03-31' })).toBe(true);
  });
});

describe('describeFilters', () => {
  it('条件が無ければ空文字（summary は「検索」だけになる）', () => {
    expect(describeFilters({})).toBe('');
    expect(describeFilters({ status: 'all', outcome: 'all', sort: 'playedAt', order: 'desc' })).toBe(
      '',
    );
  });

  it('検索語は引用符で囲む', () => {
    expect(describeFilters({ q: '藤井' })).toBe('"藤井"');
  });

  it('解析状態・勝敗を日本語のラベルにする', () => {
    expect(describeFilters({ status: 'analyzed' })).toBe('解析済み');
    expect(describeFilters({ status: 'unanalyzed' })).toBe('未解析');
    expect(describeFilters({ status: 'failed' })).toBe('解析失敗');
    expect(describeFilters({ outcome: 'win' })).toBe('勝ち');
    expect(describeFilters({ outcome: 'loss' })).toBe('負け');
  });

  it('期間は片側だけでも 〜 を残して開いている側を示す', () => {
    expect(describeFilters({ from: '2026-01-01', to: '2026-03-31' })).toBe('2026-01-01〜2026-03-31');
    expect(describeFilters({ from: '2026-01-01' })).toBe('2026-01-01〜');
    expect(describeFilters({ to: '2026-03-31' })).toBe('〜2026-03-31');
  });

  it('並べ替えは既定（対局日時の降順）から変わったときだけ添える', () => {
    expect(describeFilters({ sort: 'playedAt', order: 'desc' })).toBe('');
    expect(describeFilters({ sort: 'title', order: 'asc' })).toBe('並び: タイトル ↑');
    expect(describeFilters({ sort: 'createdAt' })).toBe('並び: 登録日時 ↓');
    expect(describeFilters({ order: 'asc' })).toBe('並び: 対局日時 ↑');
  });

  it('複数の条件は · で連結する', () => {
    expect(
      describeFilters({
        q: '藤井',
        status: 'analyzed',
        outcome: 'win',
        from: '2026-01-01',
        sort: 'title',
        order: 'asc',
      }),
    ).toBe('"藤井" · 解析済み · 勝ち · 2026-01-01〜 · 並び: タイトル ↑');
  });
});
