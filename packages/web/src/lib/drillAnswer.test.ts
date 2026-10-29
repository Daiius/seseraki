import { describe, expect, it } from 'vitest';
import {
  answerBodyUnavailable,
  answerBodyWithEvaluation,
  answerStepOf,
  onEvaluate,
  attemptMoveLabel,
  lineAfterUndoTurn,
  matePliesText,
  missText,
  practiceNote,
  resultBadge,
  engineWaitFromOf,
  retriesAfterEngineReady,
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

  it('詰将棋の判定の設定（固定のスレッド数・打ち切り）もそのまま取り出す（prd/13 §5.5）', () => {
    const settings = { ...SETTINGS, movetimeMs: 1000, threads: 2, stopOnMate: true };
    expect(answerStepOf(200, { status: 'evaluate', sfen: 's', move: 'G*5b', settings })).toEqual({
      kind: 'evaluate',
      request: { sfen: 's', move: 'G*5b', settings },
    });
    expect(
      answerStepOf(200, { status: 'evaluate', sfen: 's', move: 'G*5b', settings: { ...settings, threads: '2' } }),
    ).toMatchObject({ kind: 'error' });
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

describe('resultBadge（結果の札）', () => {
  it('🔴 練習で詰ませたら「詰み」（正解とは別の見た目）', () => {
    expect(resultBadge('mate', 'correct', true)).toEqual({ label: '詰み', className: 'badge-success badge-outline' });
  });

  it('記録した詰み上がり・次の一手は判定どおり', () => {
    expect(resultBadge('mate', 'correct', false).label).toBe('正解');
    expect(resultBadge('best', 'correct', true).label).toBe('正解');
    expect(resultBadge('mate', 'wrong', true).label).toBe('不正解');
  });
});

describe('読めない旨の申告と、evaluate を受けたときにすること（prd/13 §5.5）', () => {
  const body = { line: ['G*5b'], correctMargin: 100 };

  it('申告は line と線引きを変えずに付ける', () => {
    expect(answerBodyUnavailable(body)).toEqual({ line: ['G*5b'], correctMargin: 100, browserUnavailable: true });
  });

  it('🔒 結果を付けた・申告した送り直しにまた evaluate が返ったら読み直さない（回り続けない）', () => {
    expect(onEvaluate(body)).toBe('read');
    expect(onEvaluate(answerBodyUnavailable(body))).toBe('give-up');
    expect(onEvaluate({ ...body, evaluation: {} as never })).toBe('give-up');
  });
});

describe('エンジンの準備ができたら同じ手で判定し直す（prd/13 §7.1・2026-10-29）', () => {
  it('同意の前・止まっていた・起動の途中から、使える状態へ移ったら true', () => {
    expect(retriesAfterEngineReady('needs-consent', 'loading')).toBe(true);
    expect(retriesAfterEngineReady('needs-consent', 'idle')).toBe(true);
    expect(retriesAfterEngineReady('error', 'analyzing')).toBe(true);
    expect(retriesAfterEngineReady('off', 'idle')).toBe(true);
  });

  it('まだ使えない間は false', () => {
    expect(retriesAfterEngineReady('needs-consent', 'needs-consent')).toBe(false);
    expect(retriesAfterEngineReady('needs-consent', 'off')).toBe(false);
    expect(retriesAfterEngineReady('unsupported', 'unsupported')).toBe(false);
  });

  it('🔒 使える状態のまま採点できなかったなら、状態が動いても判定し直さない（回り続けない）', () => {
    expect(retriesAfterEngineReady('idle', 'analyzing')).toBe(false);
    expect(retriesAfterEngineReady('analyzing', 'idle')).toBe(false);
  });
});

describe('engineWaitFromOf（判定し直しの基準の状態。レビュー OCL-239BA9E5）', () => {
  it('エンジンを使えないときは、その結果が返った時点の状態を基準にする', () => {
    expect(engineWaitFromOf({ kind: 'unavailable', reason: 'needs-consent' }, 'needs-consent')).toBe('needs-consent');
  });

  it('読みの失敗・噛み合わないときは待たない', () => {
    expect(engineWaitFromOf({ kind: 'failed', detail: 'x' }, 'idle')).toBeNull();
    expect(engineWaitFromOf({ kind: 'mismatch', returned: '7g7f' }, 'idle')).toBeNull();
  });

  it('🔴 申告して送り直す間に同意されても、読めなかった時点の状態を基準に一度だけ判定し直せる', () => {
    // 同意の前に読めず（needs-consent）、server の応答を待つ間に同意してダウンロードが始まった（loading）
    const from = engineWaitFromOf({ kind: 'unavailable', reason: 'needs-consent' }, 'needs-consent');
    expect(from).not.toBeNull();
    expect(retriesAfterEngineReady(from!, 'loading')).toBe(true);
    // 諦めた時点の状態（loading）を基準にすると、その後ずっと判定し直さない（直す前の振る舞い）
    expect(retriesAfterEngineReady('loading', 'idle')).toBe(false);
  });
});
