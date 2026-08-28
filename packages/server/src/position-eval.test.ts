import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimEvaluationJob,
  completeEvaluationJob,
  evaluationKey,
  evaluationStats,
  EvaluationQueueFullError,
  requestEvaluation,
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

describe('requestEvaluation', () => {
  it('worker の報告で long-poll が完了する', async () => {
    const pending = requestEvaluation({ sfen: SFEN, move: null });
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

    const outcome = await pending;
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.candidates).toEqual([CANDIDATE]);
      expect(outcome.fallback).toBe(false);
    }
  });

  it('同一局面の再訪はキャッシュから即答する（worker を通さない）', async () => {
    const pending = requestEvaluation({ sfen: SFEN, move: null });
    const job = claimEvaluationJob()!;
    completeEvaluationJob(job.id, { candidates: [CANDIDATE], fallback: false });
    await pending;

    const again = await requestEvaluation({ sfen: SFEN, move: null });
    expect(again.status).toBe('done');
    // ジョブは作られない
    expect(claimEvaluationJob()).toBeNull();
    expect(evaluationStats()).toEqual({ queued: 0, running: 0, cached: 1 });
  });

  it('同じキーの同時要求は 1 つのジョブに相乗りする', async () => {
    const first = requestEvaluation({ sfen: SFEN, move: null });
    const second = requestEvaluation({ sfen: SFEN, move: null });
    expect(evaluationStats().queued).toBe(1);

    const job = claimEvaluationJob()!;
    expect(claimEvaluationJob()).toBeNull();
    completeEvaluationJob(job.id, { candidates: [CANDIDATE], fallback: false });

    expect(await first).toEqual(await second);
  });

  it('名指し評価は局面評価と別のジョブになる', () => {
    void requestEvaluation({ sfen: SFEN, move: null });
    void requestEvaluation({ sfen: SFEN, move: '7g7f' });
    expect(evaluationStats().queued).toBe(2);
  });

  it('失敗も完了として long-poll に返し、キャッシュには載せない', async () => {
    const pending = requestEvaluation({ sfen: SFEN, move: null });
    const job = claimEvaluationJob()!;
    completeEvaluationJob(job.id, { error: 'engine died' });

    const outcome = await pending;
    expect(outcome).toEqual({ status: 'failed', error: 'engine died' });
    expect(evaluationStats().cached).toBe(0);

    // 失敗は載らないので、次の要求では改めてジョブができる
    void requestEvaluation({ sfen: SFEN, move: null });
    expect(evaluationStats().queued).toBe(1);
  });

  it('worker が取りに来なければ期限切れで failed にする', async () => {
    process.env.POSITION_EVAL_QUEUE_TIMEOUT_MS = '10';
    const outcome = await requestEvaluation({ sfen: SFEN, move: null });
    expect(outcome.status).toBe('failed');
    // 期限切れのジョブは残らない
    expect(evaluationStats()).toEqual({ queued: 0, running: 0, cached: 0 });
  });

  it('claim 後に報告が来なくても期限切れで failed にする', async () => {
    process.env.POSITION_EVAL_QUEUE_TIMEOUT_MS = '60000';
    process.env.POSITION_EVAL_RUN_TIMEOUT_MS = '10';
    const pending = requestEvaluation({ sfen: SFEN, move: null });
    const job = claimEvaluationJob()!;
    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    // 落ちた後の報告は反映しない（worker はそのまま次へ進んでよい）
    expect(
      completeEvaluationJob(job.id, { candidates: [CANDIDATE], fallback: false }),
    ).toBe(false);
  });

  it('キューが一杯なら断る（worker 停止時に積み上げない）', () => {
    // キーが別なら別ジョブになるので、局面を少しずつ変えて上限まで積む
    for (let i = 0; i < 32; i++) {
      void requestEvaluation({ sfen: `${SFEN} ${i}`, move: null });
    }
    expect(() =>
      requestEvaluation({ sfen: `${SFEN} overflow`, move: null }),
    ).toThrowError(EvaluationQueueFullError);
  });
});

describe('claimEvaluationJob', () => {
  it('古い順に 1 件ずつ渡し、claim 済みは渡さない', () => {
    void requestEvaluation({ sfen: SFEN, move: null });
    void requestEvaluation({ sfen: SFEN, move: '7g7f' });

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
