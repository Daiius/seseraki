import { describe, expect, it } from 'vitest';
import {
  BROWSER_ANALYSIS_LIMITS,
  browserAnalysisChunkSchema,
  browserAnalysisErrorSchema,
  browserAnalysisStartSchema,
  browserCandidateSchema,
  isPvToken,
} from './analysis-limits';

const candidate = (override: Record<string, unknown> = {}) => ({
  rank: 1,
  move: '7g7f',
  scoreType: 'cp',
  scoreValue: 30,
  depth: 12,
  pv: ['7g7f', '3c3d'],
  ...override,
});

const chunk = (override: Record<string, unknown> = {}) => ({
  revision: 0,
  engineBuild: 'c1b80eaa-0123456789ab',
  evalHash: 'a'.repeat(64),
  engineName: 'YaneuraOu',
  fvScale: 16,
  threads: 4,
  hashMb: 64,
  movetimeMs: 300,
  analyses: [{ moveNumber: 0, candidates: [candidate()] }],
  ...override,
});

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('isPvToken（読み筋の語）', () => {
  it('USI の指し手（移動・成り・打ち）を通す', () => {
    for (const move of ['7g7f', '8h2b+', 'P*5e', 'R*1a']) expect(isPvToken(move)).toBe(true);
  });

  it('指し手ではない語（resign / win / rep_*）を通す', () => {
    for (const token of ['resign', 'win', 'rep_draw', 'rep_win', 'rep_lose', 'rep_sup', 'rep_inf']) {
      expect(isPvToken(token)).toBe(true);
    }
  });

  it('それ以外は通さない', () => {
    for (const token of ['', '0g7f', '7g7j', 'K*5e', '7g7f++', 'rep_x', 'RESIGN', '7g7f 3c3d', '<script>']) {
      expect(isPvToken(token)).toBe(false);
    }
  });
});

describe('browserCandidateSchema（候補手）', () => {
  it('🔴 詰まされた局面の `resign` を通す（詰みの分類が pv[0] を読む）', () => {
    expect(ok(browserCandidateSchema, candidate({ move: 'resign', scoreType: 'mate', scoreValue: 0, pv: ['resign'] }))).toBe(true);
  });

  it('`move` は空文字も通す（読み筋が空の局面）。pv は省略できる', () => {
    expect(ok(browserCandidateSchema, candidate({ move: '', pv: [] }))).toBe(true);
    expect(ok(browserCandidateSchema, candidate({ pv: undefined }))).toBe(true);
  });

  it('rank は 1 だけ（MultiPV 1）', () => {
    expect(ok(browserCandidateSchema, candidate({ rank: 2 }))).toBe(false);
  });

  it('読み筋は上限の長さまで', () => {
    const pv = (n: number) => Array.from({ length: n }, () => '7g7f');
    expect(ok(browserCandidateSchema, candidate({ pv: pv(BROWSER_ANALYSIS_LIMITS.pvMaxPlies) }))).toBe(true);
    expect(ok(browserCandidateSchema, candidate({ pv: pv(BROWSER_ANALYSIS_LIMITS.pvMaxPlies + 1) }))).toBe(false);
  });

  it('形の違う指し手・読み筋を弾く', () => {
    expect(ok(browserCandidateSchema, candidate({ move: 'hello' }))).toBe(false);
    expect(ok(browserCandidateSchema, candidate({ pv: ['7g7f', 'x'] }))).toBe(false);
  });

  it('評価値は整数で上限まで、深さは 0..255', () => {
    expect(ok(browserCandidateSchema, candidate({ scoreValue: -BROWSER_ANALYSIS_LIMITS.maxScoreAbs }))).toBe(true);
    expect(ok(browserCandidateSchema, candidate({ scoreValue: BROWSER_ANALYSIS_LIMITS.maxScoreAbs + 1 }))).toBe(false);
    expect(ok(browserCandidateSchema, candidate({ scoreValue: 1.5 }))).toBe(false);
    expect(ok(browserCandidateSchema, candidate({ depth: 0 }))).toBe(true);
    expect(ok(browserCandidateSchema, candidate({ depth: 256 }))).toBe(false);
    expect(ok(browserCandidateSchema, candidate({ depth: -1 }))).toBe(false);
    expect(ok(browserCandidateSchema, candidate({ scoreType: 'win' }))).toBe(false);
  });
});

describe('browserAnalysisChunkSchema（チャンクの報告）', () => {
  const positions = (n: number) =>
    Array.from({ length: n }, (_, moveNumber) => ({ moveNumber, candidates: [candidate()] }));

  it('通る形', () => {
    expect(ok(browserAnalysisChunkSchema, chunk())).toBe(true);
    expect(ok(browserAnalysisChunkSchema, chunk({ engineName: undefined }))).toBe(true);
  });

  it('段（profile）は任意の申告（無い＝段を載せない今の web も通る）。quick / full 以外は 400', () => {
    expect(ok(browserAnalysisChunkSchema, chunk({ profile: 'quick' }))).toBe(true);
    expect(ok(browserAnalysisChunkSchema, chunk({ profile: 'full' }))).toBe(true);
    expect(ok(browserAnalysisChunkSchema, chunk({ profile: 'deep' }))).toBe(false);
  });

  it('1 チャンクの局面数は 1 以上・上限まで', () => {
    expect(ok(browserAnalysisChunkSchema, chunk({ analyses: positions(BROWSER_ANALYSIS_LIMITS.chunkMaxPositions) }))).toBe(true);
    expect(ok(browserAnalysisChunkSchema, chunk({ analyses: positions(BROWSER_ANALYSIS_LIMITS.chunkMaxPositions + 1) }))).toBe(false);
    expect(ok(browserAnalysisChunkSchema, chunk({ analyses: [] }))).toBe(false);
  });

  it('候補手は 1 本まで（0 本は通す）', () => {
    expect(ok(browserAnalysisChunkSchema, chunk({ analyses: [{ moveNumber: 0, candidates: [] }] }))).toBe(true);
    expect(
      ok(browserAnalysisChunkSchema, chunk({ analyses: [{ moveNumber: 0, candidates: [candidate(), candidate()] }] })),
    ).toBe(false);
  });

  it('来歴の形を見る（ビルド識別・評価関数のハッシュ・数値の範囲）', () => {
    expect(ok(browserAnalysisChunkSchema, chunk({ engineBuild: 'not a build id' }))).toBe(false);
    expect(ok(browserAnalysisChunkSchema, chunk({ evalHash: 'abc' }))).toBe(false);
    expect(ok(browserAnalysisChunkSchema, chunk({ threads: 0 }))).toBe(false);
    expect(ok(browserAnalysisChunkSchema, chunk({ fvScale: 1.5 }))).toBe(false);
    expect(ok(browserAnalysisChunkSchema, chunk({ movetimeMs: 0 }))).toBe(false);
    expect(ok(browserAnalysisChunkSchema, chunk({ revision: -1 }))).toBe(false);
  });

  it('上限いっぱいのチャンクが本文の上限に収まる', () => {
    const pv = Array.from({ length: BROWSER_ANALYSIS_LIMITS.pvMaxPlies }, () => '7g7f+');
    const body = JSON.stringify(
      chunk({
        analyses: Array.from({ length: BROWSER_ANALYSIS_LIMITS.chunkMaxPositions }, (_, moveNumber) => ({
          moveNumber: BROWSER_ANALYSIS_LIMITS.maxMoveNumber - moveNumber,
          candidates: [candidate({ scoreValue: -BROWSER_ANALYSIS_LIMITS.maxScoreAbs, pv })],
        })),
      }),
    );
    expect(body.length).toBeLessThan(BROWSER_ANALYSIS_LIMITS.bodyMaxBytes);
  });
});

describe('開始・失敗の本文', () => {
  it('開始はビルド識別と評価関数のハッシュ', () => {
    expect(ok(browserAnalysisStartSchema, { engineBuild: 'c1b80eaa-0123456789ab', evalHash: 'f'.repeat(64) })).toBe(true);
    expect(ok(browserAnalysisStartSchema, { engineBuild: 'c1b80eaa-0123456789ab' })).toBe(false);
  });

  it('失敗の文は 1 文字以上・上限まで', () => {
    expect(ok(browserAnalysisErrorSchema, { revision: 1, error: 'engine died' })).toBe(true);
    expect(ok(browserAnalysisErrorSchema, { revision: 1, error: '   ' })).toBe(false);
    expect(
      ok(browserAnalysisErrorSchema, { revision: 1, error: 'x'.repeat(BROWSER_ANALYSIS_LIMITS.errorMaxLength + 1) }),
    ).toBe(false);
  });
});
