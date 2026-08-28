import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimEvaluationJob,
  completeEvaluationJob,
  evaluationKey,
  evaluationStats,
  EvaluationQueueFullError,
  getEvaluationResult,
  startEvaluation,
  resetEvaluations,
  type EvalCandidate,
} from './position-eval.js';

const SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -';

const CANDIDATE: EvalCandidate = {
  rank: 1,
  move: '7g7f',
  scoreType: 'cp',
  scoreValue: 42,
  pv: ['7g7f', '3c3d'],
  depth: 12,
};

beforeEach(() => {
  resetEvaluations();
});

afterEach(() => {
  resetEvaluations();
  delete process.env.POSITION_EVAL_QUEUE_TIMEOUT_MS;
  delete process.env.POSITION_EVAL_RUN_TIMEOUT_MS;
});

describe('evaluationKey', () => {
  it('局面評価と名指し評価は別のキーになる', () => {
    expect(evaluationKey({ sfen: SFEN, move: null })).not.toBe(
      evaluationKey({ sfen: SFEN, move: '7g7f' }),
    );
  });

  it('名指し手が違えば別のキーになる', () => {
    expect(evaluationKey({ sfen: SFEN, move: '7g7f' })).not.toBe(
      evaluationKey({ sfen: SFEN, move: '2g2f' }),
    );
  });
});

/** 期限切れなど、タイマーが動くのを待つ */
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 評価の受付と取得（**非同期**。決定 2026-08-29 で long-poll をやめた。prd/12 §2.4）。
 *
 * 🔴 POST は待たずに `jobId` を返し、結果は `getEvaluationResult` で取りに来る。
 * long-poll をやめたのは、前段のタイムアウトが server の期限よりずっと短く、
 * **成功しているのに失敗して見える**事故が本番で起きたため。
 */
describe('startEvaluation', () => {
  it('待たずに jobId を返し、worker の報告後に取りに来られる', async () => {
    const started = startEvaluation({ sfen: SFEN, move: null });
    expect(started.state).toBe('pending');
    if (started.state !== 'pending') return;

    // まだ出ていない（**「取れない」ではない**）
    expect(getEvaluationResult(started.jobId)).toEqual({ state: 'pending' });

    const job = claimEvaluationJob();
    expect(job).not.toBeNull();
    expect(job!.sfen).toBe(SFEN);
    expect(job!.move).toBeNull();

    expect(
      completeEvaluationJob(job!.id, {
        candidates: [CANDIDATE],
        fallback: false,
      }),
    ).toBe(true);

    const poll = getEvaluationResult(started.jobId);
    expect(poll.state).toBe('settled');
    if (poll.state !== 'settled' || poll.outcome.status !== 'done') return;
    expect(poll.outcome.candidates).toEqual([CANDIDATE]);
    expect(poll.outcome.fallback).toBe(false);
  });

  it('同一局面の再訪はキャッシュから即答する（1 往復・worker を通さない）', () => {
    const started = startEvaluation({ sfen: SFEN, move: null });
    const job = claimEvaluationJob()!;
    completeEvaluationJob(job.id, { candidates: [CANDIDATE], fallback: false });
    expect(started.state).toBe('pending');

    const again = startEvaluation({ sfen: SFEN, move: null });
    expect(again.state).toBe('settled');
    if (again.state === 'settled') expect(again.outcome.status).toBe('done');
    // ジョブは作られない
    expect(claimEvaluationJob()).toBeNull();
    expect(evaluationStats()).toEqual({ queued: 0, running: 0, cached: 1 });
  });

  it('同じキーの同時要求は 1 つのジョブに相乗りし、同じ jobId が返る', () => {
    const first = startEvaluation({ sfen: SFEN, move: null });
    const second = startEvaluation({ sfen: SFEN, move: null });
    expect(evaluationStats().queued).toBe(1);
    expect(first).toEqual(second);

    const job = claimEvaluationJob()!;
    expect(claimEvaluationJob()).toBeNull();
    completeEvaluationJob(job.id, { candidates: [CANDIDATE], fallback: false });

    if (first.state !== 'pending' || second.state !== 'pending') return;
    expect(getEvaluationResult(first.jobId)).toEqual(
      getEvaluationResult(second.jobId),
    );
  });

  it('名指し評価は局面評価と別のジョブになる', () => {
    startEvaluation({ sfen: SFEN, move: null });
    startEvaluation({ sfen: SFEN, move: '7g7f' });
    expect(evaluationStats().queued).toBe(2);
  });

  it('失敗も完了として取りに来られ、キャッシュには載せない', () => {
    const started = startEvaluation({ sfen: SFEN, move: null });
    const job = claimEvaluationJob()!;
    completeEvaluationJob(job.id, { error: 'engine died' });

    if (started.state !== 'pending') return;
    expect(getEvaluationResult(started.jobId)).toEqual({
      state: 'settled',
      outcome: { status: 'failed', error: 'engine died' },
    });
    expect(evaluationStats().cached).toBe(0);

    // 失敗は載らないので、次の要求では改めてジョブができる
    startEvaluation({ sfen: SFEN, move: null });
    expect(evaluationStats().queued).toBe(1);
  });

  it('worker が取りに来なければ期限切れで failed にする', async () => {
    process.env.POSITION_EVAL_QUEUE_TIMEOUT_MS = '10';
    const started = startEvaluation({ sfen: SFEN, move: null });
    await tick(30);
    if (started.state !== 'pending') return;
    const poll = getEvaluationResult(started.jobId);
    expect(poll.state).toBe('settled');
    if (poll.state === 'settled') expect(poll.outcome.status).toBe('failed');
    // 期限切れのジョブは残らない
    expect(evaluationStats()).toEqual({ queued: 0, running: 0, cached: 0 });
  });

  it('claim 後に報告が来なくても期限切れで failed にする', async () => {
    process.env.POSITION_EVAL_QUEUE_TIMEOUT_MS = '60000';
    process.env.POSITION_EVAL_RUN_TIMEOUT_MS = '10';
    const started = startEvaluation({ sfen: SFEN, move: null });
    const job = claimEvaluationJob()!;
    await tick(30);
    if (started.state !== 'pending') return;
    const poll = getEvaluationResult(started.jobId);
    expect(poll.state).toBe('settled');
    if (poll.state === 'settled') expect(poll.outcome.status).toBe('failed');
    // 落ちた後の報告は反映しない（worker はそのまま次へ進んでよい）
    expect(
      completeEvaluationJob(job.id, { candidates: [CANDIDATE], fallback: false }),
    ).toBe(false);
  });

  it('キューが一杯なら断る（worker 停止時に積み上げない）', () => {
    // キーが別なら別ジョブになるので、局面を少しずつ変えて上限まで積む
    for (let i = 0; i < 32; i++) {
      startEvaluation({ sfen: `${SFEN} ${i}`, move: null });
    }
    expect(() =>
      startEvaluation({ sfen: `${SFEN} overflow`, move: null }),
    ).toThrowError(EvaluationQueueFullError);
  });
});

/**
 * 🔴 **`pending`（まだ出ていない）と `unknown`（もう取れない）を混ぜない。**
 * 取り違えると、クライアントは永久に出ない結果を待ち続ける。
 */
describe('getEvaluationResult', () => {
  it('知らない jobId は unknown（要求側は投げ直す合図）', () => {
    expect(getEvaluationResult('eval-999')).toEqual({ state: 'unknown' });
  });

  it('完了した結果はしばらく jobId で引ける（ポーリングが取りに来る前に消えない）', () => {
    const started = startEvaluation({ sfen: SFEN, move: null });
    const job = claimEvaluationJob()!;
    completeEvaluationJob(job.id, { candidates: [CANDIDATE], fallback: false });
    if (started.state !== 'pending') return;
    // 2 回引いても消えない（ポーリングは何度も来る）
    expect(getEvaluationResult(started.jobId).state).toBe('settled');
    expect(getEvaluationResult(started.jobId).state).toBe('settled');
  });
});

describe('claimEvaluationJob', () => {
  it('古い順に 1 件ずつ渡し、claim 済みは渡さない', () => {
    startEvaluation({ sfen: SFEN, move: null });
    startEvaluation({ sfen: SFEN, move: '7g7f' });

    const first = claimEvaluationJob()!;
    expect(first.move).toBeNull();
    const second = claimEvaluationJob()!;
    expect(second.move).toBe('7g7f');
    expect(claimEvaluationJob()).toBeNull();
    expect(evaluationStats()).toEqual({ queued: 0, running: 2, cached: 0 });
  });

  it('待っているジョブが無ければ null', () => {
    expect(claimEvaluationJob()).toBeNull();
  });
});

describe('completeEvaluationJob', () => {
  it('知らない id の報告は反映しない', () => {
    expect(
      completeEvaluationJob('eval-999', {
        candidates: [],
        fallback: false,
      }),
    ).toBe(false);
  });
});
