// 解析の担当とブラウザ解析の判定（`analysis-report.ts` の純粋な部分。DB 無し）。
// DB を通した振る舞い（行ロック・世代・RLS）は `analysis-assignee.db.test.ts`。
import { BROWSER_ANALYSIS_LIMITS } from 'shared';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_ANALYSIS_SETTINGS,
  canChooseWorker,
  classifyForSwitch,
  needsRestart,
} from './analysis-report.js';
import { clearProgressForOwner, getClearToken, getProgress, resetProgress, setProgress } from './analysis-progress.js';
import { mergeChunk, runExtras, EMPTY_ANALYSIS, type AnalysisRun } from './kifu-analysis-detail.js';

const DONE = new Date('2026-10-14T00:00:00Z');

describe('classifyForSwitch（担当の切り替えで棋譜の解析をどうするか。prd/14 §5.7 規則 1）', () => {
  it('初めての完了の前は消す（quick の途中・未着手・失敗して止まったもの）', () => {
    expect(classifyForSwitch({ completedAt: null, analysisProfile: null, hasFull: false })).toBe('reset');
    // quick を持たない worker の full の途中（完了の印は無く、full だけが入っている）
    expect(classifyForSwitch({ completedAt: null, analysisProfile: null, hasFull: true })).toBe('reset');
  });

  it('🔴 quick は完了し full が途中まで入っている棋譜も消す（full の途中ぶんだけは取り除けない）', () => {
    expect(classifyForSwitch({ completedAt: DONE, analysisProfile: 'quick', hasFull: true })).toBe('reset');
  });

  it('quick が完了して full が 1 局面も入っていない棋譜は、行を残して世代だけ進める', () => {
    expect(classifyForSwitch({ completedAt: DONE, analysisProfile: 'quick', hasFull: false })).toBe('bump');
    // 段階の記録が無い完了済み（移行前の取りこぼし）は quick 完了と読む
    expect(classifyForSwitch({ completedAt: DONE, analysisProfile: null, hasFull: false })).toBe('bump');
  });

  it('🔒 full まで完了した棋譜には触れない（完了済みは不変）', () => {
    expect(classifyForSwitch({ completedAt: DONE, analysisProfile: 'full', hasFull: true })).toBe('keep');
  });
});

describe('needsRestart（途中の解析をやり直すか。prd/14 §5.9）', () => {
  const engine = { engineBuild: 'c1b80eaa-0123456789ab', evalHash: 'a'.repeat(64) };

  it('来歴がすべて同じビルド・評価関数なら続きから', () => {
    expect(needsRestart([engine, { ...engine }], engine)).toBe(false);
  });

  it('まだ何も入っていなければやり直さない', () => {
    expect(needsRestart([], engine)).toBe(false);
  });

  it('ビルドか評価関数のどちらかが違えばやり直す（1 つでも混ざっていれば）', () => {
    expect(needsRestart([engine, { ...engine, engineBuild: 'deadbeef-0123456789ab' }], engine)).toBe(true);
    expect(needsRestart([{ ...engine, evalHash: 'b'.repeat(64) }], engine)).toBe(true);
  });

  it('項目を持たない来歴（手元 worker・項目を足す前の解析）は「違う」に数える', () => {
    expect(needsRestart([{}], engine)).toBe(true);
    expect(needsRestart([engine, { engineBuild: engine.engineBuild }], engine)).toBe(true);
  });
});

describe('canChooseWorker', () => {
  it('🔒 worker を選べるのは所有者だけ', () => {
    expect(canChooseWorker('1')).toBe(true);
    expect(canChooseWorker('2')).toBe(false);
    expect(canChooseWorker('7d0c0a52-6c5c-4d5c-9d0a-0a4f0d3f3a11')).toBe(false);
  });
});

describe('BROWSER_ANALYSIS_SETTINGS（開始の口が返す設定）', () => {
  it('server の検証の上限と同じ値を返す（web はこれで切って送る）', () => {
    expect(BROWSER_ANALYSIS_SETTINGS.chunkMaxPositions).toBe(BROWSER_ANALYSIS_LIMITS.chunkMaxPositions);
    expect(BROWSER_ANALYSIS_SETTINGS.pvMaxPlies).toBe(BROWSER_ANALYSIS_LIMITS.pvMaxPlies);
    expect(BROWSER_ANALYSIS_SETTINGS.multiPv).toBe(BROWSER_ANALYSIS_LIMITS.maxCandidates);
  });
});

describe('runExtras（来歴の任意の項目。prd/16 §3.1）', () => {
  it('値があるものだけを残す（古い worker の null / 省略はキーごと落とす）', () => {
    expect(runExtras({})).toEqual({});
    expect(runExtras({ runtime: null, engineBuild: undefined, book: null })).toEqual({});
    expect(runExtras({ runtime: 'native', threads: 8, book: false })).toEqual({
      runtime: 'native',
      threads: 8,
      book: false,
    });
  });

  it('項目つきの run と項目なしの run が 1 つの解析に並べる（既存の行はそのまま読める）', () => {
    const base = { engineName: null, movetimeMs: null, targetDepth: null, multiPv: 1 };
    const old: AnalysisRun = { ...base, profile: 'quick', at: '2026-10-01T00:00:00.000Z' };
    const wasm: AnalysisRun = {
      ...base,
      profile: 'quick',
      at: '2026-10-14T00:00:00.000Z',
      ...runExtras({ runtime: 'wasm', engineBuild: 'a-b', evalHash: 'c'.repeat(64), fvScale: 16 }),
    };
    const first = mergeChunk(EMPTY_ANALYSIS, [{ moveNumber: 0, candidates: [] }], old);
    if (!first.ok) throw new Error('重ねられるはず');
    const second = mergeChunk(first.next, [{ moveNumber: 1, candidates: [] }], wasm);
    if (!second.ok) throw new Error('重ねられるはず');
    expect(second.next.runs).toEqual([old, wasm]);
    expect(second.next.runs[0]).not.toHaveProperty('runtime');
  });
});

describe('clearProgressForOwner（担当の切り替え）', () => {
  const progress = (ownerId: string) => ({
    kifuId: 1,
    kifuNo: 10,
    ownerId,
    revision: 0,
    profile: 'full' as const,
    analyzed: 3,
    total: 71,
  });

  it('そのユーザーの「解析中」だけを落とす', () => {
    resetProgress();
    setProgress(progress('a'), getClearToken());
    clearProgressForOwner('b');
    expect(getProgress()).not.toBeNull();
    clearProgressForOwner('a');
    expect(getProgress()).toBeNull();
  });

  it('トークンを進める（切り替えの前に検証を始めた進捗報告を弾く）', () => {
    resetProgress();
    const token = getClearToken();
    clearProgressForOwner('a');
    expect(setProgress(progress('a'), token)).toBe(false);
    expect(getProgress()).toBeNull();
  });
});
