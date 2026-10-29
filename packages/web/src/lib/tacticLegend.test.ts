import { describe, expect, it } from 'vitest';
import type { TacticLabel } from 'shared';
import { legendModeOf, legendModesOf } from './tacticLegend';

const sided: TacticLabel[] = [{ side: 'sente', label: '四間飛車', turn: 20 }];
const neutralOnly: TacticLabel[] = [{ side: 'both', label: '相掛かり', turn: 10 }];

describe('legendModeOf', () => {
  it('手番固有のタグがあれば、主体側の有無で self / unresolved', () => {
    expect(legendModeOf(sided, 'sente')).toBe('self');
    expect(legendModeOf(sided, null)).toBe('unresolved');
  });

  it('中立のタグしか無ければ凡例の根拠にならない（null）', () => {
    expect(legendModeOf(neutralOnly, 'gote')).toBeNull();
    expect(legendModeOf([], null)).toBeNull();
  });
});

describe('legendModesOf', () => {
  it('ページに出ている分け方を合わせる（混在なら両方）', () => {
    expect(
      legendModesOf([
        { tactics: sided, userSide: 'gote' },
        { tactics: sided, userSide: null },
        { tactics: neutralOnly, userSide: null },
      ]),
    ).toEqual({ self: true, unresolved: true });
    expect(legendModesOf([{ tactics: neutralOnly, userSide: 'sente' }])).toEqual({
      self: false,
      unresolved: false,
    });
  });
});
