/**
 * 取り込みの純粋な部分（`convertKif` / `autoTitle`）。列の長さの切り詰めは `kifu-input.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { autoTitle, convertKif } from './kifu-queries.js';

const MOVES = ['手数----指手---------消費時間--', '   1 ７六歩(77)', '   2 ３四歩(33)'];

const kif = (header: string[], moves = MOVES) => [...header, ...moves, ''].join('\n');

const meta = (over: Partial<Parameters<typeof autoTitle>[0]> = {}): Parameters<typeof autoTitle>[0] => ({
  sente: null,
  gote: null,
  senteDan: null,
  goteDan: null,
  result: null,
  playedAt: null,
  sourceTz: 'JST',
  ...over,
});

describe('convertKif', () => {
  it('平手で読めた指し手は USI の列にする', () => {
    const { usiMoves, meta } = convertKif(kif(['手合割：平手', '先手：甲', '後手：乙']));
    expect(usiMoves).toEqual(['7g7f', '3c3d']);
    expect(meta).toMatchObject({ sente: '甲', gote: '乙' });
  });

  it('手合割が無ければ平手として扱う', () => {
    expect(convertKif(kif(['先手：甲', '後手：乙'])).usiMoves).toEqual(['7g7f', '3c3d']);
  });

  it('駒落ちは指し手を持たない（対局メタだけ取る）', () => {
    const { usiMoves, meta } = convertKif(kif(['手合割：香落ち', '先手：甲', '後手：乙']));
    expect(usiMoves).toBeNull();
    expect(meta.sente).toBe('甲');
  });

  it('指し手が無ければ null', () => {
    expect(convertKif(kif(['手合割：平手'], [])).usiMoves).toBeNull();
  });

  it('開始日時の時刻帯は指定があればそれで読む（auto は KIF から判定）', () => {
    const header = ['手合割：平手', '開始日時：2026/01/02 09:00:00'];
    const utc = convertKif(kif(header), 'UTC').meta;
    const jst = convertKif(kif(header), 'JST').meta;
    expect(utc.sourceTz).toBe('UTC');
    expect(jst.sourceTz).toBe('JST');
    expect(utc.playedAt?.toISOString()).toBe('2026-01-02T09:00:00.000Z');
    expect(jst.playedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('autoTitle', () => {
  it('対局者名があれば「先手 vs 後手」。片方だけなら欠けた側は ?', () => {
    expect(autoTitle(meta({ sente: '甲', gote: '乙' }))).toBe('甲 vs 乙');
    expect(autoTitle(meta({ sente: '甲' }))).toBe('甲 vs ?');
    expect(autoTitle(meta({ gote: '乙' }))).toBe('? vs 乙');
  });

  it('対局者名が無ければ対局日（UTC の日付）', () => {
    expect(autoTitle(meta({ playedAt: new Date('2026-03-04T12:00:00Z') }))).toBe('2026-03-04');
  });

  it('どちらも無ければ「無題」', () => {
    expect(autoTitle(meta())).toBe('無題');
  });
});
