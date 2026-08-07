import { describe, expect, it } from 'vitest';
import {
  describeFilters,
  isFiltered,
  TACTIC_OPTIONS,
  tacticSideApplies,
} from './kifuListFilter';

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
    expect(isFiltered({ tactic: '四間飛車' })).toBe(true);
    expect(isFiltered({ missedMate: 10 })).toBe(true);
  });

  it('側の指定だけでは絞り込みにならない（戦型が無ければ効かない）', () => {
    expect(isFiltered({ tacticSide: 'opponent' })).toBe(false);
  });
});

describe('tacticSideApplies', () => {
  it('手番固有のラベルは自分 / 相手で絞れる', () => {
    expect(tacticSideApplies('四間飛車')).toBe(true);
    expect(tacticSideApplies('矢倉')).toBe(true);
  });

  it('角換わり・相掛かりは側で絞れない（prd/09 §6.1）', () => {
    expect(tacticSideApplies('角換わり')).toBe(false);
    expect(tacticSideApplies('相掛かり')).toBe(false);
  });

  it('未選択なら側の指定は意味を持たない', () => {
    expect(tacticSideApplies(undefined)).toBe(false);
  });
});

describe('TACTIC_OPTIONS', () => {
  it('shared の語彙から出す（保存されない役割ラベルは含まない）', () => {
    expect(TACTIC_OPTIONS).toContain('四間飛車');
    expect(TACTIC_OPTIONS).toContain('角換わり');
    expect(TACTIC_OPTIONS).not.toContain('角交換を挑んだ');
    expect(TACTIC_OPTIONS).not.toContain('角交換に応じた');
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

  it('戦型は側が意味を持つときだけ「自分 / 相手」を添える', () => {
    expect(describeFilters({ tactic: '四間飛車' })).toBe('四間飛車');
    expect(describeFilters({ tactic: '四間飛車', tacticSide: 'any' })).toBe('四間飛車');
    expect(describeFilters({ tactic: '四間飛車', tacticSide: 'opponent' })).toBe('相手: 四間飛車');
    expect(describeFilters({ tactic: '四間飛車', tacticSide: 'self' })).toBe('自分: 四間飛車');
    // 角換わり・相掛かりは server も side を見ないので、要約でも側を書かない
    expect(describeFilters({ tactic: '角換わり', tacticSide: 'self' })).toBe('角換わり');
    expect(describeFilters({ tactic: '相掛かり', tacticSide: 'opponent' })).toBe('相掛かり');
  });

  it('取りこぼしは手数付きで出す', () => {
    expect(describeFilters({ missedMate: 10 })).toBe('10手詰以下の取りこぼし');
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
