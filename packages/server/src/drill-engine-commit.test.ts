/**
 * 別解の手順の記憶（メモリ）は**コミットの後**に書く（`resolveWithEngine` の `afterCommit`）。
 * DB には繋がない。棋譜解析の再利用は「無い」に差し替える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPositions } from 'shared';
import { resolveWithEngine, type ResolveInput } from './drill-engine';
import { recallLine, resetLines } from './drill-lines';

vi.mock('./position-kifu-reuse.js', () => ({ lookupKifuEvaluation: async () => null }));

beforeEach(() => resetLines());

function input(afterCommit: (fn: () => void) => void): ResolveInput {
  const state = buildPositions(['7g7f', '3c3d'])[2];
  return {
    tx: {} as ResolveInput['tx'],
    userId: 'u1',
    afterCommit,
    assignee: 'browser',
    // ブラウザが読んだ結果: 8h3c で 3 手詰め（別解）
    browserEvaluation: { candidate: { scoreType: 'mate', scoreValue: 3, pv: ['8h3c', '4a4b', '3c4b'] } },
    drill: {
      id: 11,
      ownerId: 'u1',
      kind: 'mate',
      answerMove: '2g2f',
      answerScoreType: 'mate',
      answerScoreValue: 3,
      answerPv: ['2g2f'],
      candidates: [],
    },
    state,
    move: '8h3c',
    line: ['8h3c'],
    scoring: { correctMargin: 100, closeMargin: 300 },
  };
}

describe('resolveWithEngine: 別解の手順の記憶', () => {
  it('コミットの後に覚える（コミット前には覚えていない）', async () => {
    const pending: (() => void)[] = [];
    const answer = await resolveWithEngine(input((fn) => pending.push(fn)));
    expect(answer).toEqual({ status: 'continue', reply: '4a4b' });
    expect(recallLine(11)).toBeNull();
    for (const fn of pending) fn();
    expect(recallLine(11)).toEqual(['8h3c', '4a4b', '3c4b']);
  });

  it('コミットされなければ（後始末が回らなければ）覚えない', async () => {
    await resolveWithEngine(input(() => {}));
    expect(recallLine(11)).toBeNull();
  });
});
