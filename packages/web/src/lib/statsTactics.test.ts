import { describe, expect, it } from 'vitest';
import {
  buildTacticTree,
  describeExcluded,
  formatRate,
  nearestPresentAncestor,
  PERIOD_PRESETS,
  periodRange,
  presetOf,
  rate,
  totalExcluded,
  type StatsTacticRow,
} from './statsTactics';

/** 表示に効かない列は既定で埋める（テストは階層と並びを見る） */
function row(label: string, games: number, wins = 0): StatsTacticRow {
  return {
    label,
    attribution: 'side',
    games,
    wins,
    senteGames: 0,
    senteWins: 0,
    goteGames: 0,
    goteWins: 0,
    analyzedLosses: 0,
    missedMateLosses: 0,
  };
}

/** 表示順を `深さ:ラベル` の配列で見る */
function shape(rows: ReturnType<typeof buildTacticTree>): string[] {
  return rows.map((r) => `${r.depth}:${r.label}`);
}

describe('rate / formatRate', () => {
  it('分母が 0 なら null（0% と区別する）', () => {
    expect(rate(0, 0)).toBeNull();
    expect(formatRate(rate(0, 0))).toBe('−');
  });

  it('率は小数第 1 位まで', () => {
    expect(formatRate(rate(2, 3))).toBe('66.7%');
    expect(formatRate(rate(0, 4))).toBe('0.0%');
    expect(formatRate(rate(4, 4))).toBe('100.0%');
  });
});

describe('nearestPresentAncestor', () => {
  it('直接の親が行にあればそれを返す', () => {
    expect(nearestPresentAncestor('石田流', new Set(['三間飛車', '振り飛車']))).toBe(
      '三間飛車',
    );
  });

  it('中間の親が無ければ存在する祖先まで繰り上げる', () => {
    expect(nearestPresentAncestor('石田流', new Set(['振り飛車']))).toBe('振り飛車');
  });

  it('祖先が 1 つも無ければ null（根に置く）', () => {
    expect(nearestPresentAncestor('石田流', new Set())).toBeNull();
    expect(nearestPresentAncestor('矢倉', new Set(['居飛車']))).toBeNull();
  });
});

describe('buildTacticTree', () => {
  it('IMPLIES で親子に組み、深さを付ける', () => {
    const tree = buildTacticTree([row('振り飛車', 10), row('三間飛車', 4), row('石田流', 2)]);
    expect(shape(tree)).toEqual(['0:振り飛車', '1:三間飛車', '2:石田流']);
  });

  it('中間のラベルが無ければ存在する祖先に繋ぐ（行を根に散らさない）', () => {
    const tree = buildTacticTree([row('振り飛車', 10), row('石田流', 2)]);
    expect(shape(tree)).toEqual(['0:振り飛車', '1:石田流']);
  });

  it('矢倉・角換わり・横歩取りは居飛車の下に来ない（IMPLIES は分類ではない）', () => {
    const tree = buildTacticTree([row('居飛車', 20), row('矢倉', 5), row('角換わり', 3)]);
    expect(shape(tree)).toEqual(['0:居飛車', '0:矢倉', '0:角換わり']);
  });

  it('既定は局数降順、同数はラベル昇順', () => {
    const tree = buildTacticTree([row('三間飛車', 3), row('中飛車', 3), row('四間飛車', 9)]);
    expect(shape(tree)).toEqual(['0:四間飛車', '0:三間飛車', '0:中飛車']);
  });

  it('並べ替えは階層内で効き、親子関係は崩れない', () => {
    const rows = [
      row('振り飛車', 10, 5), // 50%
      row('三間飛車', 4, 1), // 25%
      row('向かい飛車', 2, 2), // 100%
      row('矢倉', 6, 3), // 50%
    ];
    const tree = buildTacticTree(rows, 'winRate', 'desc');
    // 兄弟（振り飛車 50% と 矢倉 50%）は同率なのでラベル昇順、子は親の下に留まる
    expect(shape(tree)).toEqual(['0:振り飛車', '1:向かい飛車', '1:三間飛車', '0:矢倉']);
  });

  it('昇順にすると並びが反転する（親子は保つ）', () => {
    const tree = buildTacticTree(
      [row('振り飛車', 10), row('三間飛車', 4), row('向かい飛車', 6)],
      'games',
      'asc',
    );
    expect(shape(tree)).toEqual(['0:振り飛車', '1:三間飛車', '1:向かい飛車']);
  });

  it('空の入力は空を返す', () => {
    expect(buildTacticTree([])).toEqual([]);
  });

  it('行を落とさない（入力の件数と出力の件数が一致する）', () => {
    const rows = [row('石田流', 2), row('三間飛車', 4), row('振り飛車', 10), row('筋違い角', 1)];
    expect(buildTacticTree(rows)).toHaveLength(rows.length);
  });
});

describe('describeExcluded / totalExcluded', () => {
  it('0 件の理由は書かない', () => {
    expect(describeExcluded({ ambiguousSelf: 2, draw: 0, unknownResult: 1 })).toBe(
      '自分未確定 2・結果不明 1',
    );
  });

  it('何も除外されていなければ空文字', () => {
    const none = { ambiguousSelf: 0, draw: 0, unknownResult: 0 };
    expect(describeExcluded(none)).toBe('');
    expect(totalExcluded(none)).toBe(0);
  });

  it('合計は 3 つの内訳の和', () => {
    expect(totalExcluded({ ambiguousSelf: 2, draw: 3, unknownResult: 1 })).toBe(6);
  });
});

describe('periodRange / presetOf', () => {
  const today = new Date(2026, 7, 8); // 2026-08-08（ローカル日付）

  it('全期間は両端を持たない', () => {
    expect(periodRange('all', today)).toEqual({});
  });

  it('直近 1 年 / 3 ヶ月は下端だけを決める（上端は開けたまま）', () => {
    expect(periodRange('1y', today)).toEqual({ from: '2025-08-08' });
    expect(periodRange('3m', today)).toEqual({ from: '2026-05-08' });
  });

  it('月をまたいでも桁が崩れない', () => {
    expect(periodRange('3m', new Date(2026, 0, 5))).toEqual({ from: '2025-10-05' });
  });

  it('プリセットは往復する', () => {
    for (const preset of PERIOD_PRESETS) {
      expect(presetOf(periodRange(preset, today), today)).toBe(preset);
    }
  });

  it('プリセットに当たらない範囲は null（カスタム）', () => {
    expect(presetOf({ from: '2026-01-01', to: '2026-03-31' }, today)).toBeNull();
    // 下端が一致しても上端が閉じていればカスタム（条件が違うので）
    expect(presetOf({ from: '2025-08-08', to: '2026-08-08' }, today)).toBeNull();
  });
});
