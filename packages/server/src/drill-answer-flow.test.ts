import { describe, expect, it, vi } from 'vitest';
import { buildPositions, positionSfen } from 'shared';
import {
  drillPosition,
  gradeAnswer,
  type AnswerDeps,
  type AnswerDrill,
  type EngineRequest,
} from './drill-answer-flow';
import type { EngineAnswer } from './drill-engine';
import { drillSfen } from './drill-query';

/** 次の一手: 初期局面（moveNumber 0）。候補手は 3 本 */
const BEST: AnswerDrill = {
  id: 7,
  kifuNo: 42,
  ownerId: 'u1',
  kind: 'best',
  reason: 'own_blunder',
  moveNumber: 0,
  answerMove: '2g2f',
  answerScoreType: 'cp',
  answerScoreValue: 500,
  answerPv: ['2g2f', '8c8d'],
  candidates: [
    { rank: 1, move: '2g2f', scoreType: 'cp', scoreValue: 500 },
    { rank: 2, move: '7g7f', scoreType: 'cp', scoreValue: 450 },
  ],
  matePlies: null,
  playedMove: '5i5h',
  playedLossCp: 900,
  usiMoves: ['5i5h', '3c3d'],
};

/**
 * 詰将棋: 7g7f 3c3d の後（先手番）。`8h3c` は 4b を通して 5a の玉への王手。
 * 正解手順の中身は検証しない（照合に使うだけ）ので、短い手順で流れを確かめる
 */
const MATE: AnswerDrill = {
  ...BEST,
  kind: 'mate',
  reason: 'missed_mate',
  moveNumber: 2,
  answerMove: '8h3c',
  answerScoreType: 'mate',
  answerScoreValue: 3,
  answerPv: ['8h3c', '4a4b', '3c4b'],
  candidates: [],
  matePlies: 3,
  usiMoves: ['7g7f', '3c3d', '2g2f'],
};

function makeDeps(answer: EngineAnswer = { status: 'pending', jobId: 'job-1' }, recalled: string[] | null = null) {
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  const deps: AnswerDeps & { engineInputs: EngineRequest[]; commit(): void } = {
    engineInputs: [],
    afterCommit: vi.fn((fn: () => void) => {
      calls.push('after-commit');
      pending.push(fn);
    }),
    commit() {
      for (const fn of pending.splice(0)) fn();
    },
    recallLine: vi.fn(() => {
      calls.push('recall');
      return recalled;
    }),
    forgetLine: vi.fn(() => {
      calls.push('forget');
    }),
    recordAttempt: vi.fn(async () => {
      calls.push('record');
    }),
    analysisAssignee: vi.fn(async () => {
      calls.push('assignee');
      return 'browser' as const;
    }),
    resolveWithEngine: vi.fn(async (input: EngineRequest) => {
      calls.push('engine');
      deps.engineInputs.push(input);
      return answer;
    }),
  };
  return { deps, calls };
}

const REVEAL_KEYS = ['kifuNo', 'moveNumber', 'reason', 'answerMove', 'answerPv', 'playedMove', 'playedLossCp', 'plies', 'answerPlies'];
const hasReveal = (body: object) => REVEAL_KEYS.some((k) => k in body);

describe('gradeAnswer: 次の一手', () => {
  it('候補手にある手はエンジンに回さず 200 の done（答えを載せる）。記録する', async () => {
    const { deps } = makeDeps();
    const res = await gradeAnswer(BEST, { line: ['7g7f'] }, deps);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'done', verdict: 'correct', lossCp: 50, kifuNo: 42, answerMove: '2g2f', plies: 1, answerPlies: 2 });
    expect(deps.resolveWithEngine).not.toHaveBeenCalled();
    expect(deps.recordAttempt).toHaveBeenCalledWith({ drillId: 7, ownerId: 'u1', move: '7g7f', line: ['7g7f'], verdict: 'correct', lossCp: 50 });
  });

  it('採点の線引きは本文の値を使う', async () => {
    const { deps } = makeDeps();
    const res = await gradeAnswer(BEST, { line: ['7g7f'], correctMargin: 10, closeMargin: 20 }, deps);
    expect(res.body).toMatchObject({ verdict: 'wrong', lossCp: 50 });
  });

  it('練習（practice）は判定を返すが記録しない', async () => {
    const { deps } = makeDeps();
    const res = await gradeAnswer(BEST, { line: ['2g2f'], practice: true }, deps);
    expect(res.body).toMatchObject({ status: 'done', verdict: 'correct' });
    expect(deps.recordAttempt).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'pending', jobId: 'job-1' } as const, 202, { status: 'pending', jobId: 'job-1' }],
    [{ status: 'busy' } as const, 503, { error: '評価キューが一杯です', code: 'unavailable' }],
    [{ status: 'failed', error: 'worker が落ちた' } as const, 502, { error: 'worker が落ちた', code: 'bad_gateway' }],
  ])('候補手の外の手はエンジンの結果をステータスへ写す: %o → %i', async (answer, status, body) => {
    const { deps } = makeDeps(answer);
    const res = await gradeAnswer(BEST, { line: ['1g1f'] }, deps);
    expect(res.status).toBe(status);
    expect(res.body).toEqual(body);
  });

  it('evaluate（ブラウザに読ませる）は 200 で、答えを載せない', async () => {
    const settings = { movetimeMs: 600 } as unknown as Extract<EngineAnswer, { status: 'evaluate' }>['settings'];
    const { deps } = makeDeps({ status: 'evaluate', sfen: 'x', move: '1g1f', settings });
    const res = await gradeAnswer(BEST, { line: ['1g1f'] }, deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'evaluate', sfen: 'x', move: '1g1f', settings });
    expect(hasReveal(res.body)).toBe(false);
  });

  it('エンジンの done は 200 で答えを載せる', async () => {
    const { deps } = makeDeps({ status: 'done', verdict: 'wrong', lossCp: 400, refutation: ['8c8d'] });
    const res = await gradeAnswer(BEST, { line: ['1g1f'] }, deps);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'done', verdict: 'wrong', refutation: ['8c8d'], answerMove: '2g2f' });
  });

  it('エンジンには担当・ブラウザの評価・局面を渡す（mateRemainingPlies は付けない）', async () => {
    const { deps } = makeDeps();
    const evaluation = {
      move: '1g1f',
      candidate: { scoreType: 'cp' as const, scoreValue: 100, depth: 10, pv: ['1g1f'] },
      engineBuild: 'b',
      evalHash: 'h',
      fvScale: 16,
      threads: 1,
      movetimeMs: 600,
    } as unknown as NonNullable<Parameters<typeof gradeAnswer>[1]['evaluation']>;
    await gradeAnswer(BEST, { line: ['1g1f'], evaluation }, deps);
    const [input] = deps.engineInputs;
    expect(input.assignee).toBe('browser');
    expect(input.browserEvaluation).toEqual({ candidate: evaluation.candidate });
    expect(input.move).toBe('1g1f');
    expect(positionSfen(input.state)).toBe(positionSfen(buildPositions([])[0]));
    expect('mateRemainingPlies' in input).toBe(false);
  });
});

describe('gradeAnswer: 検証の順序（手順の照合 → 局面 → 評価の手 → 指せる手か）', () => {
  it('次の一手で 2 手以上の手順は 400（局面を作れない問題でも、照合が先）', async () => {
    const { deps } = makeDeps();
    const res = await gradeAnswer({ ...BEST, usiMoves: null }, { line: ['2g2f', '8c8d'] }, deps);
    expect(res).toEqual({ status: 400, body: { error: '手順が出題と噛み合いません', code: 'bad_request' } });
  });

  it('詰将棋で正解手順のどれの先頭とも合わない手順は 400', async () => {
    const { deps } = makeDeps();
    const res = await gradeAnswer({ ...MATE, usiMoves: null }, { line: ['2g2f', '8c8d', '7g7f'] }, deps);
    expect(res).toEqual({ status: 400, body: { error: '手順が出題と噛み合いません', code: 'bad_request' } });
  });

  it('局面を作れない問題は 409（評価の手の照合より先）', async () => {
    const { deps } = makeDeps();
    const evaluation = { move: '9a9b' } as unknown as NonNullable<Parameters<typeof gradeAnswer>[1]['evaluation']>;
    const res = await gradeAnswer({ ...BEST, usiMoves: [], moveNumber: 3 }, { line: ['2g2f'], evaluation }, deps);
    expect(res).toEqual({ status: 409, body: { error: '出題局面を再現できません', code: 'conflict' } });
  });

  it('評価の手が解答の手と違えば 400（指せない手の検証より先）', async () => {
    const { deps } = makeDeps();
    const evaluation = { move: '2g2f' } as unknown as NonNullable<Parameters<typeof gradeAnswer>[1]['evaluation']>;
    const res = await gradeAnswer(BEST, { line: ['5e5d'], evaluation }, deps);
    expect(res).toEqual({ status: 400, body: { error: '評価の手が解答と噛み合いません', code: 'bad_request' } });
  });

  it('駒の無い升からの手は 400 で violations を返す', async () => {
    const { deps } = makeDeps();
    const res = await gradeAnswer(BEST, { line: ['5e5d'] }, deps);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'その手は指せません' });
    expect((res.body as { violations?: unknown[] }).violations?.length).toBeGreaterThan(0);
  });

  it('駒の動き方として指せない手は 400（violations なし）', async () => {
    const { deps } = makeDeps();
    const res = await gradeAnswer(BEST, { line: ['7g7e'] }, deps);
    expect(res).toEqual({ status: 400, body: { error: 'その手は指せません', code: 'bad_request' } });
  });

  it('検証で落ちたときは記録もエンジンも呼ばない', async () => {
    const { deps } = makeDeps();
    await gradeAnswer(BEST, { line: ['7g7e'] }, deps);
    expect(deps.recordAttempt).not.toHaveBeenCalled();
    expect(deps.resolveWithEngine).not.toHaveBeenCalled();
    expect(deps.analysisAssignee).not.toHaveBeenCalled();
  });
});

describe('gradeAnswer: 詰将棋', () => {
  it('王手でない手は miss（not_check）。答えを載せず、不正解を記録する', async () => {
    const { deps } = makeDeps();
    const res = await gradeAnswer(MATE, { line: ['2g2f'] }, deps);
    expect(res).toEqual({ status: 200, body: { status: 'miss', wrongReason: 'not_check' } });
    expect(deps.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'wrong', lossCp: null }));
    expect(deps.resolveWithEngine).not.toHaveBeenCalled();
  });

  it('手順どおりで続きがあれば continue（受方の応手だけ）', async () => {
    const { deps } = makeDeps();
    const res = await gradeAnswer(MATE, { line: ['8h3c'] }, deps);
    expect(res).toEqual({ status: 200, body: { status: 'continue', reply: '4a4b' } });
    expect(deps.recordAttempt).not.toHaveBeenCalled();
    expect(deps.forgetLine).not.toHaveBeenCalled();
  });

  it('詰み上がりは done（答えを載せる）。記録し、手順はコミットの後に忘れる', async () => {
    const { deps, calls } = makeDeps();
    const res = await gradeAnswer({ ...MATE, answerPv: ['8h3c'] }, { line: ['8h3c'] }, deps);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'done', verdict: 'correct', lossCp: null, plies: 1, answerPlies: 1 });
    // 🔒 コミット前には忘れない（記録が戻ったときに記憶だけが消えないように）
    expect(calls).toEqual(['recall', 'record', 'after-commit']);
    deps.commit();
    expect(calls).toEqual(['recall', 'record', 'after-commit', 'forget']);
  });

  it('覚えた別解の手順でも受ける', async () => {
    const { deps } = makeDeps(undefined, ['8h3c', '5a6b']);
    const res = await gradeAnswer({ ...MATE, answerPv: ['2g2f'] }, { line: ['8h3c'] }, deps);
    expect(res.body).toEqual({ status: 'continue', reply: '5a6b' });
  });

  it('手順から外れた王手はエンジンに聞く（残り手数を渡す）', async () => {
    const { deps } = makeDeps({ status: 'continue', reply: '4a4b' });
    const res = await gradeAnswer({ ...MATE, answerPv: ['2g2f', '8c8d', '7g7f'] }, { line: ['8h3c'] }, deps);
    expect(res).toEqual({ status: 200, body: { status: 'continue', reply: '4a4b' } });
    expect(deps.engineInputs[0].mateRemainingPlies).toBe(3);
  });

  it('エンジンの miss は答えを載せない', async () => {
    const { deps } = makeDeps({ status: 'miss', wrongReason: 'no_mate', refutation: ['4a4b'] });
    const res = await gradeAnswer({ ...MATE, answerPv: ['2g2f'] }, { line: ['8h3c'] }, deps);
    expect(res).toEqual({ status: 200, body: { status: 'miss', wrongReason: 'no_mate', refutation: ['4a4b'] } });
    expect(hasReveal(res.body)).toBe(false);
  });
});

describe('出題の局面（drillPosition / drillSfen）', () => {
  it('moveNumber 手を指す直前の局面', () => {
    expect(drillSfen(['7g7f', '3c3d'], 0)).toBe(positionSfen(buildPositions([])[0]));
    expect(drillSfen(['7g7f', '3c3d'], 1)).toBe(positionSfen(buildPositions(['7g7f'])[1]));
    // 全手を指した後の局面も作れる
    expect(drillSfen(['7g7f', '3c3d'], 2)).toBe(positionSfen(buildPositions(['7g7f', '3c3d'])[2]));
  });

  it('指し手列が無い・足りなければ null（数字を捏造しない）', () => {
    expect(drillSfen(null, 0)).toBeNull();
    expect(drillSfen(['7g7f'], 2)).toBeNull();
    expect(drillPosition(null, 0)).toBeNull();
  });
});
