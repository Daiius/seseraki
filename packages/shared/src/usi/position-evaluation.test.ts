import { describe, expect, it } from 'vitest';
import { BROWSER_ANALYSIS_LIMITS } from '../analysis-limits';
import { parseInfoLine } from './parser';
import { positionCandidatesOf, positionGoCommand, withMultiPv } from './position-evaluation';
import type { UsiSearchResult } from './types';

const result = (lines: string[], bestmove: string): UsiSearchResult => {
  const infoLines = lines.map(parseInfoLine);
  return { bestmove: { move: bestmove }, infoLines, lastInfo: infoLines.at(-1) ?? {} };
};

/** setOption を記録し、getOption で覚えた値を返すエンジン */
function fakeEngine(initial?: string) {
  const sent: string[] = [];
  const values = new Map<string, string>(initial === undefined ? [] : [['MultiPV', initial]]);
  return {
    sent,
    engine: {
      setOption: (name: string, value: string) => {
        sent.push(`${name}=${value}`);
        values.set(name, value);
      },
      getOption: (name: string) => values.get(name),
    },
  };
}

describe('withMultiPv', () => {
  it('🔴 MultiPV を自分で設定して読み、終わったら元の値へ戻す', async () => {
    const { engine, sent } = fakeEngine('1');
    const value = await withMultiPv(engine, 3, async () => {
      sent.push('(go)');
      return 'done';
    });
    expect(value).toBe('done');
    expect(sent).toEqual(['MultiPV=3', '(go)', 'MultiPV=1']);
  });

  it('覚えていなければ USI の既定（1）へ戻す', async () => {
    const { engine, sent } = fakeEngine();
    await withMultiPv({ setOption: engine.setOption }, 3, async () => {});
    expect(sent).toEqual(['MultiPV=3', 'MultiPV=1']);
  });

  it('同じ値なら setoption を送らない', async () => {
    const { engine, sent } = fakeEngine('3');
    await withMultiPv(engine, 3, async () => {});
    expect(sent).toEqual([]);
  });

  it('読みが投げても戻す', async () => {
    const { engine, sent } = fakeEngine('1');
    await expect(
      withMultiPv(engine, 3, async () => {
        throw new Error('dead');
      }),
    ).rejects.toThrow('dead');
    expect(sent).toEqual(['MultiPV=3', 'MultiPV=1']);
  });
});

describe('positionGoCommand', () => {
  it('思考時間で止める', () => {
    expect(positionGoCommand(1000)).toBe('go movetime 1000');
  });
});

describe('positionCandidatesOf', () => {
  it('候補手を rank 順に、手番側の評価値のまま取り出す', () => {
    const candidates = positionCandidatesOf(
      result(
        [
          'info depth 10 multipv 1 score cp 50 pv 7g7f 3c3d',
          'info depth 10 multipv 2 score cp 20 pv 2g2f 8c8d',
          'info depth 12 multipv 2 score cp 30 pv 2g2f 8c8d 2f2e',
          'info depth 12 multipv 1 score cp 45 pv 7g7f 3c3d 2g2f',
          'info depth 12 multipv 3 score mate -5 pv 5i5h',
        ],
        '7g7f',
      ),
      3,
    );
    expect(candidates).toEqual([
      { rank: 1, move: '7g7f', scoreType: 'cp', scoreValue: 45, depth: 12, pv: ['7g7f', '3c3d', '2g2f'] },
      { rank: 2, move: '2g2f', scoreType: 'cp', scoreValue: 30, depth: 12, pv: ['2g2f', '8c8d', '2f2e'] },
      { rank: 3, move: '5i5h', scoreType: 'mate', scoreValue: -5, depth: 12, pv: ['5i5h'] },
    ]);
  });

  it('🔒 multiPv を超える rank は捨てる（定跡の列挙の残骸）', () => {
    const candidates = positionCandidatesOf(
      result(
        [
          'info depth 10 multipv 1 score cp 50 pv 7g7f',
          'info depth 0 multipv 4 score cp 0 pv 1g1f',
        ],
        '7g7f',
      ),
      3,
    );
    expect(candidates.map((c) => c.rank)).toEqual([1]);
  });

  it('読み筋は上限で切る', () => {
    const pv = Array.from({ length: BROWSER_ANALYSIS_LIMITS.pvMaxPlies + 10 }, (_, i) =>
      i % 2 === 0 ? '5i5h' : '5a5b',
    );
    const [candidate] = positionCandidatesOf(
      result([`info depth 10 multipv 1 score cp 0 pv ${pv.join(' ')}`], '5i5h'),
      3,
      16,
    );
    expect(candidate.pv).toHaveLength(16);
  });

  it('評価が 1 本も無ければ空（詰まされている局面など）', () => {
    expect(positionCandidatesOf(result([], 'resign'), 3)).toEqual([]);
  });
});
