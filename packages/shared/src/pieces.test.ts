import { describe, expect, it } from 'vitest';
import {
  BASE_PIECE_KINDS,
  canPromote,
  isHandPieceKind,
  PIECE_TOTALS,
  PROMOTE_MAP,
  UNPROMOTE_MAP,
  unpromoted,
  withPromotion,
  type PieceKind,
} from './pieces';

const ALL_KINDS: PieceKind[] = [
  'P', 'L', 'N', 'S', 'G', 'B', 'R', 'K', '+P', '+L', '+N', '+S', '+B', '+R',
];

describe('成りの対応', () => {
  it('成りと戻しが往復する', () => {
    for (const [base, promoted] of Object.entries(PROMOTE_MAP) as [PieceKind, PieceKind][]) {
      expect(UNPROMOTE_MAP[promoted]).toBe(base);
    }
  });

  it('成れるのは歩香桂銀角飛だけ', () => {
    expect(ALL_KINDS.filter(canPromote)).toEqual(['P', 'L', 'N', 'S', 'B', 'R']);
  });

  it('unpromoted は生駒を返す', () => {
    expect(ALL_KINDS.map(unpromoted)).toEqual([
      'P', 'L', 'N', 'S', 'G', 'B', 'R', 'K', 'P', 'L', 'N', 'S', 'B', 'R',
    ]);
  });

  it('withPromotion: 省略は元のまま・true で成る・false で生駒に戻す', () => {
    expect(withPromotion('+S')).toBe('+S');
    expect(withPromotion('S', true)).toBe('+S');
    expect(withPromotion('G', true)).toBe('G');
    expect(withPromotion('+R', false)).toBe('R');
  });
});

describe('駒の総数', () => {
  it('40 枚', () => {
    expect(BASE_PIECE_KINDS.reduce((n, k) => n + PIECE_TOTALS[k], 0)).toBe(40);
  });
});

describe('isHandPieceKind', () => {
  it('玉と成駒は持ち駒にならない', () => {
    expect(ALL_KINDS.filter(isHandPieceKind)).toEqual(['P', 'L', 'N', 'S', 'G', 'B', 'R']);
  });
});
