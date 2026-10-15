import { describe, expect, it } from 'vitest';
import { answerBodyWithEvaluation, answerStepOf } from './drillAnswer';

const SETTINGS = {
  movetimeMs: 600,
  multiPv: 1,
  hashMb: 64,
  maxThreads: 8,
  chunkIntervalMs: 5000,
  chunkMaxPositions: 32,
  pvMaxPlies: 128,
};

describe('answerStepOf（解答の応答の振り分け。prd/13 §5.3）', () => {
  it('202 は手元 worker の評価を待つ', () => {
    expect(answerStepOf(202, { status: 'pending', jobId: 'j1' })).toEqual({ kind: 'wait-job', jobId: 'j1' });
  });

  it('evaluate はこのブラウザで読む（局面・手・設定だけを取り出す）', () => {
    expect(
      answerStepOf(200, { status: 'evaluate', sfen: 's', move: '7g7f', settings: SETTINGS }),
    ).toEqual({ kind: 'evaluate', request: { sfen: 's', move: '7g7f', settings: SETTINGS } });
  });

  it('形の足りない evaluate は誤りとして扱う（読まない）', () => {
    expect(answerStepOf(200, { status: 'evaluate', sfen: 's', move: '7g7f' })).toMatchObject({ kind: 'error' });
  });

  it('continue / done', () => {
    expect(answerStepOf(200, { status: 'continue', reply: '3c3d' })).toEqual({ kind: 'continue', reply: '3c3d' });
    const done = { status: 'done', verdict: 'correct', lossCp: 0 };
    expect(answerStepOf(200, done)).toEqual({ kind: 'done', result: done });
  });

  it('失敗は server の文、読めなければステータスで文を作る', () => {
    expect(answerStepOf(400, { error: 'その手は指せません' })).toEqual({ kind: 'error', text: 'その手は指せません' });
    expect(answerStepOf(502, null)).toEqual({ kind: 'error', text: 'サーバーエラー (502)' });
    expect(answerStepOf(200, null)).toEqual({ kind: 'error', text: 'サーバーエラー (200)' });
  });
});

describe('answerBodyWithEvaluation（送り直しの本文）', () => {
  it('🔒 手順と線引きは最初の解答のまま、評価だけを足す', () => {
    const evaluation = {
      move: '7g7f',
      candidate: { scoreType: 'cp' as const, scoreValue: -30, depth: 12, pv: ['7g7f', '3c3d'] },
      engineBuild: 'c1b80eaa-0123456789ab',
      evalHash: 'a'.repeat(64),
      engineName: 'YaneuraOu',
      fvScale: 16,
      threads: 4,
      hashMb: 64,
      movetimeMs: 600,
    };
    const body = { line: ['7g7f'], correctMargin: 100, closeMargin: 300 };
    expect(answerBodyWithEvaluation(body, evaluation)).toEqual({ ...body, evaluation });
    expect(body).not.toHaveProperty('evaluation');
  });
});
