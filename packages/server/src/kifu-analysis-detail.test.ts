import { describe, expect, it } from 'vitest';
import {
  EMPTY_ANALYSIS,
  compactRuns,
  decodeAll,
  decodeCandidates,
  decodePosition,
  encodeCandidates,
  mergeChunk,
  minMateBySide,
  type AnalysisDetail,
  type AnalysisRun,
  type CandidateMove,
  type StoredAnalysis,
} from './kifu-analysis-detail.js';

const run = (profile: 'quick' | 'full', at = '2026-10-07T00:00:00.000Z'): AnalysisRun => ({
  profile,
  engineName: 'YaneuraOu',
  movetimeMs: profile === 'quick' ? 100 : 1000,
  targetDepth: null,
  multiPv: 3,
  at,
});

const cand = (move: string, scoreValue = 0, scoreType: 'cp' | 'mate' = 'cp', rank = 1): CandidateMove => ({
  rank,
  move,
  scoreType,
  scoreValue,
  pv: [move],
  depth: 10,
});

const chunk = (from: number, to: number, tag = 'x') =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    moveNumber: from + i,
    candidates: [cand(`${tag}${from + i}`)],
  }));

/** 局面 → 書いた run の段階 */
const profiles = (a: StoredAnalysis) => a.detail.map(([r]) => a.runs[r].profile);

function merged(current: StoredAnalysis, c: ReturnType<typeof chunk>, r: AnalysisRun) {
  const result = mergeChunk(current, c, r);
  if (!result.ok) throw new Error('rejected');
  return result;
}

describe('encodeCandidates / decodeCandidates', () => {
  it('rank 順に並べて往復する（rank は位置から戻る）', () => {
    const input = [cand('2g2f', -10, 'cp', 2), cand('7g7f', 30, 'cp', 1), { ...cand('5i5h', 0, 'cp', 3), pv: null }];
    const stored = encodeCandidates(input);
    expect(stored[0]).toEqual(['7g7f', 'cp', 30, 10, ['7g7f']]);
    expect(decodeCandidates(stored)).toEqual([
      cand('7g7f', 30, 'cp', 1),
      cand('2g2f', -10, 'cp', 2),
      { ...cand('5i5h', 0, 'cp', 3), pv: null },
    ]);
  });
});

describe('decodePosition', () => {
  it('局面の run から段階・来歴を引く', () => {
    const runs = [run('quick'), run('full')];
    const detail: AnalysisDetail = [[1, encodeCandidates([cand('7g7f')])]];
    expect(decodePosition(detail, runs, 0)).toEqual({
      moveNumber: 0,
      run: runs[1],
      candidates: [cand('7g7f')],
    });
    expect(decodePosition(detail, runs, 1)).toBeNull();
  });

  it('指す先の run が無ければ例外（壊れた行を黙って補わない）', () => {
    expect(() => decodePosition([[5, []]], [run('quick')], 0)).toThrow();
  });
});

describe('mergeChunk', () => {
  it('空のチャンクは何も書かない', () => {
    const result = merged(EMPTY_ANALYSIS, [], run('quick'));
    expect(result.wrote).toBe(false);
    expect(result.next).toBe(EMPTY_ANALYSIS);
  });

  it('quick を追記する（fullCount は変えない）', () => {
    const a = merged(EMPTY_ANALYSIS, chunk(0, 2), run('quick')).next;
    const b = merged(a, chunk(3, 4), run('quick', 'T2')).next;
    expect(b.detail).toHaveLength(5);
    expect(b.fullCount).toBe(0);
    expect(b.runs.map((r) => r.at)).toEqual(['2026-10-07T00:00:00.000Z', 'T2']);
  });

  it('重なりは再送として上書きする（結果が同じになる）', () => {
    const a = merged(EMPTY_ANALYSIS, chunk(0, 2), run('quick')).next;
    const b = merged(a, chunk(1, 3, 'y'), run('quick', 'T2')).next;
    expect(decodeAll(b.detail, b.runs).map((p) => p.candidates[0].move)).toEqual(['x0', 'y1', 'y2', 'y3']);
  });

  it('飛び・重複・欠けのあるチャンクは受けない（quick / full 共通）', () => {
    const gap = [chunk(0, 0)[0], chunk(2, 2)[0]];
    const dup = [chunk(0, 0)[0], chunk(0, 0)[0]];
    const desc = [chunk(1, 1)[0], chunk(0, 0)[0]];
    for (const p of ['quick', 'full'] as const) {
      expect(mergeChunk(EMPTY_ANALYSIS, gap, run(p)).ok).toBe(false);
      expect(mergeChunk(EMPTY_ANALYSIS, dup, run(p)).ok).toBe(false);
      expect(mergeChunk(EMPTY_ANALYSIS, desc, run(p)).ok).toBe(false);
    }
  });

  it('quick の先頭が末尾を越えたら受けない', () => {
    const a = merged(EMPTY_ANALYSIS, chunk(0, 2), run('quick')).next;
    expect(mergeChunk(a, chunk(3, 3), run('quick')).ok).toBe(true);
    expect(mergeChunk(a, chunk(4, 5), run('quick')).ok).toBe(false);
  });

  it('full は先頭が fullCount 以下のときだけ受け、fullCount を伸ばす', () => {
    const quick = merged(EMPTY_ANALYSIS, chunk(0, 4), run('quick')).next;
    // 🔴 fullCount = 0 なのに 2 から始まる full は、0・1 を飛ばして full と数えてしまう
    expect(mergeChunk(quick, chunk(2, 3), run('full')).ok).toBe(false);
    const a = merged(quick, chunk(0, 1), run('full')).next;
    expect(a.fullCount).toBe(2);
    expect(profiles(a)).toEqual(['full', 'full', 'quick', 'quick', 'quick']);
    // 重なり（再送）は受けて上書き
    const b = merged(a, chunk(1, 3), run('full', 'T2')).next;
    expect(b.fullCount).toBe(4);
    // 末尾を越えて full が伸びる（quick より先に進む場合）
    const c = merged(b, chunk(4, 6), run('full', 'T3')).next;
    expect(c.fullCount).toBe(7);
    expect(c.detail).toHaveLength(7);
  });

  it('fullCount より前の局面への quick は捨てる（段階の後退防止）', () => {
    const a = merged(EMPTY_ANALYSIS, chunk(0, 2), run('full')).next;
    const all = mergeChunk(a, chunk(0, 1, 'q'), run('quick'));
    expect(all).toEqual({ ok: true, next: a, wrote: false });
    const b = merged(a, chunk(1, 4, 'q'), run('quick', 'T2')).next;
    expect(b.fullCount).toBe(3);
    expect(profiles(b)).toEqual(['full', 'full', 'full', 'quick', 'quick']);
    expect(decodeAll(b.detail, b.runs).map((p) => p.candidates[0].move)).toEqual(['x0', 'x1', 'x2', 'q3', 'q4']);
  });

  it('上書きで指されなくなった run は消える（runs の件数 ≤ 局面数）', () => {
    const a = merged(EMPTY_ANALYSIS, chunk(0, 1), run('quick', 'T1')).next;
    const b = merged(a, chunk(0, 1), run('full', 'T2')).next;
    expect(b.runs.map((r) => r.at)).toEqual(['T2']);
    expect(b.detail.map(([r]) => r)).toEqual([0, 0]);
  });
});

describe('compactRuns', () => {
  it('使われていない run を消し、順序を保って添字を詰める', () => {
    const before: StoredAnalysis = {
      runs: [run('quick', 'A'), run('quick', 'B'), run('full', 'C'), run('full', 'D')],
      detail: [
        [2, []],
        [3, []],
        [0, []],
      ],
      fullCount: 0,
    };
    const after = compactRuns(before);
    expect(after.runs.map((r) => r.at)).toEqual(['A', 'C', 'D']);
    expect(after.detail.map(([r]) => r)).toEqual([1, 2, 0]);
  });

  it('全部使われていればそのまま返す', () => {
    const a: StoredAnalysis = { runs: [run('quick')], detail: [[0, []]], fullCount: 0 };
    expect(compactRuns(a)).toBe(a);
  });
});

describe('minMateBySide', () => {
  const pos = (scoreType: 'cp' | 'mate', value: number) =>
    [0, encodeCandidates([cand('x', value, scoreType)])] as AnalysisDetail[number];

  it('手番ごとに rank 1 の正の mate の最小値を取る', () => {
    const detail: AnalysisDetail = [
      pos('mate', 7), // 先手番
      pos('mate', 3), // 後手番
      pos('mate', 5), // 先手番
      pos('mate', -2), // 後手番（詰まされる側）は数えない
      pos('cp', 900),
    ];
    expect(minMateBySide(detail)).toEqual({ sente: 5, gote: 3 });
  });

  it('rank 2 以下の mate は見ない・無ければ null', () => {
    const detail: AnalysisDetail = [
      [0, encodeCandidates([cand('a', 100, 'cp', 1), cand('b', 1, 'mate', 2)])],
      [0, []],
    ];
    expect(minMateBySide(detail)).toEqual({ sente: null, gote: null });
  });
});
