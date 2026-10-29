import { describe, expect, it } from 'vitest';
import { indexToUsi, isUsiMove, parseUsiMove, usiToIndex } from './usi-move';

describe('usiToIndex / indexToUsi', () => {
  it('筋は右から左・段は上から下（col 0 = 9 筋 / row 0 = 一段目）', () => {
    expect(usiToIndex('9a')).toEqual([0, 0]);
    expect(usiToIndex('1i')).toEqual([8, 8]);
    expect(usiToIndex('7g')).toEqual([6, 2]);
  });

  it('往復する', () => {
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        expect(usiToIndex(indexToUsi(row, col))).toEqual([row, col]);
      }
    }
  });
});

describe('isUsiMove', () => {
  it('移動・成り・打ちを受ける', () => {
    for (const m of ['7g7f', '8h2b+', 'P*5e', 'R*1a']) expect(isUsiMove(m)).toBe(true);
  });

  it('盤外の座標・特別な語・王の打ちを受けない', () => {
    for (const m of ['0a1a', '7g7j', 'P*0e', 'K*5e', '7g7f++', 'resign', 'win', '']) {
      expect(isUsiMove(m), m).toBe(false);
    }
  });
});

describe('parseUsiMove', () => {
  it('移動と成り', () => {
    expect(parseUsiMove('7g7f')).toEqual({
      type: 'move', from: { row: 6, col: 2 }, to: { row: 5, col: 2 }, promote: false,
    });
    expect(parseUsiMove('8h2b+')).toEqual({
      type: 'move', from: { row: 7, col: 1 }, to: { row: 1, col: 7 }, promote: true,
    });
  });

  it('打ち', () => {
    expect(parseUsiMove('B*5e')).toEqual({ type: 'drop', piece: 'B', to: { row: 4, col: 4 } });
  });

  it('書式に合わなければ null（isUsiMove と同じ範囲）', () => {
    for (const m of ['0a1a', '7g7j', 'P*0e', 'K*5e', '7g7f++', 'resign', '']) {
      expect(parseUsiMove(m), m).toBeNull();
    }
  });
});
