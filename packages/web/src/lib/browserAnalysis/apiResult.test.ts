import { describe, expect, it } from 'vitest';
import {
  chunkResultOf,
  classifyFailureStatus,
  errorReportResultOf,
  startResultOf,
} from './apiResult';

const SETTINGS = {
  movetimeMs: 100,
  stageMaxThreads: 8,
  multiPv: 1,
  hashMb: 64,
  maxThreads: 8,
  chunkIntervalMs: 5000,
  chunkMaxPositions: 32,
  pvMaxPlies: 128,
};

describe('classifyFailureStatus', () => {
  it('401 はログイン切れ・403 は続けても直らない拒否', () => {
    expect(classifyFailureStatus(401)).toBe('unauthorized');
    expect(classifyFailureStatus(403)).toBe('fatal');
  });
  it('入力の誤り（4xx）は拒否、5xx と混雑は再試行', () => {
    expect(classifyFailureStatus(400)).toBe('rejected');
    expect(classifyFailureStatus(413)).toBe('rejected');
    expect(classifyFailureStatus(408)).toBe('retry');
    expect(classifyFailureStatus(429)).toBe('retry');
    expect(classifyFailureStatus(500)).toBe('retry');
    expect(classifyFailureStatus(503)).toBe('retry');
  });
});

describe('errorReportResultOf（失敗の報告の 201 の本文）', () => {
  it('applied: true だけが記録済み。破棄（applied: false）は記録済みにしない', () => {
    expect(errorReportResultOf({ ok: true, applied: true })).toBe('recorded');
    expect(errorReportResultOf({ ok: true, applied: false })).toBe('discarded');
    expect(errorReportResultOf({ ok: true })).toBe('discarded');
    expect(errorReportResultOf(null)).toBe('discarded');
  });
});

describe('startResultOf（開始の口の応答）', () => {
  it('run は段・世代・再開位置・指し手列・設定をそのまま渡す', () => {
    expect(
      startResultOf(200, {
        status: 'run',
        revision: 3,
        profile: 'quick',
        startMoveNumber: 5,
        usiMoves: ['7g7f'],
        settings: SETTINGS,
      }),
    ).toEqual({
      kind: 'run',
      profile: 'quick',
      run: { revision: 3, startMoveNumber: 5, usiMoves: ['7g7f'], settings: SETTINGS },
    });
  });

  it('解析済み・失敗の記録あり・指し手列なしは skip、404 は棋譜が無い skip', () => {
    for (const status of ['complete', 'failed', 'unanalyzable'] as const) {
      expect(startResultOf(200, { status })).toEqual({ kind: 'skip', reason: status });
    }
    expect(startResultOf(404, undefined)).toEqual({ kind: 'skip', reason: 'not-found' });
  });

  it('409 は担当がブラウザでない・401 はログイン切れ・403 は止める', () => {
    expect(startResultOf(409, undefined)).toEqual({ kind: 'wrong-assignee' });
    expect(startResultOf(401, undefined)).toEqual({ kind: 'unauthorized' });
    expect(startResultOf(403, undefined)).toEqual({ kind: 'fatal', detail: '解析の開始を送れません (403)' });
  });

  it('🔒 開始の拒否（400）は続けても直らない（fatal）。5xx・混雑は再試行', () => {
    expect(startResultOf(400, undefined)).toEqual({ kind: 'fatal', detail: '解析を開始できません (400)' });
    expect(startResultOf(503, undefined)).toEqual({ kind: 'retry', detail: 'status 503' });
    expect(startResultOf(429, undefined)).toEqual({ kind: 'retry', detail: 'status 429' });
  });

  it('2xx でも status の無い本文は想定外として再試行する', () => {
    expect(startResultOf(200, {})).toEqual({ kind: 'retry', detail: 'unexpected response' });
    expect(startResultOf(200, undefined)).toEqual({ kind: 'retry', detail: 'unexpected response' });
  });
});

describe('chunkResultOf（チャンクの報告の応答）', () => {
  it('201 の本文の applied / completed / stageCompleted をそのまま渡す（破棄も 201）', () => {
    expect(chunkResultOf(201, { applied: true, completed: false, stageCompleted: true })).toEqual({
      kind: 'ok',
      applied: true,
      completed: false,
      stageCompleted: true,
    });
    expect(chunkResultOf(201, { applied: false, completed: false, stageCompleted: false })).toEqual({
      kind: 'ok',
      applied: false,
      completed: false,
      stageCompleted: false,
    });
  });

  it('4xx は拒否（送り直しても変わらない）・401 はログイン切れ・403 は止める・5xx は再試行', () => {
    expect(chunkResultOf(400, undefined)).toEqual({ kind: 'rejected', status: 400 });
    expect(chunkResultOf(401, undefined)).toEqual({ kind: 'unauthorized' });
    expect(chunkResultOf(403, undefined)).toEqual({ kind: 'fatal', detail: '解析結果を送れません (403)' });
    expect(chunkResultOf(500, undefined)).toEqual({ kind: 'retry', detail: 'status 500' });
  });

  it('2xx でも applied の無い本文は想定外として再試行する', () => {
    expect(chunkResultOf(201, {})).toEqual({ kind: 'retry', detail: 'unexpected response' });
  });
});
