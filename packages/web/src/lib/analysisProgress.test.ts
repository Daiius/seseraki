import { describe, expect, it } from 'vitest';
import {
  estimateAnalyzed,
  formatElapsed,
  formatUpdatedAgo,
  initialPaceState,
  nextPaceState,
  progressDimClass,
  ESTIMATE_HORIZON_MS,
  type AnalysisProgress,
  type ProgressSample,
} from './analysisProgress';

describe('progressDimClass', () => {
  it('quick 進行中は半透明（段階は文字で出さない）', () => {
    expect(progressDimClass('quick')).toBe('opacity-50');
  });

  it('full 進行中は現行どおりの見え方', () => {
    expect(progressDimClass('full')).toBe('');
  });
});

describe('formatElapsed', () => {
  it('1 分未満は秒', () => {
    expect(formatElapsed(0)).toBe('0秒前');
    expect(formatElapsed(59_999)).toBe('59秒前');
  });

  it('1 時間未満は分（端数は切り捨て）', () => {
    expect(formatElapsed(60_000)).toBe('1分前');
    expect(formatElapsed(90_000)).toBe('1分前');
    expect(formatElapsed(59 * 60_000)).toBe('59分前');
  });

  it('1 時間以上は時間 + 分', () => {
    expect(formatElapsed(60 * 60_000)).toBe('1時間0分前');
    expect(formatElapsed(95 * 60_000)).toBe('1時間35分前');
  });

  it('負の経過（時計のずれ）は 0 秒に丸める', () => {
    expect(formatElapsed(-5_000)).toBe('0秒前');
  });
});

describe('formatUpdatedAgo', () => {
  const progress = (updatedAt: string): AnalysisProgress => ({
    kifuId: 1,
    revision: 0,
    profile: 'full',
    analyzed: 87,
    total: 154,
    updatedAt,
  });

  it('経過を「◯前に更新」にする', () => {
    const now = Date.parse('2026-07-21T12:03:00.000Z');
    expect(formatUpdatedAgo(progress('2026-07-21T12:00:00.000Z'), now)).toBe(
      '3分前に更新',
    );
  });

  it('updatedAt が読めなければ空文字', () => {
    expect(formatUpdatedAgo(progress('not a date'), Date.now())).toBe('');
  });
});

describe('nextPaceState / estimateAnalyzed', () => {
  const sample = (
    over: Partial<ProgressSample> & { analyzed: number; receivedAt: number },
  ): ProgressSample => ({
    kifuId: 1,
    revision: 0,
    profile: 'quick',
    total: 100,
    updatedAt: '2026-09-07T00:00:00.000Z',
    ...over,
  });

  it('標本が 1 つの間は既定のペース（本番 quick の movetime 由来）で進む', () => {
    const state = nextPaceState(
      initialPaceState,
      sample({ analyzed: 10, receivedAt: 1_000 }),
    );
    expect(state.msPerPosition).toBeNull();
    // 既定 150ms/局面 なので 1.5 秒で 10 局面ぶん進む
    expect(estimateAnalyzed(state, 2_500)).toBeCloseTo(20, 6);
  });

  it('2 標本目からは実測（Δanalyzed / Δt）で自己校正する', () => {
    let state = nextPaceState(
      initialPaceState,
      sample({ analyzed: 0, receivedAt: 0 }),
    );
    // 3 秒で 6 局面 = 500ms/局面（既定の 150ms とは大きく違う値に寄せる）
    state = nextPaceState(state, sample({ analyzed: 6, receivedAt: 3_000 }));
    expect(state.msPerPosition).toBeCloseTo(500, 6);
    expect(estimateAnalyzed(state, 4_000)).toBeCloseTo(8, 6);
  });

  it('別の解析（棋譜 / 世代 / 段階が変わる）ではペースを引き継がない', () => {
    let state = nextPaceState(
      initialPaceState,
      sample({ analyzed: 0, receivedAt: 0 }),
    );
    state = nextPaceState(state, sample({ analyzed: 10, receivedAt: 1_000 }));
    expect(state.msPerPosition).not.toBeNull();
    // quick から full へ（同じ棋譜でも段階が変われば 1 局面の所要が桁で変わる）
    state = nextPaceState(
      state,
      sample({ analyzed: 0, receivedAt: 2_000, profile: 'full' }),
    );
    expect(state.msPerPosition).toBeNull();
    expect(state.latest?.profile).toBe('full');
  });

  it('進んでいない標本ではペースを更新せず、基準点だけ進める', () => {
    let state = nextPaceState(
      initialPaceState,
      sample({ analyzed: 5, receivedAt: 0 }),
    );
    state = nextPaceState(state, sample({ analyzed: 10, receivedAt: 1_000 }));
    const pace = state.msPerPosition;
    state = nextPaceState(state, sample({ analyzed: 10, receivedAt: 4_000 }));
    expect(state.msPerPosition).toBe(pace);
    expect(state.latest?.receivedAt).toBe(4_000);
  });

  it('total を超えない', () => {
    const state = nextPaceState(
      initialPaceState,
      sample({ analyzed: 99, receivedAt: 0, total: 100 }),
    );
    expect(estimateAnalyzed(state, 1_000_000)).toBe(100);
  });

  it('実データを追い越さない（基準点より前へは戻らず、経過ぶんしか進まない）', () => {
    const state = nextPaceState(
      initialPaceState,
      sample({ analyzed: 10, receivedAt: 1_000 }),
    );
    expect(estimateAnalyzed(state, 1_000)).toBe(10);
    // 時計が戻っても基準点より手前は出さない
    expect(estimateAnalyzed(state, 0)).toBe(10);
    // 既定ペースで 300ms = 2 局面ぶん
    expect(estimateAnalyzed(state, 1_300)).toBeCloseTo(12, 6);
  });

  it('進捗が止まったら推定も止まる（止まっていることを隠さない）', () => {
    const state = nextPaceState(
      initialPaceState,
      sample({ analyzed: 10, receivedAt: 0, total: 1_000 }),
    );
    const frozen = estimateAnalyzed(state, ESTIMATE_HORIZON_MS);
    expect(estimateAnalyzed(state, ESTIMATE_HORIZON_MS * 10)).toBe(frozen);
    expect(frozen).toBeLessThan(1_000);
  });

  it('基準点が無ければ 0', () => {
    expect(estimateAnalyzed(initialPaceState, 12_345)).toBe(0);
  });
});
