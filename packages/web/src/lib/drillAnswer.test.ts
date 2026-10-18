import { describe, expect, it } from 'vitest';
import {
  answerBodyWithEvaluation,
  answerStepOf,
  attemptMoveLabel,
  lineAfterUndoTurn,
  matePliesText,
  missText,
  practiceNote,
} from './drillAnswer';

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

describe('詰将棋で間違えた手（miss。prd/13 §5.2）', () => {
  it('理由と咎め筋を取り出す（答えは載らない）', () => {
    expect(answerStepOf(200, { status: 'miss', wrongReason: 'no_mate', refutation: ['5a4b'] })).toEqual({
      kind: 'miss',
      reason: 'no_mate',
      refutation: ['5a4b'],
    });
    expect(answerStepOf(200, { status: 'miss', wrongReason: 'not_check' })).toEqual({
      kind: 'miss',
      reason: 'not_check',
      refutation: [],
    });
  });

  it('知らない理由はエラー扱い', () => {
    expect(answerStepOf(200, { status: 'miss', wrongReason: 'x' }).kind).toBe('error');
  });

  it('案内の文', () => {
    expect(missText('not_check')).toBe('王手ではありません');
    expect(missText('no_mate')).toBe('その手では詰みません');
  });
});

describe('1 手戻す（受方の応手と自分の手の 2 手ぶん）', () => {
  it('2 手戻す・先頭では戻せない', () => {
    expect(lineAfterUndoTurn(['a', 'b', 'c', 'd'])).toEqual(['a', 'b']);
    expect(lineAfterUndoTurn(['a', 'b'])).toEqual([]);
    expect(lineAfterUndoTurn([])).toBeNull();
  });
});

describe('結果の文', () => {
  it('詰み上がりの手数。最短と同じなら括弧を付けない', () => {
    expect(matePliesText(13, 7)).toBe('13 手で詰み（最短 7 手）');
    expect(matePliesText(7, 7)).toBe('7 手で詰み');
    expect(matePliesText(5, null)).toBe('5 手で詰み');
  });

  it('練習の一言は記録済みの判定で分ける', () => {
    expect(practiceNote(false, 'correct')).toBeNull();
    expect(practiceNote(true, 'wrong')).toBe('記録は不正解のままです');
    expect(practiceNote(true, 'correct')).toBe('練習のため記録していません');
  });
});

describe('attemptMoveLabel（履歴の手の欄。prd/13 §7.3）', () => {
  it('諦めの行は「（諦めた）」・除外だけの行は「—」・解答は表記', () => {
    expect(attemptMoveLabel({ verdict: 'wrong', move: null, moveText: null })).toBe('（諦めた）');
    expect(attemptMoveLabel({ verdict: null, move: null, moveText: null })).toBe('—');
    expect(attemptMoveLabel({ verdict: 'correct', move: '7g7f', moveText: '▲7六歩' })).toBe('▲7六歩');
  });
});
