import { describe, expect, it } from 'vitest';
import {
  estimateAnalyzed,
  formatElapsed,
  formatUpdatedAgo,
  initialPaceState,
  nextPaceState,
  pollingPlan,
  progressDimClass,
  BACKOFF_INVALIDATE_INTERVAL_MS,
  IDLE_INTERVAL_MS,
  PENDING_BACKOFF_AFTER_MS,
  PENDING_INTERVAL_MS,
  PENDING_INVALIDATE_INTERVAL_MS,
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

  /** 実測ペースを直接与えた状態（漸近の性質だけを見たいケース用） */
  const stateWith = (
    latest: ProgressSample,
    msPerPosition: number | null,
  ) => ({ latest, msPerPosition });

  it('標本が 1 つの間は既定のペース（本番 quick の movetime 由来）で進む', () => {
    const state = nextPaceState(
      initialPaceState,
      sample({ analyzed: 10, receivedAt: 1_000 }),
    );
    expect(state.msPerPosition).toBeNull();
    // 既定 150ms/局面 → 次の標本までの予測は 3000/150 = 20 局面ぶん。
    // τ ぶん（1.5 秒）経った時点でその 1-e^-1 = 63%
    expect(estimateAnalyzed(state, 2_500)).toBeCloseTo(10 + 20 * (1 - Math.exp(-1)), 6);
  });

  it('2 標本目からは実測（Δanalyzed / Δt）で自己校正する', () => {
    let state = nextPaceState(
      initialPaceState,
      sample({ analyzed: 0, receivedAt: 0 }),
    );
    // 3 秒で 6 局面 = 500ms/局面（既定の 150ms とは大きく違う値に寄せる）
    state = nextPaceState(state, sample({ analyzed: 6, receivedAt: 3_000 }));
    expect(state.msPerPosition).toBeCloseTo(500, 6);
    // 予測は 3000/500 = 6 局面ぶん
    expect(estimateAnalyzed(state, 4_500)).toBeCloseTo(6 + 6 * (1 - Math.exp(-1)), 6);
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

  it('標本の間は単調に増加する', () => {
    const state = stateWith(
      sample({ analyzed: 20, receivedAt: 0, total: 115 }),
      35,
    );
    let previous = -1;
    for (let t = 0; t <= 3_000; t += 250) {
      const value = estimateAnalyzed(state, t);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('次の標本で来るはずの値（ペース × ポーリング間隔）を超えない', () => {
    const pace = 35;
    const state = stateWith(
      sample({ analyzed: 20, receivedAt: 0, total: 10_000 }),
      pace,
    );
    const predicted = 20 + PENDING_INTERVAL_MS / pace;
    for (let t = 0; t <= 60_000; t += 500) {
      expect(estimateAnalyzed(state, t)).toBeLessThan(predicted);
    }
  });

  it('実データが total 未満の間は推定も total に達しない（dev 実測の再現・35ms/局面・92/115）', () => {
    // 🔴 かつて線形に外挿していたとき、この条件で 3 秒待たずにバーが満杯になり、
    // 実データが 92/115 のまま数秒張り付いた（実測・2026-09-07）
    const state = stateWith(
      sample({ analyzed: 92, receivedAt: 0, total: 115 }),
      35,
    );
    for (let t = 0; t <= 3_000; t += 500) {
      expect(estimateAnalyzed(state, t)).toBeLessThan(115);
    }
    // 何分放置しても（凍結を含めて）到達しない
    expect(estimateAnalyzed(state, 600_000)).toBeLessThan(115);
    // それでいて 3 秒で 8 割方は進んでいる（遅すぎて役に立たない、にはなっていない）
    expect(estimateAnalyzed(state, 3_000)).toBeGreaterThan(92 + (115 - 92) * 0.8);
  });

  it('標本が遅れるほど増分が減衰する（止まっていることを隠さない）', () => {
    const state = stateWith(
      sample({ analyzed: 10, receivedAt: 0, total: 1_000 }),
      35,
    );
    const at = (t: number) => estimateAnalyzed(state, t);
    const first = at(500) - at(0);
    const second = at(1_000) - at(500);
    const third = at(1_500) - at(1_000);
    expect(second).toBeLessThan(first);
    expect(third).toBeLessThan(second);
    // 標本が来ないまま数秒経てば、増分は最初の 500ms のそれの数 % まで落ちる
    // （バーは目で見て止まっている）
    expect(at(9_000) - at(6_000)).toBeLessThan(first * 0.1);
  });

  it('基準点より手前へは戻らない（時計が戻っても）', () => {
    const state = nextPaceState(
      initialPaceState,
      sample({ analyzed: 10, receivedAt: 1_000 }),
    );
    expect(estimateAnalyzed(state, 1_000)).toBe(10);
    expect(estimateAnalyzed(state, 0)).toBe(10);
  });

  it('基準点が無ければ 0', () => {
    expect(estimateAnalyzed(initialPaceState, 12_345)).toBe(0);
  });
});

describe('pollingPlan', () => {
  const t0 = 1_000_000;

  it('待っていなければ長間隔・ローダーの作り直しもしない', () => {
    expect(pollingPlan({ pending: false, waitingSince: null, now: t0 })).toEqual({
      pollIntervalMs: IDLE_INTERVAL_MS,
      invalidateIntervalMs: null,
    });
  });

  it('待っている間は短間隔 + 定期的な作り直し', () => {
    expect(
      pollingPlan({ pending: true, waitingSince: t0, now: t0 + 60_000 }),
    ).toEqual({
      pollIntervalMs: PENDING_INTERVAL_MS,
      invalidateIntervalMs: PENDING_INVALIDATE_INTERVAL_MS,
    });
  });

  it('進捗を観測しないまま待ち続けたらポーリングを長間隔へ戻す', () => {
    expect(
      pollingPlan({
        pending: true,
        waitingSince: t0,
        now: t0 + PENDING_BACKOFF_AFTER_MS,
      }).pollIntervalMs,
    ).toBe(IDLE_INTERVAL_MS);
  });

  it('🔒 バックオフしても作り直しは止めず、間隔を落とすだけ（後から動き出しても戻れる）', () => {
    const plan = pollingPlan({
      pending: true,
      waitingSince: t0,
      now: t0 + PENDING_BACKOFF_AFTER_MS * 10,
    });
    expect(plan.invalidateIntervalMs).toBe(BACKOFF_INVALIDATE_INTERVAL_MS);
    expect(plan.invalidateIntervalMs).not.toBeNull();
    // 待っている間の間隔よりは粗い
    expect(plan.invalidateIntervalMs!).toBeGreaterThan(
      PENDING_INVALIDATE_INTERVAL_MS,
    );
  });

  it('進捗を観測したら（起点が進めば）即座に短間隔へ戻る', () => {
    const now = t0 + PENDING_BACKOFF_AFTER_MS * 2;
    expect(
      pollingPlan({ pending: true, waitingSince: t0, now }).pollIntervalMs,
    ).toBe(IDLE_INTERVAL_MS);
    // 直前に観測できた＝起点が今に進む
    expect(
      pollingPlan({ pending: true, waitingSince: now, now }),
    ).toEqual({
      pollIntervalMs: PENDING_INTERVAL_MS,
      invalidateIntervalMs: PENDING_INVALIDATE_INTERVAL_MS,
    });
  });

  it('待ち始めの起点が未設定なら（まだ待ちに入った直後）バックオフしない', () => {
    expect(
      pollingPlan({ pending: true, waitingSince: null, now: t0 }).pollIntervalMs,
    ).toBe(PENDING_INTERVAL_MS);
  });
});
