import { describe, expect, it, beforeEach } from 'vitest';
import { getJob, resetJob, startJob } from './job-store.js';

describe('job-store', () => {
  beforeEach(() => {
    resetJob();
  });

  it('初期状態は idle', () => {
    expect(getJob()).toEqual({ status: 'idle' });
  });

  it('startJob で running に遷移', () => {
    let resolveRunner!: () => void;
    const runnerPromise = new Promise<void>((resolve) => {
      resolveRunner = resolve;
    });
    const state = startJob(async () => {
      await runnerPromise;
      return { imported: [], skipped: [], errors: [] };
    });
    expect(state.status).toBe('running');
    expect(getJob().status).toBe('running');
    resolveRunner();
  });

  it('runner 成功で done + 結果が入る', async () => {
    startJob(async () => ({
      imported: [{ id: 1, gameKey: 'g1' }],
      skipped: ['g2'],
      errors: [{ gameKey: 'g3', error: 'boom' }],
    }));
    // microtask を流す
    await new Promise((r) => setImmediate(r));
    const job = getJob();
    expect(job.status).toBe('done');
    if (job.status !== 'done') throw new Error('unreachable');
    expect(job.imported).toEqual([{ id: 1, gameKey: 'g1' }]);
    expect(job.skipped).toEqual(['g2']);
    expect(job.errors).toEqual([{ gameKey: 'g3', error: 'boom' }]);
  });

  it('runner が Cookie expired で throw → errorKind=cookie_expired', async () => {
    startJob(async () => {
      throw new Error('Cookie expired, re-login required');
    });
    await new Promise((r) => setImmediate(r));
    const job = getJob();
    expect(job.status).toBe('error');
    if (job.status !== 'error') throw new Error('unreachable');
    expect(job.errorKind).toBe('cookie_expired');
  });

  it('runner がその他で throw → errorKind=generic', async () => {
    startJob(async () => {
      throw new Error('network down');
    });
    await new Promise((r) => setImmediate(r));
    const job = getJob();
    expect(job.status).toBe('error');
    if (job.status !== 'error') throw new Error('unreachable');
    expect(job.errorKind).toBe('generic');
    expect(job.errorMessage).toBe('network down');
  });

  it('running 中の startJob は合流（runner を再実行しない）', async () => {
    let runnerCalls = 0;
    let resolveRunner!: () => void;
    const runnerPromise = new Promise<void>((resolve) => {
      resolveRunner = resolve;
    });
    const makeRunner = () => async () => {
      runnerCalls++;
      await runnerPromise;
      return { imported: [], skipped: [], errors: [] };
    };

    const first = startJob(makeRunner());
    const second = startJob(makeRunner());

    expect(first.status).toBe('running');
    expect(second.status).toBe('running');
    if (first.status !== 'running' || second.status !== 'running') {
      throw new Error('unreachable');
    }
    // 合流していれば startedAt が同一
    expect(second.startedAt).toBe(first.startedAt);
    expect(runnerCalls).toBe(1);
    resolveRunner();
  });

  it('done の後に startJob すると新規ジョブが走る', async () => {
    startJob(async () => ({
      imported: [{ id: 1, gameKey: 'g1' }],
      skipped: [],
      errors: [],
    }));
    await new Promise((r) => setImmediate(r));
    expect(getJob().status).toBe('done');

    startJob(async () => ({
      imported: [{ id: 2, gameKey: 'g2' }],
      skipped: [],
      errors: [],
    }));
    expect(getJob().status).toBe('running');
    await new Promise((r) => setImmediate(r));
    const job = getJob();
    expect(job.status).toBe('done');
    if (job.status !== 'done') throw new Error('unreachable');
    expect(job.imported).toEqual([{ id: 2, gameKey: 'g2' }]);
  });

  it('error の後に startJob すると新規ジョブが走る', async () => {
    startJob(async () => {
      throw new Error('network down');
    });
    await new Promise((r) => setImmediate(r));
    expect(getJob().status).toBe('error');

    startJob(async () => ({ imported: [], skipped: [], errors: [] }));
    expect(getJob().status).toBe('running');
  });
});
