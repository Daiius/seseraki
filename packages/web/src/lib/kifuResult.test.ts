import { describe, expect, it } from 'vitest';
import { subjectOutcomeOf, winnerOf } from './kifuResult';

describe('winnerOf', () => {
  it('勝った側を結果コードの頭から読む', () => {
    expect(winnerOf('SENTE_WIN_CHECKMATE')).toBe('sente');
    expect(winnerOf('GOTE_WIN_TIMEOUT')).toBe('gote');
  });

  it('引き分けは draw', () => {
    expect(winnerOf('DRAW_REPETITION')).toBe('draw');
    expect(winnerOf('DRAW_IMPASSE')).toBe('draw');
  });

  it('無い・読めない結果は null', () => {
    expect(winnerOf(null)).toBeNull();
    expect(winnerOf(undefined)).toBeNull();
    expect(winnerOf('')).toBeNull();
    expect(winnerOf('UNKNOWN')).toBeNull();
  });
});

describe('subjectOutcomeOf', () => {
  it('主体側が勝った側なら win、そうでなければ loss', () => {
    expect(subjectOutcomeOf('SENTE_WIN_RESIGN', 'sente')).toBe('win');
    expect(subjectOutcomeOf('SENTE_WIN_RESIGN', 'gote')).toBe('loss');
    expect(subjectOutcomeOf('GOTE_WIN_CHECKMATE', 'gote')).toBe('win');
    expect(subjectOutcomeOf('GOTE_WIN_CHECKMATE', 'sente')).toBe('loss');
  });

  it('引き分け・結果不明は none', () => {
    expect(subjectOutcomeOf('DRAW_REPETITION', 'sente')).toBe('none');
    expect(subjectOutcomeOf(null, 'gote')).toBe('none');
  });

  it('主体側が決まっていなければ null（バッジを出さない）', () => {
    expect(subjectOutcomeOf('SENTE_WIN_RESIGN', null)).toBeNull();
  });
});
