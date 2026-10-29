import { describe, expect, it } from 'vitest';
import { KIFU_PLAYER_MAX, KIFU_TITLE_MAX, truncateChars } from './kifu-input.js';
import { autoTitle, convertKif } from './kifu-queries.js';
import { idParam, positiveInt4 } from './params.js';

describe('truncateChars', () => {
  it('上限以下はそのまま・null は null', () => {
    expect(truncateChars('abc', 3)).toBe('abc');
    expect(truncateChars(null, 3)).toBeNull();
  });

  it('上限を超えたら先頭から max 文字に切る', () => {
    expect(truncateChars('abcdef', 4)).toBe('abcd');
    expect(truncateChars('あいうえお', 2)).toBe('あい');
  });

  it('サロゲートペアは 1 文字として数え、途中で切らない', () => {
    const s = '𠮷'.repeat(5); // UTF-16 では 10 単位・コードポイントでは 5 文字
    expect(truncateChars(s, 5)).toBe(s);
    expect(truncateChars(s, 3)).toBe('𠮷𠮷𠮷');
  });
});

const kif = (sente: string, gote: string) =>
  ['手合割：平手', `先手：${sente}`, `後手：${gote}`, '手数----指手---------消費時間--', '   1 ７六歩(77)', ''].join(
    '\n',
  );

describe('convertKif・autoTitle は列の長さに収める', () => {
  it('長すぎる対局者名は varchar(100) に切り詰める', () => {
    const { meta, usiMoves } = convertKif(kif('a'.repeat(300), 'b'.repeat(101)));
    expect(meta.sente).toBe('a'.repeat(KIFU_PLAYER_MAX));
    expect(meta.gote).toBe('b'.repeat(KIFU_PLAYER_MAX));
    expect(usiMoves).toEqual(['7g7f']);
  });

  it('普通の長さの名前はそのまま', () => {
    const { meta } = convertKif(kif('先手さん', '後手さん'));
    expect(meta.sente).toBe('先手さん');
    expect(autoTitle(meta)).toBe('先手さん vs 後手さん');
  });

  it('自動の題名は varchar(255) を超えない', () => {
    const meta = {
      sente: 'a'.repeat(200),
      gote: 'b'.repeat(200),
      senteDan: null,
      goteDan: null,
      result: null,
      playedAt: null,
      sourceTz: 'JST',
    };
    expect(Array.from(autoTitle(meta))).toHaveLength(KIFU_TITLE_MAX);
  });
});

describe('positiveInt4・idParam', () => {
  it('正の int4 だけを通す', () => {
    expect(idParam.parse({ id: '12' })).toEqual({ id: 12 });
    expect(positiveInt4.parse('2147483647')).toBe(2_147_483_647);
  });

  it.each(['abc', '1.5', '0', '-1', '2147483648', 'NaN', ''])('%s は通さない', (v) => {
    expect(idParam.safeParse({ id: v }).success).toBe(false);
  });
});
